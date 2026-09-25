-- Entrada corrections. Additive only; calc_runs is intentionally untouched.

alter table public.import_jobs add column if not exists chat_id uuid;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.import_jobs'::regclass
      and conname = 'import_jobs_chat_id_fkey'
  ) then
    alter table public.import_jobs add constraint import_jobs_chat_id_fkey
      foreign key (chat_id) references public.chats(id) not valid;
  end if;
end $$;

update public.import_jobs j
set chat_id = inferred.chat_id
from (
  select import_job_id, min(chat_id::text)::uuid as chat_id
  from public.messages
  where import_job_id is not null
  group by import_job_id
  having count(distinct chat_id) = 1
) inferred
where j.id = inferred.import_job_id and j.chat_id is null;

create index if not exists import_jobs_environment_chat_created_idx
  on public.import_jobs(environment, chat_id, created_at desc)
  where chat_id is not null;

create table if not exists public.chat_sender_aliases (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  chat_id uuid not null references public.chats(id),
  sender_text text not null,
  sender_normalized text not null,
  direction public.panel_message_direction not null,
  confirmed_at timestamptz not null default now(),
  confirmed_by uuid not null references public.panel_users(id),
  created_at timestamptz not null default now(),
  unique(environment, chat_id, sender_normalized),
  check (direction in ('CUSTOMER', 'MCS'))
);

create index if not exists chat_sender_aliases_environment_chat_idx
  on public.chat_sender_aliases(environment, chat_id, sender_normalized);

alter table public.chat_sender_aliases enable row level security;
alter table public.chat_sender_aliases force row level security;
grant select on table public.chat_sender_aliases to authenticated;
grant all on table public.chat_sender_aliases to service_role;
revoke insert, update, delete on table public.chat_sender_aliases from anon, authenticated;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'chat_sender_aliases'
      and policyname = 'panel_chat_sender_aliases_select_authorized'
  ) then
    create policy panel_chat_sender_aliases_select_authorized
      on public.chat_sender_aliases for select to authenticated
      using ((select private.panel_authorized(environment)));
  end if;
end $$;

-- Reconcile only the occurrences actually present in this batch. This avoids
-- manufacturing later occurrences from the first sample while retaining the
-- file-wide max(0, k-m) rule and the per-signature transaction lock.
create or replace function public.panel_reconcile_import_batch(
  p_environment public.panel_environment,
  p_import_job_id uuid,
  p_batch_number integer,
  p_payload_sha256 text,
  p_messages jsonb
)
returns table(inserted_count integer, already_present_count integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.import_jobs%rowtype;
  v_batch public.import_batches%rowtype;
  v_group record;
  v_item jsonb;
  v_existing integer;
  v_needed integer;
  v_batch_count integer;
  v_inserted integer := 0;
  v_present integer := 0;
  v_index integer;
begin
  if jsonb_typeof(p_messages) <> 'array'
     or jsonb_array_length(p_messages) < 1
     or jsonb_array_length(p_messages) > 500 then
    raise exception 'PANEL_IMPORT_BATCH_INVALID';
  end if;
  if coalesce(length(p_payload_sha256), 0) < 32 then
    raise exception 'PANEL_IMPORT_PAYLOAD_INVALID';
  end if;

  select * into v_job from public.import_jobs
  where id = p_import_job_id and environment = p_environment for update;
  if not found or v_job.chat_id is null then
    raise exception 'PANEL_IMPORT_JOB_NOT_FOUND';
  end if;

  insert into public.import_batches (
    environment, import_job_id, batch_number, payload_sha256, message_count,
    status, received_at
  ) values (
    p_environment, p_import_job_id, p_batch_number, p_payload_sha256,
    jsonb_array_length(p_messages), 'PROCESSING', now()
  ) on conflict (environment, import_job_id, batch_number) do nothing;

  select * into v_batch from public.import_batches
  where environment = p_environment and import_job_id = p_import_job_id
    and batch_number = p_batch_number for update;
  if v_batch.payload_sha256 <> p_payload_sha256 then
    raise exception 'PANEL_IMPORT_BATCH_CONFLICT';
  end if;
  if v_batch.status = 'COMPLETED' then
    return query select 0, v_batch.message_count;
    return;
  end if;

  for v_group in
    select item->>'signature_base' as signature_base,
      max(coalesce(nullif(item->>'file_occurrence_total', '')::integer, 1)) as file_total,
      jsonb_agg(item order by coalesce(nullif(item->>'original_order', '')::integer, 0)) as samples
    from jsonb_array_elements(p_messages) payload(item)
    group by item->>'signature_base'
  loop
    if coalesce(v_group.signature_base, '') = '' or v_group.file_total < 1 then
      raise exception 'PANEL_IMPORT_MESSAGE_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':' || v_group.signature_base, 0));
    select count(*) into v_existing from public.messages
    where environment = p_environment and signature_base = v_group.signature_base;
    v_batch_count := jsonb_array_length(v_group.samples);
    v_present := v_present + least(v_batch_count, greatest(0, v_existing));
    v_needed := least(v_batch_count, greatest(0, v_group.file_total - v_existing));

    if v_needed > 0 then
      for v_index in 0..(v_needed - 1) loop
        v_item := v_group.samples->v_index;
        if (v_item->>'chat_id')::uuid <> v_job.chat_id or not exists (
          select 1 from public.chats c
          where c.id = v_job.chat_id and c.environment = p_environment
        ) then
          raise exception 'PANEL_IMPORT_CHAT_NOT_FOUND';
        end if;
        insert into public.messages (
          environment, chat_id, channel, direction, body_text, body_normalized,
          occurred_at_local, timezone_assumed, occurred_at_utc, time_uncertain,
          original_datetime_text, original_order, signature_base, occurrence_index,
          import_job_id, source_kind, is_edit_marker, is_delete_marker, created_at
        ) values (
          p_environment, v_job.chat_id,
          (v_item->>'channel')::public.panel_channel,
          (v_item->>'direction')::public.panel_message_direction,
          v_item->>'body_text', v_item->>'body_normalized',
          nullif(v_item->>'occurred_at_local', '')::timestamp,
          nullif(v_item->>'timezone_assumed', ''),
          nullif(v_item->>'occurred_at_utc', '')::timestamptz,
          coalesce((v_item->>'time_uncertain')::boolean, false),
          nullif(v_item->>'original_datetime_text', ''),
          nullif(v_item->>'original_order', '')::integer,
          v_group.signature_base, v_existing + v_index + 1,
          p_import_job_id, coalesce(nullif(v_item->>'source_kind', ''), 'IMPORT'),
          coalesce((v_item->>'is_edit_marker')::boolean, false),
          coalesce((v_item->>'is_delete_marker')::boolean, false), now()
        );
      end loop;
      v_inserted := v_inserted + v_needed;
    end if;
  end loop;

  update public.import_batches set status='COMPLETED', completed_at=now(), error_text=null
  where id=v_batch.id;
  update public.import_jobs set status='PROCESSING', message_count=message_count+v_inserted
  where id=p_import_job_id;
  return query select v_inserted, v_present;
end;
$$;

revoke all on function public.panel_reconcile_import_batch(
  public.panel_environment, uuid, integer, text, jsonb
) from public, anon, authenticated;
grant execute on function public.panel_reconcile_import_batch(
  public.panel_environment, uuid, integer, text, jsonb
) to service_role;

create or replace function public.panel_last_import_counts(
  p_environment public.panel_environment
)
returns table(chat_id uuid, latest_job_id uuid, inserted_count integer, has_time_uncertain boolean)
language sql
security definer
set search_path = public, pg_temp
as $$
  with latest as (
    select distinct on (j.chat_id) j.id, j.chat_id, j.message_count
    from public.import_jobs j
    where j.environment=p_environment and j.chat_id is not null
    order by j.chat_id, j.created_at desc, j.id desc
  )
  select l.chat_id, l.id, l.message_count,
    exists (
      select 1 from public.messages m
      where m.environment=p_environment and m.import_job_id=l.id and m.time_uncertain
    )
  from latest l;
$$;

revoke all on function public.panel_last_import_counts(public.panel_environment)
  from public, anon, authenticated;
grant execute on function public.panel_last_import_counts(public.panel_environment)
  to service_role;

create or replace function public.panel_finalize_import_resolution(
  p_environment public.panel_environment,
  p_import_job_id uuid,
  p_contact_id uuid,
  p_journey_id uuid,
  p_create_new boolean,
  p_refs text[],
  p_actor_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job public.import_jobs%rowtype;
  v_chat public.chats%rowtype;
  v_journey_id uuid;
  v_ref text;
  v_source public.panel_journey_source;
  v_message_id uuid;
  v_labels text[] := array[
    'Carro ou faixa de valor definido',
    'Teto confirmado pelo cliente depois da conversa',
    'Forma de pagamento', 'Prazo',
    'Aceita carro fora da Flórida com custo de transporte',
    'Entendeu o modelo sem test drive e sem devolução'
  ];
  v_point integer;
begin
  if not exists (
    select 1 from public.panel_users pu
    where pu.id=p_actor_id and pu.environment=p_environment and pu.active
  ) then raise exception 'PANEL_ACTOR_NOT_AUTHORIZED'; end if;

  select * into v_job from public.import_jobs
  where id=p_import_job_id and environment=p_environment for update;
  if not found or v_job.chat_id is null then raise exception 'PANEL_IMPORT_JOB_NOT_FOUND'; end if;
  select * into v_chat from public.chats
  where id=v_job.chat_id and environment=p_environment for update;
  if not found or v_chat.is_group or v_chat.resolution_status='GROUP' then
    raise exception 'PANEL_GROUP_HAS_NO_JOURNEY';
  end if;
  if v_chat.contact_id is distinct from p_contact_id then
    raise exception 'PANEL_CONTACT_MISMATCH';
  end if;

  if p_create_new then
    v_source := case when v_job.channel='SMS' then 'SMS_DIRECT'::public.panel_journey_source else 'WHATSAPP_DIRECT'::public.panel_journey_source end;
    insert into public.journeys (
      environment, contact_id, source, stage, status, criteria_json,
      stage_frozen, created_at, updated_at, created_by, updated_by
    ) values (
      p_environment, p_contact_id, v_source, 'NOVO', 'ATIVO', '{}',
      false, now(), now(), p_actor_id, p_actor_id
    ) returning id into v_journey_id;
    for v_point in 1..6 loop
      insert into public.journey_checklist (
        environment, journey_id, point_number, point_label, status, created_at, updated_at
      ) values (p_environment, v_journey_id, v_point, v_labels[v_point], 'OPEN', now(), now());
    end loop;
    insert into public.activity_log(environment, journey_id, contact_id, chat_id, activity_type, summary, metadata, occurred_at, actor_user_id)
      values (p_environment, v_journey_id, p_contact_id, v_chat.id, 'JOURNEY_CREATED_FROM_ENTRY', 'Jornada criada pela resolução da entrada', '{}', now(), p_actor_id);
    insert into public.audit_log(environment, actor_user_id, entity_type, entity_id, action, after_json)
      values (p_environment, p_actor_id, 'journey', v_journey_id, 'CREATE_FROM_ENTRY', jsonb_build_object('source', v_source));
  else
    select j.id into v_journey_id from public.journeys j
    where j.id=p_journey_id and j.environment=p_environment and j.contact_id=p_contact_id
      and j.status <> 'ENCERRADO' and j.stage <> 'QUALIFICADO' and not j.stage_frozen
    for update;
    if not found then raise exception 'PANEL_ACTIVE_JOURNEY_NOT_FOUND'; end if;
  end if;

  insert into public.message_journeys(environment, message_id, journey_id, association_source, associated_at, associated_by)
    select p_environment, m.id, v_journey_id, 'ENTRY_CONFIRMED', now(), p_actor_id
    from public.messages m
    where m.environment=p_environment and m.import_job_id=p_import_job_id and not m.time_uncertain
    on conflict (environment, message_id, journey_id) do nothing;

  foreach v_ref in array coalesce(p_refs, array[]::text[]) loop
    v_ref := upper(trim(v_ref));
    if v_ref !~ '^[A-HJ-NP-Z2-9]{5}$' then raise exception 'PANEL_REF_INVALID'; end if;
    select m.id into v_message_id from public.messages m
      where m.environment=p_environment and m.import_job_id=p_import_job_id
        and m.body_text ~* ('Ref\\s*:\\s*' || v_ref || '\\M')
      order by m.original_order limit 1;
    if not exists (
      select 1 from public.journey_refs r
      where r.environment=p_environment and r.journey_id=v_journey_id
        and r.ref_code=v_ref and r.calculator_sid is null
    ) then
      insert into public.journey_refs(environment, journey_id, ref_code, source_message_id, calculator_sid, created_at, created_by)
        values (p_environment, v_journey_id, v_ref, v_message_id, null, now(), p_actor_id);
    end if;
  end loop;

  insert into public.activity_log(environment, journey_id, contact_id, chat_id, activity_type, summary, metadata, occurred_at, actor_user_id)
    values (p_environment, v_journey_id, p_contact_id, v_chat.id, 'IMPORT_ASSOCIATED', 'Importação associada à jornada', jsonb_build_object('import_job_id', p_import_job_id), now(), p_actor_id);
  return v_journey_id;
end;
$$;

revoke all on function public.panel_finalize_import_resolution(
  public.panel_environment, uuid, uuid, uuid, boolean, text[], uuid
) from public, anon, authenticated;
grant execute on function public.panel_finalize_import_resolution(
  public.panel_environment, uuid, uuid, uuid, boolean, text[], uuid
) to service_role;

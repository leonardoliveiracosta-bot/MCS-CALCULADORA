-- Entrada import reconciliation. Additive only; never changes calc_runs.
-- The RPC owns occurrence_index assignment and serializes each signature with
-- an advisory transaction lock, so concurrent retries remain additive.
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
  v_row record;
  v_existing integer;
  v_to_insert integer;
  v_inserted integer := 0;
  v_present integer := 0;
begin
  if jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) > 500 then
    raise exception 'PANEL_IMPORT_BATCH_INVALID';
  end if;
  if coalesce(length(p_payload_sha256), 0) < 32 then
    raise exception 'PANEL_IMPORT_PAYLOAD_INVALID';
  end if;

  select * into v_job
  from public.import_jobs
  where id = p_import_job_id and environment = p_environment
  for update;
  if not found then
    raise exception 'PANEL_IMPORT_JOB_NOT_FOUND';
  end if;

  insert into public.import_batches (
    environment, import_job_id, batch_number, payload_sha256, message_count,
    status, received_at
  ) values (
    p_environment, p_import_job_id, p_batch_number, p_payload_sha256,
    jsonb_array_length(p_messages), 'PROCESSING', now()
  )
  on conflict (environment, import_job_id, batch_number) do nothing;

  select * into v_batch
  from public.import_batches
  where environment = p_environment
    and import_job_id = p_import_job_id
    and batch_number = p_batch_number
  for update;
  if v_batch.payload_sha256 <> p_payload_sha256 then
    raise exception 'PANEL_IMPORT_BATCH_CONFLICT';
  end if;
  if v_batch.status = 'COMPLETED' then
    return query select 0, v_batch.message_count;
    return;
  end if;

  -- One representative JSON object is sufficient per signature: the
  -- signature includes canonical chat, normalized timestamp, direction and text.
  for v_row in
    select
      item->>'signature_base' as signature_base,
      max(coalesce(nullif(item->>'file_occurrence_total', '')::integer, 1)) as file_occurrence_total,
      (array_agg(item order by coalesce(nullif(item->>'original_order', '')::integer, 0)))[1] as sample
    from jsonb_array_elements(p_messages) as payload(item)
    group by item->>'signature_base'
  loop
    if coalesce(v_row.signature_base, '') = '' or v_row.file_occurrence_total < 1 then
      raise exception 'PANEL_IMPORT_MESSAGE_INVALID';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_environment::text || ':' || v_row.signature_base, 0));

    if not exists (
      select 1 from public.chats c
      where c.id = (v_row.sample->>'chat_id')::uuid and c.environment = p_environment
    ) then
      raise exception 'PANEL_IMPORT_CHAT_NOT_FOUND';
    end if;

    select count(*) into v_existing
    from public.messages
    where environment = p_environment and signature_base = v_row.signature_base;
    v_present := v_present + least(v_existing, v_row.file_occurrence_total);
    v_to_insert := greatest(0, v_row.file_occurrence_total - v_existing);

    if v_to_insert > 0 then
      insert into public.messages (
        environment, chat_id, channel, direction, body_text, body_normalized,
        occurred_at_local, timezone_assumed, occurred_at_utc, time_uncertain,
        original_datetime_text, original_order, signature_base, occurrence_index,
        import_job_id, source_kind, is_edit_marker, is_delete_marker, created_at
      )
      select
        p_environment,
        (v_row.sample->>'chat_id')::uuid,
        (v_row.sample->>'channel')::public.panel_channel,
        (v_row.sample->>'direction')::public.panel_message_direction,
        v_row.sample->>'body_text',
        v_row.sample->>'body_normalized',
        nullif(v_row.sample->>'occurred_at_local', '')::timestamp,
        nullif(v_row.sample->>'timezone_assumed', ''),
        nullif(v_row.sample->>'occurred_at_utc', '')::timestamptz,
        coalesce((v_row.sample->>'time_uncertain')::boolean, false),
        nullif(v_row.sample->>'original_datetime_text', ''),
        nullif(v_row.sample->>'original_order', '')::integer,
        v_row.signature_base,
        v_existing + series.n,
        p_import_job_id,
        coalesce(nullif(v_row.sample->>'source_kind', ''), 'IMPORT'),
        coalesce((v_row.sample->>'is_edit_marker')::boolean, false),
        coalesce((v_row.sample->>'is_delete_marker')::boolean, false),
        now()
      from generate_series(1, v_to_insert) as series(n);
      v_inserted := v_inserted + v_to_insert;
    end if;
  end loop;

  update public.import_batches
  set status = 'COMPLETED', completed_at = now(), error_text = null
  where id = v_batch.id;
  update public.import_jobs
  set status = 'PROCESSING', message_count = message_count + v_inserted
  where id = p_import_job_id;

  return query select v_inserted, v_present;
end;
$$;

revoke all on function public.panel_reconcile_import_batch(
  public.panel_environment, uuid, integer, text, jsonb
) from public, anon, authenticated;
grant execute on function public.panel_reconcile_import_batch(
  public.panel_environment, uuid, integer, text, jsonb
) to service_role;

-- Assistente do painel: chamados ("Não funcionou") e o histórico do que o assistente propôs e a
-- Leo autorizou ou recusou.
--  * panel_incidents: um chamado por defeito (fingerprint = tela + botão + tipo de erro). O mesmo
--    defeito soma no chamado aberto; um chamado CORRIGIDO reabre quando o defeito volta; um
--    chamado NAO_ERA_DEFEITO não volta a contar (um novo relato abre outro).
--  * panel_assistant_events: pergunta, proposta, autorizada, recusada, chamado, erro.
-- Nenhum dado existente muda.

create table if not exists public.panel_incidents (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  fingerprint text not null check (length(fingerprint) between 3 and 300),
  severity text not null check (severity in ('P0','P1','P2')),
  status text not null default 'ABERTO' check (status in ('ABERTO','EM_CORRECAO','CORRIGIDO','NAO_ERA_DEFEITO')),
  count integer not null default 1,
  reopened_count integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_version text,
  context jsonb not null default '{}'::jsonb,
  diagnosis jsonb not null default '{}'::jsonb,
  pr_url text,
  created_by uuid references public.panel_users(id),
  updated_at timestamptz not null default now()
);
create index if not exists panel_incidents_fingerprint_idx on public.panel_incidents(environment, fingerprint, last_seen_at desc);
create index if not exists panel_incidents_status_idx on public.panel_incidents(environment, status, last_seen_at desc);

create table if not exists public.panel_assistant_events (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  created_at timestamptz not null default now(),
  created_by uuid references public.panel_users(id),
  incident_id uuid references public.panel_incidents(id),
  event_type text not null check (event_type in ('PERGUNTA','PROPOSTA','AUTORIZADA','RECUSADA','CHAMADO','ERRO')),
  action text,
  payload jsonb not null default '{}'::jsonb,
  cost_usd numeric
);
create index if not exists panel_assistant_events_created_idx on public.panel_assistant_events(environment, created_at desc);
create index if not exists panel_assistant_events_incident_idx on public.panel_assistant_events(incident_id);

alter table public.panel_incidents enable row level security;
alter table public.panel_incidents force row level security;
alter table public.panel_assistant_events enable row level security;
alter table public.panel_assistant_events force row level security;
revoke all on table public.panel_incidents, public.panel_assistant_events from public, anon, authenticated;
grant select, insert, update on table public.panel_incidents, public.panel_assistant_events to service_role;

-- Registra um relato: soma no chamado aberto do mesmo defeito, reabre o CORRIGIDO ou abre um novo.
create or replace function public.panel_incident_report(
  p_environment public.panel_environment, p_actor_id uuid, p_fingerprint text, p_severity text,
  p_version text, p_context jsonb, p_diagnosis jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_row public.panel_incidents%rowtype;
  v_reopened boolean := false;
begin
  if coalesce(length(p_fingerprint), 0) not between 3 and 300 or p_severity not in ('P0','P1','P2') then raise exception 'INCIDENT_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('panel_incident:' || p_environment::text || ':' || p_fingerprint, 0));
  select * into v_row from public.panel_incidents i
   where i.environment = p_environment and i.fingerprint = p_fingerprint and i.status <> 'NAO_ERA_DEFEITO'
   order by i.last_seen_at desc limit 1 for update;
  if found then
    v_reopened := v_row.status = 'CORRIGIDO';
    update public.panel_incidents set
      count = count + 1, last_seen_at = now(), updated_at = now(), last_version = left(p_version, 80),
      status = case when status = 'CORRIGIDO' then 'ABERTO' else status end,
      reopened_count = reopened_count + case when status = 'CORRIGIDO' then 1 else 0 end,
      severity = least(severity, p_severity),
      context = coalesce(p_context, '{}'::jsonb), diagnosis = coalesce(p_diagnosis, '{}'::jsonb)
     where id = v_row.id returning * into v_row;
  else
    insert into public.panel_incidents(environment, fingerprint, severity, last_version, context, diagnosis, created_by)
    values (p_environment, p_fingerprint, p_severity, left(p_version, 80), coalesce(p_context, '{}'::jsonb), coalesce(p_diagnosis, '{}'::jsonb), p_actor_id)
    returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'status', v_row.status, 'count', v_row.count, 'severity', v_row.severity, 'reopened', v_reopened);
end $$;
revoke all on function public.panel_incident_report(public.panel_environment, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.panel_incident_report(public.panel_environment, uuid, text, text, text, jsonb, jsonb) to service_role;

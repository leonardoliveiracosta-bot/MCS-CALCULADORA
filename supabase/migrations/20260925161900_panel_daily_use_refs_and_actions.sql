-- Daily-use panel: one operational Ref for every journey and payment evidence.
-- Additive and idempotent; calc_runs is intentionally untouched.

alter table public.journeys add column if not exists reference_code char(5);

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.journeys'::regclass
      and conname = 'journeys_reference_code_format'
  ) then
    alter table public.journeys add constraint journeys_reference_code_format
      check (reference_code is null or reference_code ~ '^[A-HJ-NP-Z2-9]{5}$') not valid;
  end if;
end $$;

create unique index if not exists journeys_environment_reference_code_uidx
  on public.journeys(environment, reference_code)
  where reference_code is not null;

create or replace function private.panel_new_reference(p_environment public.panel_environment)
returns char(5)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_candidate text;
  v_attempt integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('panel-ref:' || p_environment::text, 0));
  for v_attempt in 1..100 loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::integer, 1), '')
      into v_candidate from generate_series(1, 5);
    if not exists (
      select 1 from public.journeys
      where environment = p_environment and reference_code = v_candidate
    ) and not exists (
      select 1 from public.journey_refs
      where environment = p_environment and ref_code = v_candidate
    ) then
      return v_candidate::char(5);
    end if;
  end loop;
  raise exception 'PANEL_REFERENCE_EXHAUSTED';
end;
$$;

revoke all on function private.panel_new_reference(public.panel_environment)
  from public, anon, authenticated;

create or replace function private.panel_assign_journey_reference()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.reference_code is null then
    new.reference_code := private.panel_new_reference(new.environment);
  end if;
  return new;
end;
$$;

revoke all on function private.panel_assign_journey_reference()
  from public, anon, authenticated;

drop trigger if exists panel_assign_journey_reference on public.journeys;
create trigger panel_assign_journey_reference
before insert on public.journeys
for each row execute function private.panel_assign_journey_reference();

-- Existing Preview journeys receive an operational Ref. Production data is not backfilled.
do $$
declare
  v_id uuid;
begin
  for v_id in
    select id from public.journeys
    where environment = 'preview' and reference_code is null
    order by created_at, id
  loop
    update public.journeys
      set reference_code = private.panel_new_reference('preview')
      where id = v_id and environment = 'preview' and reference_code is null;
  end loop;
end $$;

alter table public.journeys validate constraint journeys_reference_code_format;

alter type public.panel_declaration_field add value if not exists 'PAGAMENTO';

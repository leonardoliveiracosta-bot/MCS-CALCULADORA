-- Lead detail, private notes, customer tracking and Manheim history.
create table if not exists public.lead_tracking (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  ref_code char(5) not null,
  journey_id uuid references public.journeys(id),
  public_code text not null unique check (length(public_code) >= 22),
  step smallint not null default 1 check (step between 1 and 4),
  result text check (result is null or result in ('WON','NOT_WON')),
  updated_at timestamptz not null default now(),
  unique(environment, ref_code)
);

create table if not exists public.lead_notes (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  ref_code char(5) not null,
  journey_id uuid references public.journeys(id),
  body_text text not null check (length(body_text) between 1 and 12000),
  distributed_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  created_by uuid not null references public.panel_users(id)
);

create table if not exists public.lead_events (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  ref_code char(5) not null,
  journey_id uuid references public.journeys(id),
  event_type text not null,
  unit_id uuid references public.units(id),
  detail_json jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  undone_at timestamptz,
  created_by uuid references public.panel_users(id)
);

create table if not exists public.lead_promises (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  ref_code char(5) not null,
  journey_id uuid references public.journeys(id),
  promise_text text not null,
  due_at timestamptz not null,
  status text not null default 'OPEN' check (status in ('OPEN','FULFILLED','CANCELLED')),
  created_at timestamptz not null default now(),
  created_by uuid not null references public.panel_users(id)
);

create table if not exists public.manheim_vehicles (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  row_fingerprint text not null,
  vehicle_json jsonb not null,
  uploaded_at timestamptz not null default now(),
  unique(environment, upload_id, row_fingerprint)
);

create table if not exists public.manheim_saved_searches (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  search_key text not null,
  created boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.panel_users(id),
  unique(environment, search_key)
);

create index if not exists lead_events_ref_occurred_idx on public.lead_events(environment, ref_code, occurred_at desc);
create index if not exists lead_notes_ref_created_idx on public.lead_notes(environment, ref_code, created_at desc);
create index if not exists lead_promises_ref_due_idx on public.lead_promises(environment, ref_code, due_at);
create index if not exists manheim_vehicles_recent_idx on public.manheim_vehicles(environment, uploaded_at desc);

do $$
declare t text;
begin
  foreach t in array array['lead_tracking','lead_notes','lead_events','lead_promises','manheim_vehicles','manheim_saved_searches'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

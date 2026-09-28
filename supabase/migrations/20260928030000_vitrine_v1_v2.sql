-- Vitrine pública por token. Todas as leituras e gravações passam por APIs do servidor.
create table if not exists public.vitrines (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null,
  token text not null, journey_id uuid references public.journeys(id), contact_id uuid references public.contacts(id),
  reference_code text not null, customer_name text, version text not null default 'V1' check (version in ('V1','V2')),
  expires_at timestamptz not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(), created_by uuid references public.panel_users(id),
  unique(environment,token)
);
create table if not exists public.vitrine_cars (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null, vitrine_id uuid not null references public.vitrines(id) on delete cascade,
  source_match_id uuid references public.manheim_matches(id), short_code text not null, vehicle_snapshot jsonb not null, customer_limit_cents integer, note_text text, photo_paths jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(),
  unique(environment,short_code), unique(environment,vitrine_id,source_match_id)
);
create table if not exists public.vitrine_events (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null, vitrine_id uuid not null references public.vitrines(id) on delete cascade, vitrine_car_id uuid references public.vitrine_cars(id) on delete cascade,
  event_type text not null check (event_type in ('OPEN','TAP')), created_at timestamptz not null default now()
);
create table if not exists public.vitrine_requests (
  id uuid primary key default gen_random_uuid(), environment public.panel_environment not null, vitrine_id uuid not null references public.vitrines(id) on delete cascade, vitrine_car_id uuid not null references public.vitrine_cars(id) on delete cascade,
  message_id uuid unique references public.messages(id), contact_id uuid references public.contacts(id), journey_id uuid references public.journeys(id), request_kind text not null check (request_kind in ('VIEW','BID')), referred boolean not null default false, treated_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists vitrines_active_idx on public.vitrines(environment,expires_at desc);
create index if not exists vitrine_events_recent_idx on public.vitrine_events(environment,vitrine_id,created_at desc);
create index if not exists vitrine_requests_open_idx on public.vitrine_requests(environment,treated_at,created_at desc);
alter table public.vitrines enable row level security; alter table public.vitrine_cars enable row level security; alter table public.vitrine_events enable row level security; alter table public.vitrine_requests enable row level security;
revoke all on public.vitrines,public.vitrine_cars,public.vitrine_events,public.vitrine_requests from public,anon,authenticated;
grant all on public.vitrines,public.vitrine_cars,public.vitrine_events,public.vitrine_requests to service_role;
insert into storage.buckets(id,name,public) values('vitrine-photos','vitrine-photos',false) on conflict (id) do nothing;

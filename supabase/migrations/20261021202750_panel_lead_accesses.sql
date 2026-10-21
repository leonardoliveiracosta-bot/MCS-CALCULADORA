-- Internal access history: a view of a ficha is separate from an attendance action.
create table public.panel_lead_accesses (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  opening_id uuid not null,
  journey_id uuid references public.journeys(id),
  ref_code text,
  created_by uuid not null references public.panel_users(id),
  login_email text not null,
  display_name text not null,
  accessed_at timestamptz not null default now(),
  constraint panel_lead_accesses_target check (journey_id is not null or ref_code is not null),
  unique (environment, created_by, opening_id)
);
create index panel_lead_accesses_journey_idx on public.panel_lead_accesses (environment, journey_id, accessed_at desc, id desc);
create index panel_lead_accesses_ref_idx on public.panel_lead_accesses (environment, ref_code, accessed_at desc, id desc) where ref_code is not null;
alter table public.panel_lead_accesses enable row level security;
revoke all on public.panel_lead_accesses from public, anon, authenticated, service_role;
grant select, insert on public.panel_lead_accesses to service_role;
create policy panel_lead_accesses_server_only on public.panel_lead_accesses to service_role using (true) with check (true);
comment on table public.panel_lead_accesses is 'Histórico interno de aberturas de ficha, gravado pelo servidor após autenticar o login';

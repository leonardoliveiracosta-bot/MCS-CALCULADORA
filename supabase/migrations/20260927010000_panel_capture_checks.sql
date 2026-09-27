create table if not exists public.panel_capture_checks (
  environment public.panel_environment primary key,
  checked_at timestamptz,
  missing_count integer not null default 0 check (missing_count >= 0),
  missing_refs jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_refs) = 'array'),
  error_code text,
  failed_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.panel_capture_checks enable row level security;
alter table public.panel_capture_checks force row level security;
revoke all on public.panel_capture_checks from public,anon,authenticated;
grant select,insert,update on public.panel_capture_checks to service_role;

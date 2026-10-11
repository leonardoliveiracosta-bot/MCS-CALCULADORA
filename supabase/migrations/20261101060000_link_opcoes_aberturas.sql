-- Link de opções (/o/<código>): cada vez que a página abre e lê os carros, uma linha aqui. O painel mostra quantas vezes
-- e quando foi a última, como a V1 já mostra. Só acrescenta: os links e a página continuam como estão.
create table if not exists public.panel_option_link_events (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  link_id uuid not null references public.panel_option_links(id) on delete cascade,
  event_type text not null default 'OPEN' check (event_type in ('OPEN')),
  created_at timestamptz not null default now()
);
create index if not exists panel_option_link_events_link_idx on public.panel_option_link_events(environment, link_id, created_at desc);

alter table public.panel_option_link_events enable row level security;
revoke all on table public.panel_option_link_events from public, anon, authenticated;
grant select, insert on table public.panel_option_link_events to service_role;

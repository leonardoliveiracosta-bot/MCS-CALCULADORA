-- Link de opções para o cliente: um código público por pedido (demanda) que abre /o/<código> com os carros do lote
-- ativo dentro dos critérios, sem valor, sem o nome do leilão e com o VIN sem os 6 últimos. O link é gerado no
-- painel (botão na tela Opções do cliente) e é sempre o mesmo para o mesmo pedido; a lista é lida na hora.
create table if not exists public.panel_option_links (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  demand_key text not null check (demand_key ~ '^(journey:[0-9a-f-]{36}|ref:[A-Z0-9]{5}):(VALOR|CARRO)$'),
  public_code text not null unique check (length(public_code) >= 32),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (environment, demand_key)
);

alter table public.panel_option_links enable row level security;
revoke all on table public.panel_option_links from public, anon, authenticated;
grant select, insert on table public.panel_option_links to service_role;

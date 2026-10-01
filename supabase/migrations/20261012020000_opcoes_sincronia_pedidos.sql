-- OPÇÕES em dia com as fichas. Guarda qual critério de cada pedido (demanda) já foi comparado com o
-- lote ativo depois da importação. Um pedido novo (por exemplo, levado de PESQUISAS para a ficha) ou
-- um critério alterado na ficha não está aqui nem na foto do lote, então o painel compara de novo
-- só esse pedido e registra. Só acrescenta a tabela; nada é apagado.
create table if not exists public.manheim_demand_syncs (
  environment public.panel_environment not null,
  upload_id uuid not null references public.manheim_uploads(id),
  demand_key text not null check (demand_key ~ '^(journey:[0-9a-f-]{36}|ref:[A-HJ-NP-Z2-9]{5}):(VALOR|CARRO)$'),
  criteria_hash text not null check (length(criteria_hash) between 8 and 64),
  matches integer not null default 0 check (matches >= 0),
  synced_at timestamptz not null default now(),
  synced_by uuid references public.panel_users(id),
  primary key (environment, upload_id, demand_key, criteria_hash)
);
create index if not exists manheim_demand_syncs_synced_by_idx on public.manheim_demand_syncs(synced_by);
alter table public.manheim_demand_syncs enable row level security;
alter table public.manheim_demand_syncs force row level security;
revoke all on public.manheim_demand_syncs from public,anon,authenticated;
grant select,insert,update,delete on public.manheim_demand_syncs to service_role;

-- Vitrine V2: uma vitrine nova (token novo) ligada a V1 de origem.
-- Aditiva: a V1 continua intacta; parent_vitrine_id fica nulo nas V1.
alter table public.vitrines add column if not exists parent_vitrine_id uuid references public.vitrines(id);
create index if not exists vitrines_parent_idx on public.vitrines(environment,parent_vitrine_id);

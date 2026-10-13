-- RETOMAR (/retomar): em que parte da sequência de 3 mensagens cada ficha está, salvo no banco para o celular e o
-- computador continuarem do mesmo ponto. Guarda o texto preparado (para reconhecer no WhatsApp o que foi de fato
-- enviado) e o resultado "Opções enviadas" gravado ao terminar. Só o servidor lê e escreve.
create table if not exists public.retomar_progress (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  journey_id uuid not null references public.journeys(id) on delete cascade,
  channel text not null check (channel in ('WHATSAPP', 'SMS')),
  lang text not null check (lang in ('en', 'pt', 'es')),
  texts jsonb not null check (jsonb_typeof(texts) = 'array' and jsonb_array_length(texts) = 3),
  option_link text,
  parts_sent smallint not null default 0 check (parts_sent between 0 and 3),
  result_operation uuid not null default gen_random_uuid(),
  result_event_id uuid,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  created_by uuid,
  unique (environment, journey_id)
);

create index if not exists retomar_progress_started_idx on public.retomar_progress (environment, started_at desc);

alter table public.retomar_progress enable row level security;
revoke all on table public.retomar_progress from public, anon, authenticated;
grant select, insert, update on table public.retomar_progress to service_role;

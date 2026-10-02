-- CLIENTES sem carregar todas as mensagens: o banco devolve, por ficha, só os fatos que a lista usa
-- (última mensagem, última do cliente, última da MCS, primeira do cliente, contagem) e, por conversa
-- de WhatsApp da ficha, a última mensagem real (situação da conversa). Aditiva: duas funções de
-- leitura, nenhuma tabela, nenhum dado alterado. Mesmas regras do painel: mensagem desfeita nunca
-- conta; "real" é a que não é automática; a hora é occurred_at_utc, senão a local, senão created_at.
-- As duas funções são paginadas (p_limit, p_offset, ordem estável): o PostgREST corta qualquer
-- resposta em 1.000 linhas, e o painel lê página a página até acabar.

create or replace function public.panel_journey_message_facts(p_environment public.panel_environment, p_limit integer default 500, p_offset integer default 0)
returns table (
  journey_id uuid,
  message_count integer,
  customer_count integer,
  first_customer_at timestamptz,
  first_customer_channel text,
  first_customer_source text,
  first_customer_text text,
  last_customer_id uuid,
  last_customer_at timestamptz,
  last_customer_text text,
  last_customer_channel text,
  last_customer_source text,
  last_mcs_id uuid,
  last_mcs_at timestamptz,
  last_mcs_delivered_at timestamptz,
  last_mcs_read_at timestamptz,
  last_mcs_automatic boolean,
  latest_id uuid,
  latest_direction text,
  latest_at timestamptz,
  latest_text text,
  latest_automatic boolean,
  latest_source text,
  latest_real_at timestamptz,
  latest_real_mcs_at timestamptz
) language sql stable security definer set search_path = public as $$
  with m as (
    select mj.journey_id, msg.id, msg.direction::text as direction, msg.body_text, coalesce(msg.is_automatic, false) as automatic,
      msg.channel::text as channel, msg.source_kind, msg.whatsapp_delivered_at, msg.whatsapp_read_at,
      coalesce(msg.occurred_at_utc, msg.occurred_at_local at time zone 'UTC', msg.created_at) as at,
      coalesce(msg.occurred_at_utc, msg.occurred_at_local at time zone 'UTC') as real_at
    from public.message_journeys mj
    join public.messages msg on msg.id = mj.message_id and msg.environment = p_environment and msg.undone_at is null
    where mj.environment = p_environment and mj.undone_at is null
  ),
  first_customer as (
    select distinct on (journey_id) journey_id, at, channel, source_kind, left(body_text, 300) as body
    from m where direction = 'CUSTOMER' order by journey_id, at asc, id asc
  ),
  last_customer as (
    select distinct on (journey_id) journey_id, id, at, channel, source_kind, left(body_text, 600) as body
    from m where direction = 'CUSTOMER' order by journey_id, at desc, id desc
  ),
  last_mcs as (
    select distinct on (journey_id) journey_id, id, at, whatsapp_delivered_at, whatsapp_read_at, automatic
    from m where direction = 'MCS' order by journey_id, at desc, id desc
  ),
  -- The card's latest message: the newest real one, or the newest of any kind when every one is automatic.
  latest as (
    select distinct on (journey_id) journey_id, id, direction, at, left(body_text, 600) as body, automatic, source_kind
    from m order by journey_id, automatic asc, at desc, id desc
  ),
  counts as (
    select journey_id, count(*)::integer as total, count(*) filter (where direction = 'CUSTOMER')::integer as customers,
      max(real_at) filter (where not automatic) as latest_real_at,
      max(real_at) filter (where not automatic and direction = 'MCS') as latest_real_mcs_at
    from m group by journey_id
  )
  select c.journey_id, c.total, c.customers,
    fc.at, fc.channel, fc.source_kind, fc.body,
    lc.id, lc.at, lc.body, lc.channel, lc.source_kind,
    lm.id, lm.at, lm.whatsapp_delivered_at, lm.whatsapp_read_at, lm.automatic,
    l.id, l.direction, l.at, l.body, l.automatic, l.source_kind,
    c.latest_real_at, c.latest_real_mcs_at
  from counts c
  left join first_customer fc on fc.journey_id = c.journey_id
  left join last_customer lc on lc.journey_id = c.journey_id
  left join last_mcs lm on lm.journey_id = c.journey_id
  left join latest l on l.journey_id = c.journey_id
  order by c.journey_id
  limit greatest(1, least(coalesce(p_limit, 500), 1000)) offset greatest(0, coalesce(p_offset, 0));
$$;

-- Per WhatsApp conversation of a ficha (never a group): the latest real message, as PENDÊNCIAS reads it.
create or replace function public.panel_journey_chat_latest(p_environment public.panel_environment, p_limit integer default 500, p_offset integer default 0)
returns table (journey_id uuid, chat_id uuid, message_id uuid, direction text, at timestamptz, body text)
language sql stable security definer set search_path = public as $$
  select * from (
  select distinct on (mj.journey_id, msg.chat_id) mj.journey_id, msg.chat_id, msg.id, msg.direction::text,
    coalesce(msg.occurred_at_utc, msg.occurred_at_local at time zone 'UTC', msg.created_at), left(msg.body_text, 600)
  from public.message_journeys mj
  join public.messages msg on msg.id = mj.message_id and msg.environment = p_environment and msg.undone_at is null
  join public.chats ch on ch.id = msg.chat_id and ch.environment = p_environment and not ch.is_group and ch.channel = 'WHATSAPP'
  where mj.environment = p_environment and mj.undone_at is null
  order by mj.journey_id, msg.chat_id, coalesce(msg.is_automatic, false) asc,
    coalesce(msg.occurred_at_utc, msg.occurred_at_local at time zone 'UTC', msg.created_at) desc, msg.id desc
  ) latest
  order by journey_id, chat_id
  limit greatest(1, least(coalesce(p_limit, 500), 1000)) offset greatest(0, coalesce(p_offset, 0));
$$;

revoke all on function public.panel_journey_message_facts(public.panel_environment, integer, integer) from public, anon, authenticated;
revoke all on function public.panel_journey_chat_latest(public.panel_environment, integer, integer) from public, anon, authenticated;
grant execute on function public.panel_journey_message_facts(public.panel_environment, integer, integer) to service_role;
grant execute on function public.panel_journey_chat_latest(public.panel_environment, integer, integer) to service_role;

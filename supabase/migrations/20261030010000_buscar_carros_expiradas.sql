-- BUSCAR CARROS e ENVIAR OPÇÕES: resumo por demanda com quantos carros a demanda já teve neste
-- lote (stored_count), para dizer "As opções encontradas neste lote já expiraram", nunca "sem carro
-- no lote". Só cria uma função de leitura: nenhum dado, regra, alias, constraint ou lote muda.

-- A. Opções elegíveis agora (base leve: sem leilão passado e com MMR), como no resumo atual, mais
-- stored_count = carros que a demanda tem neste lote, elegíveis ou não. stored_count > 0 com
-- match_count = 0: as opções encontradas já expiraram.
create or replace function public.panel_manheim_batch_summary_v2(p_environment public.panel_environment, p_upload_id uuid)
returns table(demand_key text, logical_mode text, journey_id uuid, calc_ref text, match_count integer, bate_count integer,
              por_valor_count integer, presented_count integer, criteria_hashes text[], stored_count integer)
language sql stable set search_path to '' set work_mem to '32MB' as $function$
  with per_hash as (
    select g.dk, g.logical_mode, g.journey_id, g.calc_ref, g.criteria_hash,
           count(*) as total, count(*) filter (where g.match_kind = 'BATE') as bate,
           count(*) filter (where g.match_kind = 'POR_VALOR') as por_valor, count(*) filter (where g.presented) as presented
      from public.panel_manheim_grouped_light(p_environment, p_upload_id) g
     group by 1, 2, 3, 4, 5
  ), live as (
    select h.dk, h.logical_mode, h.journey_id, h.calc_ref, sum(h.total)::integer total, sum(h.bate)::integer bate,
           sum(h.por_valor)::integer por_valor, sum(h.presented)::integer presented, array_remove(array_agg(h.criteria_hash), null) hashes
      from per_hash h group by 1, 2, 3, 4
  ), stored as (
    select coalesce(m.demand_key, case when m.journey_id is not null then 'journey:' || m.journey_id::text else 'ref:' || trim(m.calc_ref::text) end || ':' || coalesce(m.logical_mode::text, '')) dk,
           min(m.logical_mode::text) logical_mode, (array_agg(m.journey_id))[1] journey_id, min(trim(m.calc_ref::text)) calc_ref,
           count(distinct coalesce(nullif(upper(trim(m.vehicle_json #>> '{parsed,vin}')), ''), m.row_fingerprint))::integer cars
      from public.manheim_matches m
     where m.environment = p_environment and m.upload_id = p_upload_id and m.undone_at is null
     group by 1
  )
  select coalesce(l.dk, s.dk), coalesce(l.logical_mode, s.logical_mode), coalesce(l.journey_id, s.journey_id), coalesce(l.calc_ref, s.calc_ref),
         coalesce(l.total, 0), coalesce(l.bate, 0), coalesce(l.por_valor, 0), coalesce(l.presented, 0), coalesce(l.hashes, '{}'::text[]), coalesce(s.cars, 0)
    from live l full join stored s on s.dk = l.dk;
$function$;
revoke all on function public.panel_manheim_batch_summary_v2(public.panel_environment, uuid) from public, anon, authenticated;
grant execute on function public.panel_manheim_batch_summary_v2(public.panel_environment, uuid) to service_role;

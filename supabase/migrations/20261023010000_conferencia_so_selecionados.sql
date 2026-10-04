-- Conferência (MANHEIM_MATCH_AUDIT) v3.5: só os carros selecionados para o cliente, em blocos.
-- Aditiva: uma coluna nova. Nenhuma linha existente é alterada ou apagada.
--
--  * car_results: veredito da IA por carro (hash do carro -> {status, divergences}), gravado bloco a
--    bloco. Um bloco que estoura o tempo repete só ele; uma seleção alterada confere só os carros
--    novos ou alterados (mesmo hash do carro e mesma versão da regra são reaproveitados).
--  * As linhas antigas (conferencia-v3.4, pedido inteiro) ficam para auditoria. A regra nova tem
--    outro hash, então os pedidos hoje PENDENTE por AUDIT_DEADLINE são conferidos de novo, já só
--    sobre os carros selecionados.
alter table public.manheim_match_audits
  add column if not exists car_results jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'manheim_match_audits_car_results_object') then
    alter table public.manheim_match_audits
      add constraint manheim_match_audits_car_results_object check (jsonb_typeof(car_results) = 'object');
  end if;
end $$;

-- Carros selecionados para a conferência: agrupa (por VIN) só os pedidos com seleção, um de cada
-- vez, e devolve só os grupos com um carro selecionado. A leitura antiga agrupava o lote inteiro
-- (dezenas de milhares de carros) antes de filtrar e estourava o tempo do PostgREST (8 s).
create or replace function public.panel_manheim_audit_selected_options(p_environment public.panel_environment, p_upload_id uuid, p_demand_keys text[], p_match_ids uuid[])
returns jsonb
language sql
stable security definer
set search_path to ''
as $function$
  select coalesce(jsonb_agg(to_jsonb(g) order by k.ord, g.id), '[]'::jsonb)
    from unnest(coalesce(p_demand_keys, '{}'::text[])) with ordinality as k(key, ord)
   cross join lateral public.panel_manheim_grouped_options(p_environment, p_upload_id, k.key) g
   where coalesce(g.mmr_cents::bigint, case when g.vehicle_json #>> '{parsed,mmrCents}' ~ '^[0-9]{1,12}$' then (g.vehicle_json #>> '{parsed,mmrCents}')::bigint end, 0) > 0
     and exists (select 1 from jsonb_array_elements_text(coalesce(g.vehicle_json #> '{parsed,memberMatchIds}', jsonb_build_array(g.id))) member
                  where member.value::uuid = any(coalesce(p_match_ids, '{}'::uuid[])));
$function$;
revoke all on function public.panel_manheim_audit_selected_options(public.panel_environment, uuid, text[], uuid[]) from public, anon, authenticated;
grant execute on function public.panel_manheim_audit_selected_options(public.panel_environment, uuid, text[], uuid[]) to service_role;

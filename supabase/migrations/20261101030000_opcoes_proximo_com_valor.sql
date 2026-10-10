-- "Próximo" também em pedido POR CARRO com valor informado (dentro do valor). As duas regras que retiram um
-- carro "acima do valor" quando o pedido tem um carro exato no valor continuam contando só os exatos: a
-- linha "Próximo" não entra nessa conta. Com isso nada do que existe muda (hoje nenhuma linha é próxima).
do $$
declare
  v_fix record;
  v_def text;
begin
  for v_fix in
    select * from (values
      ('panel_manheim_resolve_fallback',
       $q$coalesce(strict.vehicle_json->'parsed'->>'budgetFallback','false')<>'true')$q$,
       $q$coalesce(strict.vehicle_json->'parsed'->>'budgetFallback','false')<>'true' and coalesce(strict.vehicle_json->'parsed'->>'matchNear','')<>'true')$q$),
      ('panel_manheim_complement_apply',
       $q$coalesce(strict.vehicle_json -> 'parsed' ->> 'budgetFallback', 'false') <> 'true')$q$,
       $q$coalesce(strict.vehicle_json -> 'parsed' ->> 'budgetFallback', 'false') <> 'true' and coalesce(strict.vehicle_json -> 'parsed' ->> 'matchNear', '') <> 'true')$q$)
    ) as f(name, old_text, new_text)
  loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fix.name;
    if v_def is null then raise exception 'OPCOES_PROXIMO_VALOR: % não existe', v_fix.name; end if;
    if position('matchNear' in v_def) > 0 then continue; end if;
    if (length(v_def) - length(replace(v_def, v_fix.old_text, ''))) / length(v_fix.old_text) <> 1 then
      raise exception 'OPCOES_PROXIMO_VALOR: % não tem exatamente uma conta de exatos', v_fix.name;
    end if;
    execute replace(v_def, v_fix.old_text, v_fix.new_text);
  end loop;
end;
$$;

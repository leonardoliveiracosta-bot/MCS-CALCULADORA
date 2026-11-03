-- Preview companion: extend only recognition of the approved target-price label.
-- Apply in the publication rollout before the new public message is enabled.
-- No rows, tables, grants, RLS policies, historical messages or financial rules change.
do $commercial$
declare
  item record;
  old_definition text;
  new_definition text;
  functions_found integer := 0;
begin
  for item in
    select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in
      ('panel_calc_template_text','panel_identity_evidence','panel_journey_explicit_refs')
  loop
    functions_found := functions_found + 1;
    old_definition := pg_get_functiondef(item.oid);
    if position('your target vehicle price' in old_definition)>0 then continue; end if;
    new_definition := replace(old_definition,
      'vehicle search request|calculate my cost',
      'your target vehicle price|preço pretendido para o veículo|precio deseado para el vehículo|vehicle search request|calculate my cost');
    new_definition := replace(new_definition,
      '(maximum bid|lance máximo|oferta máxima)',
      '(your target vehicle price|preço pretendido para o veículo|precio deseado para el vehículo|maximum bid|lance máximo|oferta máxima)');
    if new_definition = old_definition and position('your target vehicle price' in old_definition)=0 then
      raise exception 'Recognition pattern changed unexpectedly in %', item.proname;
    end if;
    if new_definition <> old_definition then execute new_definition; end if;
  end loop;
  if functions_found <> 3 then raise exception 'Expected three calculator recognition functions, found %', functions_found; end if;
end
$commercial$;

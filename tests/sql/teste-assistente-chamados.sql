-- Assistente do painel (migrações 20261028010000 e 20261029010000): chamados agrupados por
-- fingerprint, CORRIGIDO reabre quando o defeito volta, histórico de eventos e a reserva de gasto da
-- OpenAI aceitando a função ASSISTENTE.
begin;
insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password)
values('6f200000-0000-4000-8000-000000000001','preview','6f200000-0000-4000-8000-000000000002','assist@example.com','admin',true,false)
on conflict do nothing;
do $$
declare
  actor uuid:='6f200000-0000-4000-8000-000000000001';
  a jsonb; b jsonb; c jsonb; d jsonb; n integer;
begin
  a:=public.panel_incident_report('preview',actor,'v1|ficha-open|DEFEITO_TELA','P1','v1','{"view":"v1"}','{"categoria":"DEFEITO_TELA"}');
  b:=public.panel_incident_report('preview',actor,'v1|ficha-open|DEFEITO_TELA','P1','v2','{"view":"v1"}','{"categoria":"DEFEITO_TELA"}');
  if a->>'id'<>b->>'id' or (b->>'count')::int<>2 or b->>'status'<>'ABERTO' then raise exception 'FALHA: não agrupou %',b; end if;
  if (select last_version from public.panel_incidents where id=(b->>'id')::uuid)<>'v2' then raise exception 'FALHA: versão não atualizou'; end if;
  -- outro defeito, outro chamado
  c:=public.panel_incident_report('preview',actor,'searches|v1-generate|TECNICO','P0','v2','{}','{}');
  if c->>'id'=a->>'id' then raise exception 'FALHA: juntou defeitos diferentes'; end if;
  -- corrigido e o defeito volta: reabre o mesmo chamado
  update public.panel_incidents set status='CORRIGIDO', pr_url='https://github.com/x/y/pull/1' where id=(a->>'id')::uuid;
  d:=public.panel_incident_report('preview',actor,'v1|ficha-open|DEFEITO_TELA','P1','v3','{}','{}');
  if d->>'id'<>a->>'id' or d->>'status'<>'ABERTO' or (d->>'reopened')::boolean is not true then raise exception 'FALHA: não reabriu %',d; end if;
  if (select reopened_count from public.panel_incidents where id=(a->>'id')::uuid)<>1 then raise exception 'FALHA: contagem de reabertura'; end if;
  -- "não era defeito" não volta a contar: um novo relato abre outro chamado
  update public.panel_incidents set status='NAO_ERA_DEFEITO' where id=(c->>'id')::uuid;
  d:=public.panel_incident_report('preview',actor,'searches|v1-generate|TECNICO','P0','v3','{}','{}');
  if d->>'id'=c->>'id' then raise exception 'FALHA: reaproveitou chamado encerrado como não defeito'; end if;
  -- gravidade e status inválidos são recusados
  begin
    perform public.panel_incident_report('preview',actor,'x|y|z','P9','v1','{}','{}');
    raise exception 'FALHA: gravidade inválida aceita';
  exception when others then if sqlerrm not like '%INCIDENT_INVALID%' then raise; end if; end;
  -- eventos
  insert into public.panel_assistant_events(environment,created_by,incident_id,event_type,action,payload)
    values('preview',actor,(a->>'id')::uuid,'AUTORIZADA','abrir_ficha','{"journeyId":"x"}');
  select count(*) into n from public.panel_assistant_events where incident_id=(a->>'id')::uuid;
  if n<>1 then raise exception 'FALHA: evento'; end if;
  begin
    insert into public.panel_assistant_events(environment,event_type) values('preview','QUALQUER');
    raise exception 'FALHA: tipo de evento inválido aceito';
  exception when check_violation then null; end;
end $$;
-- a reserva de gasto da OpenAI aceita a função ASSISTENTE (migração 20261029010000)
do $$
declare answer jsonb;
begin
  begin
    answer:=public.panel_openai_budget_hold('preview','ASSISTENTE','chat:teste','gpt-6-luna',0.001);
  exception when check_violation then raise exception 'FALHA: reserva recusou a função ASSISTENTE';
  end;
  if (answer->>'held')::boolean is not true then raise exception 'FALHA: reserva não foi feita %',answer; end if;
end $$;
rollback;

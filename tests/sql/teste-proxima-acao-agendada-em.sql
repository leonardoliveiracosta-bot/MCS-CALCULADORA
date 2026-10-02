insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('7e000000-0000-4000-8000-000000000011','preview','Teste próxima ação','WHATSAPP_DIRECT',now(),now());
insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('7e000000-0000-4000-8000-000000000010','preview','7e000000-0000-4000-8000-000000000011','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());
do $$
begin
  if (select next_action_set_at from public.journeys where id='7e000000-0000-4000-8000-000000000010') is not null then raise exception 'sem próxima ação não tem data de agendamento'; end if;
  update public.journeys set next_action_at=now()+interval '2 days', next_action_text='Ligar' where id='7e000000-0000-4000-8000-000000000010';
  if (select next_action_set_at from public.journeys where id='7e000000-0000-4000-8000-000000000010') is null then raise exception 'agendar grava quando foi agendada'; end if;
  update public.journeys set stage='EM_BUSCA' where id='7e000000-0000-4000-8000-000000000010';
  if (select next_action_set_at from public.journeys where id='7e000000-0000-4000-8000-000000000010') is null then raise exception 'outra mudança não apaga a data de agendamento'; end if;
  update public.journeys set next_action_at=null, next_action_text=null where id='7e000000-0000-4000-8000-000000000010';
  if (select next_action_set_at from public.journeys where id='7e000000-0000-4000-8000-000000000010') is not null then raise exception 'remover a próxima ação limpa a data'; end if;
end $$;

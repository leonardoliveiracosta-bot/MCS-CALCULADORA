do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='panel_item_dispositions' and column_name='cleared_at') then
    raise exception 'panel_item_dispositions.cleared_at ausente';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='conversation_pending_resolutions' and column_name='undone_at') then
    raise exception 'conversation_pending_resolutions.undone_at ausente';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='message_journeys' and column_name='undone_at') then
    raise exception 'message_journeys.undone_at ausente';
  end if;
  if not exists (select 1 from pg_indexes where schemaname='public' and indexname='panel_item_dispositions_active_idx') then
    raise exception 'índice ativo de disposições ausente';
  end if;
end $$;

insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password)
values('10000000-0000-4000-8000-000000000001','preview','10000000-0000-4000-8000-000000000002','acoes@example.com','admin',true,false)
on conflict do nothing;

insert into public.panel_item_dispositions(environment,item_kind,item_key,status,updated_by)
values('preview','REF','ABC23','DISCARDED','10000000-0000-4000-8000-000000000001')
on conflict(environment,item_kind,item_key) do update set status=excluded.status,cleared_at=null,cleared_by=null;

update public.panel_item_dispositions
set cleared_at=now(),cleared_by='10000000-0000-4000-8000-000000000001'
where environment='preview' and item_kind='REF' and item_key='ABC23';

do $$
begin
  if (select count(*) from public.panel_item_dispositions where environment='preview' and item_kind='REF' and item_key='ABC23') <> 1 then
    raise exception 'desfazer criou ou apagou histórico';
  end if;
  if exists (select 1 from public.panel_item_dispositions where environment='preview' and item_kind='REF' and item_key='ABC23' and cleared_at is null) then
    raise exception 'disposição desfeita ainda está ativa';
  end if;
end $$;

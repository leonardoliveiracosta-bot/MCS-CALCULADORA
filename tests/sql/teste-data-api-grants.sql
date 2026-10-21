-- Replay runs with no automatic table/sequence grants. Test actual privileges,
-- not just SQL text: API table grants and RLS are independent layers.
begin;

do $$
declare t text;
begin
  foreach t in array array[
    'panel_users','contacts','contact_phones','chats','chat_aliases','journeys',
    'journey_refs','messages','message_journeys','journey_checklist',
    'checklist_evidence','journey_declarations','journey_divergences','promises',
    'units','interactions','journey_alert_suppressions','activity_log','audit_log',
    'import_jobs','calculator_request_links','attachments','panel_notifications'
  ] loop
    if not has_table_privilege('service_role','public.'||t,'SELECT') then
      raise exception 'server SELECT missing on %',t;
    end if;
    if not has_table_privilege('authenticated','public.'||t,'SELECT') then
      raise exception 'existing browser SELECT lost on %',t;
    end if;
    if has_table_privilege('anon','public.'||t,'SELECT')
       or has_table_privilege('authenticated','public.'||t,'INSERT,UPDATE,DELETE') then
      raise exception 'browser access broadened on %',t;
    end if;
    if not (select relrowsecurity and relforcerowsecurity from pg_class where oid=('public.'||t)::regclass) then
      raise exception 'RLS changed on %',t;
    end if;
  end loop;
  if not has_table_privilege('service_role','public.calc_runs','SELECT') then
    raise exception 'server calc_runs SELECT missing';
  end if;
  -- No blanket CRUD: evidence/attachments are written through definer RPCs;
  -- audit rows are append-only for the server's direct API access.
  if has_table_privilege('service_role','public.audit_log','UPDATE,DELETE')
     or has_table_privilege('service_role','public.checklist_evidence','INSERT,UPDATE,DELETE')
     or has_table_privilege('service_role','public.attachments','INSERT,UPDATE,DELETE')
     or has_table_privilege('service_role','public.calc_runs','INSERT,UPDATE,DELETE')
     or has_table_privilege('service_role','public.import_batches','SELECT,INSERT,UPDATE,DELETE') then
    raise exception 'unnecessary server privilege';
  end if;
  -- Sample the pre-existing private API tables: restricted grants stay restricted.
  foreach t in array array['ia_instrucoes','ia_sugestoes','panel_option_links',
      'panel_option_link_events','panel_assistant_proposals','panel_request_log','panel_server_logs'] loop
    if has_table_privilege('anon','public.'||t,'SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('authenticated','public.'||t,'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'server-only table exposed: %',t;
    end if;
  end loop;
end $$;

-- Match the hosted role's BYPASSRLS, but give it no implicit table grants.
alter role service_role bypassrls;
set local role service_role;
select * from public.journeys where false;
select public.calc_public_scenarios(30);
select public.panel_boot_table_rows('preview','messages',array['id']);
select public.panel_boot_table_rows('preview','calc_runs',array['id']);

-- The same insert/upsert/update/rollback operations used by entry.js. The
-- notification INSERT also checks the generated identity (no blanket sequence GRANT).
insert into public.contacts(id,environment,display_name,created_at,updated_at)
values('c5ec582a-48ca-4d91-beda-15b6319bd530','preview','grant-test',now(),now());
insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at)
values('d28f2396-ad6b-4e6c-88f7-355250644152','preview','WHATSAPP',
  'c5ec582a-48ca-4d91-beda-15b6319bd530','grant-test','RESOLVED',now(),now());
insert into public.chat_aliases(environment,chat_id,alias_text,alias_normalized,first_seen_at,last_seen_at,created_at)
values('preview','d28f2396-ad6b-4e6c-88f7-355250644152','grant-test','grant-test',now(),now(),now())
on conflict(environment,chat_id,alias_normalized) do update set alias_text=excluded.alias_text;
update public.contacts set display_name='grant-test-updated' where id='c5ec582a-48ca-4d91-beda-15b6319bd530';
insert into public.panel_notifications(environment,topic) values('preview','grant-test') returning id;
delete from public.chat_aliases where chat_id='d28f2396-ad6b-4e6c-88f7-355250644152';
delete from public.chats where id='d28f2396-ad6b-4e6c-88f7-355250644152';
delete from public.contacts where id='c5ec582a-48ca-4d91-beda-15b6319bd530';
reset role;
rollback;

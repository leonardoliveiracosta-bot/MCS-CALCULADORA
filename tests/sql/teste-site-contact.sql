-- One-time requests are isolated from the existing customer/auction system.
do $$
declare k uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid(); r uuid; n integer; before_counts jsonb;
begin
 before_counts:=jsonb_build_array((select count(*) from public.contacts),(select count(*) from public.journeys),(select count(*) from public.messages),(select count(*) from public.calc_runs));
 insert into public.panel_users(id,environment,auth_user_id,email) values(actor,'preview',gen_random_uuid(),'callback-test@example.test');
 perform public.site_contact_request_create('preview',k,'Alex Example','+13055550101','SMS','en','footer',repeat('a',64));
 perform public.site_contact_request_create('preview',k,'Alex Example','+13055550101','SMS','en','footer',repeat('a',64));
 perform public.site_contact_request_create('preview',gen_random_uuid(),'Alex Example','+13055550101','SMS','en','footer',repeat('a',64));
 select count(*),min(id::text)::uuid into n,r from public.site_contact_requests where phone_e164='+13055550101' and environment='preview';
 assert n=1,'lost response or form reopen duplicated the request';
 begin
  perform public.site_contact_request_create('preview',k,'Other person','+13055550102','CALL','en','footer',repeat('a',64));
  raise exception 'reused key accepted different data';
 exception when raise_exception then assert sqlerrm='CONTACT_KEY_CONFLICT'; end;
 perform public.site_contact_request_status('preview',r,'CONTACTED','OPEN',actor);
 assert (select status='CONTACTED' and handled_by=actor and handled_at is not null from public.site_contact_requests where id=r),'contact result missing';
 begin
  perform public.site_contact_request_status('preview',r,'ARCHIVED','OPEN',actor);
  raise exception 'stale result overwrote another operator';
 exception when raise_exception then assert sqlerrm='CONTACT_STATUS_CHANGED'; end;
 perform public.site_contact_request_status('preview',r,'OPEN','CONTACTED',actor);
 assert (select status='OPEN' and handled_by is null and handled_at is null from public.site_contact_requests where id=r),'undo failed';
 begin
  perform public.site_contact_request_status('production',r,'ARCHIVED','OPEN',actor);
  raise exception 'cross-environment actor accepted';
 exception when raise_exception then assert sqlerrm='CONTACT_INVALID'; end;
 perform public.site_contact_request_create('preview',gen_random_uuid(),'Rate One','+13055550103','CALL','en','footer',repeat('b',64));
 perform public.site_contact_request_create('preview',gen_random_uuid(),'Rate Two','+13055550103','SMS','en','footer',repeat('b',64));
 perform public.site_contact_request_create('preview',gen_random_uuid(),'Rate Three','+13055550103','WHATSAPP','en','footer',repeat('b',64));
 begin
  perform public.site_contact_request_create('preview',gen_random_uuid(),'Rate Four','+13055550103','CALL','pt','footer',repeat('b',64));
  raise exception 'phone rate limit ignored';
 exception when raise_exception then assert sqlerrm='CONTACT_RATE_LIMIT'; end;
 for n in 1..8 loop
  perform public.site_contact_request_create('preview',gen_random_uuid(),'IP Example',('+130555502'||lpad(n::text,2,'0')),'SMS','en','footer',repeat('c',64));
 end loop;
 begin
  perform public.site_contact_request_create('preview',gen_random_uuid(),'IP Example','+13055550209','SMS','en','footer',repeat('c',64));
  raise exception 'ip rate limit ignored';
 exception when raise_exception then assert sqlerrm='CONTACT_RATE_LIMIT'; end;
 assert before_counts=jsonb_build_array((select count(*) from public.contacts),(select count(*) from public.journeys),(select count(*) from public.messages),(select count(*) from public.calc_runs)),'request changed existing business records';
 assert not has_table_privilege('anon','public.site_contact_requests','SELECT'),'anon can read phones';
 assert not has_table_privilege('authenticated','public.site_contact_requests','SELECT'),'ordinary login can read phones';
 assert not has_function_privilege('anon','public.site_contact_request_create(public.panel_environment,uuid,text,text,text,text,text,text)','EXECUTE'),'anon can bypass API gate';
 assert not has_function_privilege('authenticated','public.site_contact_request_status(public.panel_environment,uuid,text,text,uuid)','EXECUTE'),'unauthorized status update';
 assert (select relrowsecurity from pg_class where oid='public.site_contact_requests'::regclass),'RLS missing';
end $$;

-- Contact capture is limited to the financing path. Existing contact APIs stay unchanged.
alter table public.site_contact_requests drop constraint site_contact_requests_source_check;
alter table public.site_contact_requests add constraint site_contact_requests_source_check
 check(source in ('footer','contact-menu','finance'));

create function public.mcs_finance_contact_create(
 p_environment public.panel_environment,p_request_key uuid,p_name text,p_phone text,
 p_language text,p_answers jsonb,p_ip_hash text
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 existing public.calc_runs;
 contact public.site_contact_requests;
 new_ref text;
 alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
 if p_environment is null or p_request_key is null or p_name is null or char_length(btrim(p_name)) not between 2 and 80
 or p_name ~ '[<>[:cntrl:]]' or p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$'
 or p_language is null or p_language not in ('en','es','pt') or p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
 or p_answers is null or jsonb_typeof(p_answers)<>'object' then raise exception 'FINANCE_INVALID'; end if;
 if not (p_answers ?& array['credit_profile','down_payment','monthly_payment','trade_in'])
 or (select count(*) from jsonb_object_keys(p_answers))<>4
 or coalesce(p_answers->>'credit_profile','') not in ('excellent','very_good','good','building','not_sure')
 or coalesce(p_answers->>'down_payment','') not in ('under_2500','2500_5000','5000_10000','10000_plus')
 or coalesce(p_answers->>'monthly_payment','') not in ('under_400','400_600','600_900','900_plus')
 or coalesce(p_answers->>'trade_in','') not in ('yes','no') then raise exception 'FINANCE_INVALID'; end if;
 perform pg_advisory_xact_lock(hashtextextended('finance-request:'||p_request_key,0));
 perform pg_advisory_xact_lock(hashtextextended('site-phone:'||p_environment||':'||p_phone,0));
 perform pg_advisory_xact_lock(hashtextextended('site-ip:'||p_environment||':'||p_ip_hash,0));
 select * into existing from public.calc_runs where id=p_request_key;
 if found then
  select * into contact from public.site_contact_requests where environment=p_environment and request_key=p_request_key and source='finance';
  if contact.id is null or existing.is_test is distinct from (p_environment<>'production')
   or existing.dados->>'tipo' is distinct from 'finance' or existing.idioma is distinct from p_language
   or existing.dados->'finance' is distinct from p_answers or contact.name is distinct from btrim(p_name)
   or contact.phone_e164 is distinct from p_phone then raise exception 'FINANCE_KEY_CONFLICT'; end if;
  return jsonb_build_object('ref',existing.dados->>'ref');
 end if;
 -- A refresh with the same details returns the same request, never a second queue item.
 select r.* into existing from public.calc_runs r
 join public.site_contact_requests c on c.request_key=r.id and c.environment=p_environment and c.source='finance'
 where c.phone_e164=p_phone and c.name=btrim(p_name) and c.language=p_language
 and c.created_at>now()-interval '10 minutes' and r.is_test=(p_environment<>'production') and r.dados->'finance'=p_answers
 order by c.created_at desc limit 1;
 if found then return jsonb_build_object('ref',existing.dados->>'ref'); end if;
 if (select count(*) from public.site_contact_requests where environment=p_environment and phone_e164=p_phone and created_at>now()-interval '1 hour')>=3
 or (select count(*) from public.site_contact_requests where environment=p_environment and ip_hash=p_ip_hash and created_at>now()-interval '10 minutes')>=8 then raise exception 'FINANCE_RATE_LIMIT'; end if;
 perform pg_advisory_xact_lock(hashtextextended('mcs-finance-reference',0));
 for attempt in 1..12 loop
  select string_agg(substr(alphabet,1+floor(random()*length(alphabet))::integer,1),'') into new_ref from generate_series(1,5);
  exit when not exists(select 1 from public.calc_runs where upper(dados->>'ref')=new_ref);
  new_ref:=null;
 end loop;
 if new_ref is null then raise exception 'FINANCE_UNAVAILABLE'; end if;
 -- One transaction: neither the Ref nor the callback exists without the other.
 insert into public.calc_runs(id,pagamento,idioma,origem,is_test,dados)
 values(p_request_key,'fin',p_language,'finance',p_environment<>'production',jsonb_build_object(
  'sid','finance-'||p_request_key,'ref',new_ref,'tipo','finance','evento','contato','canal','call',
  'quando',now(),'finance',p_answers,'nome',btrim(p_name),'contact_request_id',p_request_key));
 insert into public.site_contact_requests(id,environment,request_key,name,phone_e164,channel,language,source,consent_version,ip_hash)
 values(p_request_key,p_environment,p_request_key,btrim(p_name),p_phone,'CALL',p_language,'finance','finance-contact-v1',p_ip_hash);
 return jsonb_build_object('ref',new_ref);
end;$$;
revoke all on function public.mcs_finance_contact_create(public.panel_environment,uuid,text,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.mcs_finance_contact_create(public.panel_environment,uuid,text,text,text,jsonb,text) to service_role;

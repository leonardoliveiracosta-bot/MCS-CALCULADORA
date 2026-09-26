-- Runs against the complete disposable schema. It exercises the actual
-- panel_whatsapp_apply_message function with both physical row orders.
do $$
declare
  first_contact uuid;
  second_contact uuid;
  first_raw uuid;
  second_raw uuid;
  first_result jsonb;
  second_result jsonb;
  stamp text := extract(epoch from now())::bigint::text;
begin
  -- Active number stored first, current primary stored second.
  insert into public.contacts(environment,display_name,source,created_at,updated_at)
    values('preview','Troca principal 1','MANUAL',now(),now()) returning id into first_contact;
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
    values
      ('preview',first_contact,'+13055550001','+13055550001',true,false,now()),
      ('preview',first_contact,'+13055550009','+13055550009',true,true,now());
  insert into public.whatsapp_raw_events(environment,event_key,event_type,payload_json,status)
    values('preview','sql-primary-first','messages','{}','PENDING') returning id into first_raw;
  select public.panel_whatsapp_apply_message('preview',first_raw,jsonb_build_object(
    'phone','+13055550001','messageId','wamid.sql.primary.first','name','Troca principal 1',
    'body','teste de troca principal 1','direction','CUSTOMER','timestamp',stamp,
    'refs','[]'::jsonb,'forceContactId',first_contact::text
  )) into first_result;

  if (select count(*) from public.contact_phones where environment='preview' and contact_id=first_contact and retired_at is null and is_current and is_primary) <> 1
     or not exists(select 1 from public.contact_phones where environment='preview' and contact_id=first_contact and phone_e164='+13055550001' and is_primary)
     or exists(select 1 from public.contact_phones where environment='preview' and contact_id=first_contact and phone_e164='+13055550009' and is_primary)
  then raise exception 'PRIMARY_SWAP_ACTIVE_FIRST_FAILED'; end if;

  -- Current primary stored first, active number stored second.
  insert into public.contacts(environment,display_name,source,created_at,updated_at)
    values('preview','Troca principal 2','MANUAL',now(),now()) returning id into second_contact;
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at)
    values
      ('preview',second_contact,'+13055550019','+13055550019',true,true,now()),
      ('preview',second_contact,'+13055550011','+13055550011',true,false,now());
  insert into public.whatsapp_raw_events(environment,event_key,event_type,payload_json,status)
    values('preview','sql-primary-last','messages','{}','PENDING') returning id into second_raw;
  select public.panel_whatsapp_apply_message('preview',second_raw,jsonb_build_object(
    'phone','+13055550011','messageId','wamid.sql.primary.last','name','Troca principal 2',
    'body','teste de troca principal 2','direction','CUSTOMER','timestamp',stamp,
    'refs','[]'::jsonb,'forceContactId',second_contact::text
  )) into second_result;

  if (select count(*) from public.contact_phones where environment='preview' and contact_id=second_contact and retired_at is null and is_current and is_primary) <> 1
     or not exists(select 1 from public.contact_phones where environment='preview' and contact_id=second_contact and phone_e164='+13055550011' and is_primary)
     or exists(select 1 from public.contact_phones where environment='preview' and contact_id=second_contact and phone_e164='+13055550019' and is_primary)
  then raise exception 'PRIMARY_SWAP_ACTIVE_LAST_FAILED'; end if;
end $$;

select phone_e164,is_primary
from public.contact_phones
where phone_e164 in ('+13055550001','+13055550009','+13055550011','+13055550019')
order by phone_e164;

create or replace function public.panel_whatsapp_apply_address_book(p_environment public.panel_environment,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare updated_count integer;
begin
 if jsonb_typeof(p_entries)<>'array' then raise exception 'ADDRESS_BOOK_INVALID'; end if;
 with supplied as (
   select distinct on (phone_e164)
     public.panel_normalize_phone(value->>'phone_e164') as phone_e164,
     left(coalesce(nullif(trim(value->>'full_name'),''),nullif(trim(value->>'first_name'),'')),160) as display_name
   from jsonb_array_elements(p_entries) value
   order by phone_e164,display_name desc nulls last
 )
 update public.contacts c set display_name=s.display_name,updated_at=now()
 from public.contact_phones cp join supplied s on s.phone_e164=cp.phone_e164
 where c.environment=p_environment and cp.environment=p_environment and cp.contact_id=c.id
   and cp.is_current and cp.retired_at is null and s.display_name is not null
   and coalesce(trim(c.display_name),'')='';
 get diagnostics updated_count=row_count;
 return jsonb_build_object('updated',updated_count);
end $$;

revoke all on function public.panel_whatsapp_apply_address_book(public.panel_environment,jsonb) from public,anon,authenticated;
grant execute on function public.panel_whatsapp_apply_address_book(public.panel_environment,jsonb) to service_role;

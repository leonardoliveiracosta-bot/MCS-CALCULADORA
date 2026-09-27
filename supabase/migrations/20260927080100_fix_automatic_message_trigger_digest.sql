-- The message trigger runs with a pinned public search path; pgcrypto lives in extensions.
create or replace function public.panel_message_automatic_before_insert()
returns trigger language plpgsql security definer set search_path=public as $$
declare normalized text:=lower(trim(regexp_replace(coalesce(new.body_text,''),'\s+',' ','g'))); configured boolean:=false;
begin
 new.automatic_text_hash:=encode(extensions.digest(normalized,'sha256'),'hex');
 if new.direction='MCS' then
   select exists(select 1 from public.panel_automatic_messages automatic_message where automatic_message.environment=new.environment and automatic_message.enabled and automatic_message.body_normalized=normalized) into configured;
   if normalized like 'hi, this is an automatic message from my car scout%' or configured then new.is_automatic:=true; end if;
 end if;
 return new;
end $$;

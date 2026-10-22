-- Mensagem enviada pelo agente RENE (source_kind 'RENE', api/rene/send.js) entra como automática, igual ao bot:
-- não conta como resposta, a ficha não vira Respondido e continua pendente até uma pessoa responder.
-- Marcada já na entrada porque panel_refresh_effective_mcs nunca volta a etapa (M6). Só muda mensagens do RENE.
create or replace function public.panel_message_automatic_before_insert()
returns trigger language plpgsql security definer set search_path=public as $$
declare normalized text:=lower(trim(regexp_replace(coalesce(new.body_text,''),'\s+',' ','g'))); configured boolean:=false;
begin
 new.automatic_text_hash:=encode(extensions.digest(normalized,'sha256'),'hex');
 if new.direction='MCS' then
   select exists(select 1 from public.panel_automatic_messages automatic_message where automatic_message.environment=new.environment and automatic_message.enabled and automatic_message.body_normalized=normalized) into configured;
   if normalized like 'hi, this is an automatic message from my car scout%' or configured or new.source_kind='RENE' then new.is_automatic:=true; end if;
 end if;
 return new;
end $$;

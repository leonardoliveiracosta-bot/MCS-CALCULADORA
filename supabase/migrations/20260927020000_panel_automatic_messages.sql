alter table public.messages add column if not exists is_automatic boolean not null default false;
alter table public.messages add column if not exists automatic_override boolean;
alter table public.messages add column if not exists automatic_text_hash text;

create table if not exists public.panel_automatic_messages (
  id uuid primary key default gen_random_uuid(),
  environment public.panel_environment not null,
  body_normalized text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(environment, body_normalized)
);
alter table public.panel_automatic_messages enable row level security;
alter table public.panel_automatic_messages force row level security;
revoke all on public.panel_automatic_messages from public, anon, authenticated;
grant select, insert, update, delete on public.panel_automatic_messages to service_role;

create index if not exists messages_automatic_webhook_idx
  on public.messages(environment, direction, source_kind, automatic_text_hash, occurred_at_utc desc)
  where direction='MCS' and source_kind='WHATSAPP_WEBHOOK';

create or replace function public.panel_message_automatic_before_insert()
returns trigger language plpgsql security definer set search_path=public as $$
declare normalized text:=lower(trim(regexp_replace(coalesce(new.body_text,''),'\s+',' ','g'))); configured boolean:=false;
begin
  new.automatic_text_hash:=encode(digest(normalized,'sha256'),'hex');
  if new.direction='MCS' then
    select exists(select 1 from public.panel_automatic_messages a where a.environment=new.environment and a.enabled and a.body_normalized=normalized) into configured;
    if normalized like 'hi, this is an automatic message from my car scout%' or configured then new.is_automatic:=true; end if;
  end if;
  return new;
end $$;
drop trigger if exists messages_automatic_before_insert on public.messages;
create trigger messages_automatic_before_insert before insert on public.messages for each row execute function public.panel_message_automatic_before_insert();

create or replace function public.panel_refresh_effective_mcs(p_environment public.panel_environment,p_journey uuid)
returns void language plpgsql security definer set search_path=public as $$
declare latest_effective timestamptz;
begin
 select max(m.occurred_at_utc) into latest_effective from public.messages m join public.message_journeys j on j.message_id=m.id
 where j.environment=p_environment and j.journey_id=p_journey and m.environment=p_environment and m.direction='MCS' and not m.is_automatic;
 update public.journeys x set
   stage=case when x.stage='RESPONDIDO' and latest_effective is null then 'NOVO' else x.stage end,
   last_effective_contact_at=latest_effective,
   updated_at=now()
 where x.environment=p_environment and x.id=p_journey and x.status<>'ENCERRADO';
end $$;

create or replace function public.panel_detect_webhook_automatic(p_environment public.panel_environment,p_message uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare target public.messages%rowtype; ids uuid[]; affected uuid[]; journey uuid;
begin
 select * into target from public.messages where id=p_message and environment=p_environment and direction='MCS' and source_kind='WHATSAPP_WEBHOOK';
 if not found then return jsonb_build_object('automatic',false); end if;
 select array_agg(m.id), array_agg(distinct l.journey_id) into ids, affected
 from public.messages m join public.message_journeys l on l.message_id=m.id
 where m.environment=p_environment and m.direction='MCS' and m.source_kind='WHATSAPP_WEBHOOK'
   and m.automatic_text_hash=target.automatic_text_hash and m.occurred_at_utc between target.occurred_at_utc-interval '2 minutes' and target.occurred_at_utc+interval '2 minutes'
   and exists (select 1 from public.messages c join public.message_journeys cl on cl.message_id=c.id where c.environment=p_environment and cl.environment=p_environment and cl.journey_id=l.journey_id and c.direction='CUSTOMER' and c.occurred_at_utc between m.occurred_at_utc-interval '2 minutes' and m.occurred_at_utc);
 if coalesce(array_length(affected,1),0)>=3 then
   update public.messages set is_automatic=true where id=any(ids) and automatic_override is null;
   foreach journey in array affected loop perform public.panel_refresh_effective_mcs(p_environment,journey); end loop;
   return jsonb_build_object('automatic',true);
 end if;
 return jsonb_build_object('automatic',target.is_automatic);
end $$;

create or replace function public.panel_set_message_automatic(p_environment public.panel_environment,p_message uuid,p_automatic boolean)
returns jsonb language plpgsql security definer set search_path=public as $$
declare journey uuid;
begin
 update public.messages set is_automatic=p_automatic,automatic_override=p_automatic
  where id=p_message and environment=p_environment and direction='MCS' returning id into p_message;
 if not found then raise exception 'MESSAGE_NOT_FOUND'; end if;
 for journey in select journey_id from public.message_journeys where environment=p_environment and message_id=p_message loop perform public.panel_refresh_effective_mcs(p_environment,journey); end loop;
 return jsonb_build_object('updated',true);
end $$;
revoke all on function public.panel_detect_webhook_automatic(public.panel_environment,uuid) from public,anon,authenticated;
revoke all on function public.panel_set_message_automatic(public.panel_environment,uuid,boolean) from public,anon,authenticated;
grant execute on function public.panel_detect_webhook_automatic(public.panel_environment,uuid) to service_role;
grant execute on function public.panel_set_message_automatic(public.panel_environment,uuid,boolean) to service_role;

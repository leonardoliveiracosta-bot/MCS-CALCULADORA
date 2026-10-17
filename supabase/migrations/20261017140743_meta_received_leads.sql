-- Delivery metadata only. A click can never populate this outbox.
create table public.mcs_meta_received_leads (
 id text primary key check(id ~ '^[a-f0-9]{64}$'),
 message_id uuid not null references public.messages(id) on delete cascade,
 logical_mode text not null check(logical_mode in ('VALOR','CARRO')),
 channel text not null check(channel in ('WHATSAPP','SMS')),
 occurred_at timestamptz not null,
 phone_hash text not null check(phone_hash ~ '^[a-f0-9]{64}$'),
 state text not null default 'PENDING' check(state in ('PENDING','SENDING','SENT','FAILED')),
 attempts integer not null default 0,
 claim_id uuid,
 next_at timestamptz not null default now(),
 last_error text,
 sent_at timestamptz,
 created_at timestamptz not null default now()
);
alter table public.mcs_meta_received_leads enable row level security;
revoke all on public.mcs_meta_received_leads from public,anon,authenticated;
grant select,insert,update,delete on public.mcs_meta_received_leads to service_role;
create index mcs_meta_received_pending_idx on public.mcs_meta_received_leads(next_at) where state in ('PENDING','SENDING');

create function public.mcs_meta_received_claim(p_since timestamptz,p_limit integer default 10)
returns setof public.mcs_meta_received_leads
language plpgsql security invoker set search_path='' as $$
begin
 if p_since is null then return; end if;
 -- Recent live messages only. An explicit calculator Ref and a completed,
 -- privacy-enabled paid Meta request must agree with the linked customer.
 insert into public.mcs_meta_received_leads(id,message_id,logical_mode,channel,occurred_at,phone_hash)
 select distinct on (j.id,r.ref,c.dados->>'logical_mode')
   encode(extensions.digest(j.id::text||':'||r.ref||':'||(c.dados->>'logical_mode'),'sha256'),'hex'),
   m.id,c.dados->>'logical_mode',m.channel::text,m.occurred_at_utc,
   encode(extensions.digest(regexp_replace(ch.canonical_key,'[^0-9]','','g'),'sha256'),'hex')
 from public.messages m
 join public.message_journeys mj on mj.message_id=m.id and mj.environment=m.environment and mj.undone_at is null
 join public.journeys j on j.id=mj.journey_id and j.environment=m.environment
 join public.chats ch on ch.id=m.chat_id and ch.environment=m.environment and ch.contact_id=j.contact_id and not ch.is_group
 cross join lateral (
   select min(upper(v[1])) as ref,count(distinct upper(v[1])) as n
   from regexp_matches(m.body_text,'(?:^|[^A-Za-z0-9])Ref:\s*([A-HJ-NP-Z2-9]{5})(?![A-Za-z0-9])','gi') v
 ) r
 cross join lateral (
   select cr.dados from public.calc_runs cr
   where upper(cr.dados->>'ref')=r.ref and not cr.is_test
     and cr.created_at>=p_since and cr.created_at<=m.occurred_at_utc
     and cr.dados->>'formulario_completo'='true'
     and cr.dados->>'meta_measurement_allowed'='true'
     and cr.dados->>'etapa'='contato_iniciado'
     and lower(cr.dados->'atribuicao'->>'utm_source')='meta'
     and cr.dados->>'logical_mode' in ('VALOR','CARRO')
   order by cr.created_at desc,cr.id desc limit 1
 ) c
 where m.environment='production' and m.direction='CUSTOMER' and m.undone_at is null
   and not m.is_edit_marker and not m.is_delete_marker
   and ((m.source_kind='WHATSAPP_WEBHOOK' and m.channel='WHATSAPP') or (m.source_kind='SMS_SHORTCUT' and m.channel='SMS'))
   and m.created_at>=p_since and m.occurred_at_utc>=greatest(p_since,now()-interval '7 days') and m.occurred_at_utc<=now()
   and ch.canonical_key ~ '^(wa|sms):\+[1-9][0-9]{7,14}$'
   and r.n=1 and m.body_text ~* 'My Car Scout'
   and ((c.dados->>'logical_mode'='VALOR' and m.body_text ~* '(maximum bid|lance máximo|oferta máxima)')
     or (c.dados->>'logical_mode'='CARRO' and m.body_text ~* '(search request|year range|mileage range|faixa de anos|rango de años|solicitação de busca|·\s*FIND\s*·)'))
   and (select count(distinct cp.contact_id) from public.contact_phones cp
     where cp.environment='production' and cp.is_current and cp.retired_at is null
       and cp.phone_e164=regexp_replace(ch.canonical_key,'^(wa|sms):',''))=1
   and exists(select 1 from public.contact_phones cp where cp.environment='production' and cp.contact_id=j.contact_id
     and cp.is_current and cp.retired_at is null and cp.phone_e164=regexp_replace(ch.canonical_key,'^(wa|sms):',''))
 order by j.id,r.ref,c.dados->>'logical_mode',m.occurred_at_utc,m.id
 on conflict(id) do nothing;

 update public.mcs_meta_received_leads set state='FAILED',last_error='EXPIRED'
 where state in ('PENDING','SENDING') and (occurred_at<=now()-interval '7 days' or attempts>=12) and next_at<=now();
 return query
 with available as (
   select q.id from public.mcs_meta_received_leads q where q.state in ('PENDING','SENDING') and q.next_at<=now()
   order by q.occurred_at,q.id for update skip locked limit least(greatest(p_limit,1),10)
 )
 update public.mcs_meta_received_leads q set state='SENDING',attempts=q.attempts+1,claim_id=gen_random_uuid(),next_at=now()+interval '2 minutes'
 from available a where q.id=a.id returning q.*;
end $$;
revoke all on function public.mcs_meta_received_claim(timestamptz,integer) from public,anon,authenticated;
grant execute on function public.mcs_meta_received_claim(timestamptz,integer) to service_role;

create function public.mcs_meta_received_finish(p_id text,p_claim uuid,p_accepted boolean,p_error text default null)
returns boolean language plpgsql security invoker set search_path='' as $$
declare changed integer;
begin
 update public.mcs_meta_received_leads q
 set state=case when p_accepted then 'SENT' else 'PENDING' end,
   sent_at=case when p_accepted then now() else null end,
   next_at=now()+make_interval(secs=>least(3600,(60*power(2,least(q.attempts,6)))::integer)),
   last_error=case when p_accepted then null when p_error ~ '^[A-Z0-9_]{1,60}$' then p_error else 'DELIVERY_FAILED' end
 where q.id=p_id and q.claim_id=p_claim and q.state='SENDING';
 get diagnostics changed=row_count;return changed=1;
end $$;
revoke all on function public.mcs_meta_received_finish(text,uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.mcs_meta_received_finish(text,uuid,boolean,text) to service_role;

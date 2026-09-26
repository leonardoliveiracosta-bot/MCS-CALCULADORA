-- Teste: troca de telefone principal em panel_whatsapp_apply_message
-- Pode rodar quantas vezes quiser, no mesmo banco: tudo é desfeito no final (ROLLBACK).
-- Rodar DEPOIS de aplicar as migrações (PGlite ou Postgres 16 local). Nunca no Supabase compartilhado.
--
-- Resultado esperado SEM a 20260926170300: ERRO duplicate key "contact_phones_one_active_primary_idx"
--   vindo de "PL/pgSQL function panel_whatsapp_apply_message".
-- Resultado esperado COM a 20260926170300: NOTICE "OK: numero que escreveu virou principal".
--
-- Cenário: o contato tem 2 telefones. O extra (B, número menor) foi cadastrado antes;
-- o principal (A) veio depois. O cliente escreve pelo WhatsApp do B.
--
-- Postgres puro (fora do Supabase) precisa destes stubs antes das migrações:
--   create role anon; create role authenticated; create role service_role;
--   create schema auth; create schema storage;
--   create function auth.uid() returns uuid language sql as 'select null::uuid';
--   create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
--   create table storage.buckets(id text primary key, name text, public bool, file_size_limit bigint, allowed_mime_types text[], created_at timestamptz, updated_at timestamptz, owner uuid);
--   create table storage.objects(id uuid default gen_random_uuid() primary key, bucket_id text, name text, owner uuid, metadata jsonb);
--   alter table storage.objects enable row level security;
--   create function storage.foldername(name text) returns text[] language sql as $$select string_to_array(name,'/')$$;
--   create table public.calc_runs(id bigserial primary key, created_at timestamptz default now(), zip text, estado text, lance numeric, pagamento text, dados jsonb);
-- Postgres 16 como root: crie um usuário comum e rode initdb/pg_ctl com ele:
--   useradd -m pgtest && su pgtest -c "/usr/lib/postgresql/16/bin/initdb -D /home/pgtest/data -A trust"
--   su pgtest -c "/usr/lib/postgresql/16/bin/pg_ctl -D /home/pgtest/data -o '-p 5499 -k /tmp' -l /home/pgtest/log start"

begin;
do $$
declare c uuid := gen_random_uuid(); r uuid := gen_random_uuid();
  b text := '+1305' || lpad((floor(random()*9000000)+1000000)::int::text,7,'0');
  a text; ok boolean;
begin
  a := '+1305' || lpad((substr(b,6)::int + 1)::text,7,'0'); -- A tem número maior que B
  insert into public.contacts(id,environment,display_name,created_at,updated_at) values(c,'preview','Teste troca',now(),now());
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at) values('preview',c,b,b,true,false,now());
  insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at) values('preview',c,a,a,true,true,now());
  insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json) values(r,'preview','teste-'||r,'messages','{}');
  perform public.panel_whatsapp_apply_message('preview',r,
    jsonb_build_object('phone',b,'messageId','wamid.'||r,'body','oi','direction','CUSTOMER',
      'timestamp',extract(epoch from now())::text,'forceContactId',c));
  select bool_and(is_primary = (phone_e164=b)) into ok from public.contact_phones where contact_id=c;
  if not ok then raise exception 'FALHA: principal errado depois da troca'; end if;
  raise notice 'OK: numero que escreveu virou principal';
end $$;
rollback;

'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
test('finance contact transaction preserves leads, deduplicates, isolates preview and rolls back failures',async t=>{
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create type public.panel_environment as enum('preview','production');
    create table public.panel_users(id uuid primary key,environment panel_environment,active boolean);
    create table public.calc_runs(id uuid primary key,created_at timestamptz default now(),pagamento text,idioma text,origem text,is_test boolean,dados jsonb);`);
  await db.exec(read('supabase/migrations/20261011003328_site_contact_requests.sql'));
  await db.exec(read('supabase/migrations/20261023181105_mcs_finance_contact_capture.sql'));
  const answers={credit_profile:'very_good',down_payment:'2500_5000',monthly_payment:'400_600',trade_in:'yes'};
  const id=n=>'f3eedafa-6b3d-4cca-801c-'+String(n).padStart(12,'0');
  const call=async(n,changes={})=>{
    const v={env:'preview',name:'Finance Test',phone:'+12025550123',language:'en',answers,ip:'a'.repeat(64),...changes};
    return (await db.query('select public.mcs_finance_contact_create($1,$2,$3,$4,$5,$6,$7) result',[v.env,id(n),v.name,v.phone,v.language,JSON.stringify(v.answers),v.ip])).rows[0].result;
  };
  const counts=async()=> (await db.query('select (select count(*)::int from calc_runs) runs,(select count(*)::int from site_contact_requests) contacts')).rows[0];
  try{
    let saved;
    await t.test('both records share the request key and consent, with no fake WhatsApp event',async()=>{
      saved=await call(1);assert.match(saved.ref,/^[A-HJ-NP-Z2-9]{5}$/);assert.deepEqual(await counts(),{runs:1,contacts:1});
      const row=(await db.query('select r.is_test,r.dados,c.name,c.phone_e164,c.channel,c.consent_version from calc_runs r join site_contact_requests c on c.request_key=r.id')).rows[0];
      assert.equal(row.is_test,true);assert.equal(row.dados.ref,saved.ref);assert.equal(row.dados.evento,'contato');assert.equal(row.phone_e164,'+12025550123');assert.equal(row.name,'Finance Test');assert.equal(row.channel,'CALL');assert.equal(row.consent_version,'finance-contact-v1');
    });
    await t.test('retry and refresh return the same Ref; conflicting payload is rejected',async()=>{
      assert.deepEqual(await call(1),saved);assert.deepEqual(await call(2),saved);assert.deepEqual(await counts(),{runs:1,contacts:1});
      await assert.rejects(call(1,{phone:'+12025550124'}),/FINANCE_KEY_CONFLICT/);
    });
    await t.test('preview and production cannot reuse the same key or share a contact queue',async()=>{
      await assert.rejects(call(1,{env:'production'}),/FINANCE_KEY_CONFLICT/);
      const result=await call(3,{env:'production'});assert.notEqual(result.ref,saved.ref);
      assert.equal((await db.query('select is_test from calc_runs where id=$1',[id(3)])).rows[0].is_test,false);
    });
    await t.test('a failed contact write also removes the calculator insert',async()=>{
      await db.exec(`create function reject_test_contact() returns trigger language plpgsql as $$begin if new.name='Reject Test' then raise exception 'TEST_FAILURE';end if;return new;end$$;create trigger reject_test_contact before insert on site_contact_requests for each row execute function reject_test_contact();`);
      const before=await counts();await assert.rejects(call(4,{name:'Reject Test',phone:'+12025550125'}),/TEST_FAILURE/);assert.deepEqual(await counts(),before);
    });
    await t.test('rate limits and invalid answers cannot create partial requests',async()=>{
      await call(5,{answers:{...answers,trade_in:'no'}});await call(6,{answers:{...answers,credit_profile:'good'}});
      const before=await counts();await assert.rejects(call(7,{answers:{...answers,credit_profile:'building'}}),/FINANCE_RATE_LIMIT/);await assert.rejects(call(8,{answers:{}}),/FINANCE_INVALID/);assert.deepEqual(await counts(),before);
    });
    await t.test('only the service role can call the new function; existing contact API still works',async()=>{
      const perms=(await db.query("select has_function_privilege('anon','public.mcs_finance_contact_create(panel_environment,uuid,text,text,text,jsonb,text)','execute') anon,has_function_privilege('authenticated','public.mcs_finance_contact_create(panel_environment,uuid,text,text,text,jsonb,text)','execute') authenticated,has_function_privilege('service_role','public.mcs_finance_contact_create(panel_environment,uuid,text,text,text,jsonb,text)','execute') service")).rows[0];
      assert.deepEqual(perms,{anon:false,authenticated:false,service:true});
      await db.query("select public.site_contact_request_create('preview',$1,'Regular Contact','+12025550190','CALL','en','footer',$2)",[id(9),'b'.repeat(64)]);
    });
  }finally{await db.close();}
});

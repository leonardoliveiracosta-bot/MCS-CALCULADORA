'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {migratedDatabase}=require('./sql/run');
test('AI accounting migration preserves provenance, repairs only V2 unit errors and counts each cost once',async()=>{
  const {db}=await migratedDatabase({before:'20261101030000'});
  try{
    await db.exec(`insert into public.openai_budget_holds(id,environment,feature,subject,model,amount_usd,actual_usd,status) values
      ('00000000-0000-4000-8000-000000000001','production','V2_DRAFT','old','gpt-6-luna',0.001312,155.5,'REGISTRADA'),
      ('00000000-0000-4000-8000-000000000002','production','V2_DRAFT','new','gpt-6-luna',0.001312,0.0002,'REGISTRADA'),
      ('00000000-0000-4000-8000-000000000003','production','ASSISTENTE','paid','gpt-6-luna',0.003,0.001,'PAGA'),
      ('00000000-0000-4000-8000-000000000004','production','ASSISTENTE','registered','gpt-6-luna',0.003,0.002,'REGISTRADA'),
      ('00000000-0000-4000-8000-000000000005','production','MANHEIM_CSV','untouched','gpt-6-luna',0.001312,155.5,'LIBERADA');
      insert into public.audit_log(environment,entity_type,action,after_json) values
      ('production','v2_draft_openai','DRAFT','{"costUsd":0.0002,"budgetHoldId":"00000000-0000-4000-8000-000000000002"}'),
      ('production','unlock_sale_openai','UNLOCK','{"costUsd":0.0003}');`);
    const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261101030000_ia_efficiency.sql'),'utf8');
    for(let run=0;run<2;run++){
      await db.exec(migration);
      const {rows}=await db.query(`select
        (select actual_usd from public.openai_budget_holds where subject='old')::text repaired,
        (select actual_usd from public.openai_budget_holds where subject='untouched')::text untouched,
        (select before_json->>'actualUsd' from public.audit_log where entity_type='ai_cost_correction') original,
        (select count(*) from public.audit_log where entity_type='v2_draft_openai') drafts,
        (public.panel_ai_balance_state('production','OPENAI')->>'spent')::numeric spent,
        has_function_privilege('anon','public.panel_openai_spent_usd(public.panel_environment)','EXECUTE') anon_access`);
      assert.equal(Number(rows[0].repaired),0.000156);assert.equal(Number(rows[0].untouched),155.5);
      assert.equal(Number(rows[0].original),155.5);assert.equal(Number(rows[0].drafts),2);
      assert.equal(Number(rows[0].spent),0.003656);assert.equal(rows[0].anon_access,false);
    }
  }finally{await db.close();}
});

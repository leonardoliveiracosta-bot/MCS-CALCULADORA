'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {migratedDatabase}=require('./run');
const plan=require('../../purchase-plan');
(async()=>{
  const {db}=await migratedDatabase();
  try{
    const sql=fs.readFileSync(require.resolve('../../supabase/changes/commercial-message-compat.sql'),'utf8');
    const before=(await db.query("select proname,proacl::text acl,prosecdef,provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('panel_calc_template_text','panel_identity_evidence','panel_journey_explicit_refs') order by proname")).rows;
    await db.exec(sql);
    const after=(await db.query("select proname,proacl::text acl,prosecdef,provolatile from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('panel_calc_template_text','panel_identity_evidence','panel_journey_explicit_refs') order by proname")).rows;
    assert.deepEqual(after,before,'recognition update must preserve privileges and function security');
    for(const lang of ['en','es','pt']){
      const message=plan.message({nome:'Example Buyer',marca:'Toyota',modelo:'Camry',anoDe:2020,anoAte:2025,trim:'XSE',milhasAte:60000,lance:20000,pgto:'cash',zip:'33470',prazo:'now',ref:'H2DVX'},null,lang);
      const result=await db.query('select public.panel_calc_template_text($1) as matched',[message]);
      assert.equal(result.rows[0].matched,true,lang);
    }
    for(const marker of ['Maximum bid','Lance máximo','Oferta máxima'])assert.equal((await db.query('select public.panel_calc_template_text($1) as matched',['My Car Scout\n'+marker+': $20,000\nRef: H2DVX'])).rows[0].matched,true);
    assert.equal((await db.query("select public.panel_calc_template_text('My Car Scout hello') as matched")).rows[0].matched,false);
    const definitions=async()=>(await db.query("select proname,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname in ('panel_calc_template_text','panel_identity_evidence','panel_journey_explicit_refs') order by proname")).rows;
    const firstDefinitions=await definitions();
    await db.exec(sql); // Idempotent replay cannot duplicate prefixes or alter unrelated definitions.
    assert.deepEqual(await definitions(),firstDefinitions,'replaying must not duplicate recognition patterns');
    console.log('PASS: commercial messages recognized in EN/ES/PT, historic templates retained, privileges unchanged, replay safe');
  }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});

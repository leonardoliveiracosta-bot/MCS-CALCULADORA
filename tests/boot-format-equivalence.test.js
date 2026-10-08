'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const baseline = process.env.PANEL_PERF_BASELINE;
Object.assign(process.env,{VERCEL_ENV:'preview',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_PUBLISHABLE_KEY:'publica-simulada',SUPABASE_SECRET_KEY:'secreta-simulada',ENTRADA_OPENAI_ENABLED:'0',MANHEIM_OPENAI_ENABLED:'0',MANHEIM_MATCH_AUDIT_ENABLED:'0'});
const {createBackend} = require('./fixtures/banco-simulado');
const demo = require('./fixtures/caso-demonstracao');
async function boot(root, body) {
  const res={statusCode:200,setHeader(){},status(code){this.statusCode=code;return this},json(value){this.payload=value;return value},end(){}};
  await require(path.join(root,'api/panel/boot'))({method:'POST',url:'/api/panel/boot',headers:{authorization:'Bearer token-simulado'},body},res);
  assert.equal(res.statusCode,200);
  return res.payload;
}
test('abertura inteira A/B/A: mesmos corpos, hashes, grupos e contagens com SMS sem data e tabelas paginadas', {skip:!baseline}, async()=>{
  const backend=await createBackend({seed:demo.seed,maxRows:1000,nativeJsonRows:true});
  const originalFetch=global.fetch, RealDate=Date;
  global.fetch=(url,options)=>backend.fetch(url,options);
  const fixed=RealDate.parse('2026-10-08T05:40:00Z');
  global.Date=class extends RealDate {constructor(...args){super(...(args.length?args:[fixed]))}static now(){return fixed}};
  try {
    await backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,original_datetime_text,signature_base,occurrence_index,source_kind,created_at)
      values('6f000000-0000-4000-8000-000000000001','preview','${demo.IDS.CHAT}','SMS','CUSTOMER','Print fictício sem data','print',null,true,'data original desconhecida','format-unknown',1,'SMS_PRINT','2026-10-08T04:00:00Z');
      insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','6f000000-0000-4000-8000-000000000001','${demo.IDS.JOURNEY}','IMPORT',now());
      insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
      select 'preview','${demo.IDS.CHAT}','WHATSAPP','CUSTOMER','Histórico fictício','histórico','2026-09-01T00:00:00Z','format-history-'||n,1,'IMPORT','2026-09-01T00:00:00Z' from generate_series(1,1100)n;
      insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at)
      select 'preview',id,'${demo.IDS.JOURNEY}','IMPORT',now() from public.messages where signature_base like 'format-history-%';
      insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados,is_test)
      select '2026-09-01T00:00:00Z',zip,estado,lance,pagamento,dados,is_test from public.calc_runs cross join generate_series(1,200)n;`);
    const roots=[path.resolve(baseline),path.resolve(__dirname,'..')];
    // Existing saved keys, unrelated keys, disabled saves and another environment
    // must produce the same badges when the whole-panel read starts earlier.
    const stage=await require(path.join(roots[0],'panel-search-stage')).loadSearchStageIndex({environment:'preview',config:{url:'http://banco-simulado.local',secretKey:'test'}});
    const keys=[...new Set([...stage.values()].flatMap(row=>Object.values(row.modes||{}).map(mode=>mode.searchKey)).filter(Boolean))];
    assert.ok(keys.length,'fixture includes active search keys');
    await backend.db.query(`insert into public.manheim_saved_searches(environment,search_key,created,updated_at,updated_by)
      select 'preview',value,true,'2026-09-01T00:00:00Z',id from jsonb_array_elements_text($1::jsonb),public.panel_users limit 100`,[JSON.stringify(keys)]);
    await backend.db.exec(`insert into public.manheim_saved_searches(environment,search_key,created,updated_by)
      select 'preview','unrelated-key',true,id from public.panel_users limit 1;
      insert into public.manheim_saved_searches(environment,search_key,created,updated_by)
      select 'preview','disabled-key',false,id from public.panel_users limit 1;
      insert into public.manheim_saved_searches(environment,search_key,created,updated_by)
      select 'production','unrelated-production-key',true,id from public.panel_users limit 1;`);
    for(const body of [{part:'main',sort:'ready',page:{limit:10000},includeCounters:true},{part:'main',sort:'recent',page:{limit:30,ref:'without'},includeCounters:true},{part:'main',sort:'ready',page:{limit:10000,stat:'late24'}},{part:'counters',summary:true}]) {
      const a=await boot(roots[0],body), b=await boot(roots[1],body), again=await boot(roots[0],body);
      assert.deepEqual(again,a,'controle A/A');
      if (body.part === 'main' && body.page && !body.includeCounters && a.parts.pesquisas) {
        const {pesquisas, ...oldParts} = a.parts;
        const {completing, ...newParts} = b.parts;
        assert.deepEqual(newParts,oldParts,'fila inteira idêntica sem esperar os resultados do lote');
        assert.deepEqual(completing.body.items,pesquisas.body.items,'mesmos pedidos incompletos');
        assert.equal(completing.body.requestsPending,pesquisas.body.requestsPending);
      } else assert.deepEqual(b,a,'mesmos dados sem normalizar datas/números');
    }
    assert.equal(backend.refused.length,0);
  } finally {global.Date=RealDate;global.fetch=originalFetch;await backend.db.close();}
});

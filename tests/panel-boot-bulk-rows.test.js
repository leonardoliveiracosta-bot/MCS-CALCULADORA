'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createBackend } = require('./fixtures/banco-simulado');
const demo = require('./fixtures/caso-demonstracao');
const { allRows } = require('../panel-server');
let backend, originalFetch;
const ctx = () => ({ environment: 'preview', config: { url: 'http://banco-simulado.local', secretKey: 'test' }, bootBulkRows: true, readCache: new Map() });
test.before(async () => {
  backend = await createBackend({ seed: demo.seed, maxRows: 1000, nativeJsonRows: true });
  originalFetch = global.fetch; global.fetch = (url, options) => backend.fetch(url, options);
  await backend.db.exec(`insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,original_datetime_text,signature_base,occurrence_index,source_kind,created_at)
    select 'preview','${demo.IDS.CHAT}','SMS','CUSTOMER','Print fictício sem data','print',null,true,'data original desconhecida','bulk-unknown-'||n,1,'SMS_PRINT','2026-10-08T04:00:00.123456Z' from generate_series(1,7)n;
    insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
    select 'preview','${demo.IDS.CHAT}','WHATSAPP','CUSTOMER','Histórico fictício','histórico','2026-09-01T00:00:00.123456Z','bulk-history-'||n,1,'IMPORT','2026-09-01T00:00:00.123456Z' from generate_series(1,1100)n;
    insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados,is_test)
    select '2026-09-01T00:00:00.123456Z',zip,estado,lance,pagamento,dados,is_test from public.calc_runs cross join generate_series(1,200)n;`);
});
test.after(async () => { global.fetch = originalFetch; if (backend) await backend.db.close(); });
test('leituras inteiras preservam campos, ordem, microssegundos e sete SMS sem data', async () => {
  for (const [table, params] of [
    ['messages', { select: 'id,created_at,body_text', environment: 'eq.preview', order: 'created_at.desc.nullslast,id.asc' }],
    ['calc_runs', { select: 'created_at,dados,is_test', order: 'created_at.asc' }]
  ]) {
    const a = await allRows({ ...ctx(), bootBulkRows: false }, table, params);
    const start = backend.calls.length;
    const b = await allRows(ctx(), table, params);
    assert.deepEqual(b, a);
    assert.ok(b.length > 1000);
    assert.equal(backend.calls.slice(start).length, 1);
    assert.equal(backend.calls.at(-1).path, '/rest/v1/rpc/panel_boot_table_rows');
    if (table === 'messages') {
      assert.equal(b.filter(row => row.date_unknown && row.created_at === null).length, 7);
      assert.ok(b.some(row => String(row.created_at).includes('.123456')));
      assert.equal(b.some(row => 'source_kind' in row || 'original_datetime_text' in row), false);
    } else assert.equal(b.some(row => 'id' in row), false);
  }
});
test('filtros específicos e contexto fora da abertura mantêm as leituras antigas', async () => {
  for (const [context, table, params] of [
    [ctx(), 'messages', { select: 'id', environment: 'eq.preview', direction: 'eq.MCS' }],
    [ctx(), 'calc_runs', { select: 'id', is_test: 'eq.false' }],
    [{ ...ctx(), bootBulkRows: false }, 'messages', { select: 'id', environment: 'eq.preview' }]
  ]) {
    const start = backend.calls.length;
    await allRows(context, table, params);
    assert.ok(backend.calls.slice(start).every(call => call.path === '/rest/v1/' + table));
  }
});
test('mesma projeção é compartilhada só na abertura, com cópias isoladas', async () => {
  const context = ctx(), params = { select: 'id,body_text', environment: 'eq.preview' }, start = backend.calls.length;
  const [a,b] = await Promise.all([allRows(context,'messages',params),allRows(context,'messages',params)]);
  assert.equal(backend.calls.slice(start).length,1);
  a[0].body_text = 'alterado apenas em memória';
  assert.notEqual(a[0].body_text,b[0].body_text);
  assert.deepEqual(await allRows(context,'messages',params),b);
});
test('permissões e lista de tabelas/colunas bloqueiam ampliação de acesso', async () => {
  const { rows } = await backend.db.query(`select p.prosecdef, p.provolatile,
    has_function_privilege('anon', p.oid, 'EXECUTE') anon,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') authenticated,
    has_function_privilege('service_role', p.oid, 'EXECUTE') service
    from pg_proc p where p.oid='public.panel_boot_table_rows(public.panel_environment,text,text[])'::regprocedure`);
  assert.deepEqual(rows,[{prosecdef:false,provolatile:'s',anon:false,authenticated:false,service:true}]);
  for (const [table,columns] of [['panel_users',['id']],['messages',['missing_column']],['messages',['*']],['messages',['id);drop table messages;--']],['messages',[]],['messages',[null]]]) {
    await assert.rejects(backend.db.query('select public.panel_boot_table_rows($1,$2,$3)', ['preview',table,columns]), /INVALID_BOOT_/);
  }
  const production = await backend.db.query("select public.panel_boot_table_rows('production','messages',array['id']) rows");
  assert.deepEqual(production.rows[0].rows,[]);
});
test('RPC ausente após reversão conserva todas as linhas; demais erros são propagados', async () => {
  const params={select:'id',environment:'eq.preview'}, a=await allRows({...ctx(),bootBulkRows:false},'messages',params);
  const real=global.fetch;
  try {
    global.fetch=(url,options)=>String(url).endsWith('/rpc/panel_boot_table_rows') ? Promise.resolve({ok:false,status:404,text:async()=>''}) : real(url,options);
    assert.deepEqual(await allRows(ctx(),'messages',params),a);
    global.fetch=(url,options)=>String(url).endsWith('/rpc/panel_boot_table_rows') ? Promise.resolve({ok:false,status:503,text:async()=>''}) : real(url,options);
    await assert.rejects(allRows(ctx(),'messages',params),{message:'SUPABASE_REQUEST_FAILED',status:503});
  } finally { global.fetch=real; }
});

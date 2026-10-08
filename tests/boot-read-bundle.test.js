'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const demo = require('./fixtures/caso-demonstracao');
const server = require('../panel-server');
const { readBundle, BUNDLES } = require('../panel-boot-reads');
// PGlite represents numeric cells as strings; PostgREST JSON represents them as numbers.
const normalize = value => JSON.parse(JSON.stringify(value, (_key, item) => _key === 'lance' && item !== null ? Number(item) : typeof item === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/.test(item) ? new Date(item).toISOString() : item));
let backend, originalFetch;
const ctx = { config: { url: BASE, secretKey: 'simulado' }, environment: 'preview' };
test.before(async () => {
  backend = await createBackend({ seed: demo.seed, maxRows: 1000 });
  originalFetch = global.fetch; global.fetch = backend.fetch;
  await backend.db.exec(`insert into public.contacts(environment, display_name, source, created_at, updated_at) select 'preview', 'Contato ' || n, 'WHATSAPP_DIRECT', now(), now() from generate_series(1,1105) n;
    insert into public.contacts(environment, display_name, source, created_at, updated_at) values ('production','Outro ambiente','WHATSAPP_DIRECT',now(),now());
    insert into public.calc_runs(created_at, dados) select '2026-01-01T01:02:03Z'::timestamptz, jsonb_build_object('ref','EXTRA','evento','simulacao','sid',n::text) from generate_series(1,1105) n;`);
});
test.after(async () => { global.fetch = originalFetch; await backend.db.close(); });
for (const name of ['operational', 'buscas']) test('leitura conjunta ' + name + ': todas as linhas e colunas na mesma ordem das consultas antigas, acima de 1000', async () => {
  const expected = await Promise.all(BUNDLES[name](ctx).map(([table, params]) => server.allRows(ctx, table, params)));
  const start = backend.calls.length;
  const boot = { ...ctx, readCache: new Map() };
  const [actual, second] = await Promise.all([readBundle(boot, name), readBundle(boot, name)]);
  assert.deepEqual(normalize(actual), normalize(expected));
  assert.ok(actual[1].length > 1000);
  assert.ok(actual[1].every(row => row.display_name !== 'Outro ambiente'));
  const calls = backend.calls.slice(start);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/rest/v1/rpc/panel_boot_read_bundle');
  actual[1][0].display_name = 'alterado';
  assert.notEqual(second[1][0].display_name, 'alterado', 'cada consumidor recebe uma cópia');
});
test('leitura conjunta indisponível ou incompleta: volta às consultas completas atuais', async () => {
  const expected = await readBundle(ctx, 'operational');
  for (const response of [null, { version: 1, rows: [[]] }]) {
    const start = backend.calls.length;
    global.fetch = async (url, options) => String(url).includes('/rpc/panel_boot_read_bundle') ? { ok: true, status: 200, json: async () => response, text: async () => JSON.stringify(response) } : backend.fetch(url, options);
    const actual = await readBundle({ ...ctx, readCache: new Map() }, 'operational');
    assert.deepEqual(normalize(actual), normalize(expected));
    assert.ok(backend.calls.length - start >= 13);
  }
  global.fetch = backend.fetch;
});
test('leitura conjunta: somente service_role pode executar, sem SECURITY DEFINER', async () => {
  const result = (await backend.db.query(`select p.prosecdef,
    has_function_privilege('anon', p.oid, 'EXECUTE') a,
    has_function_privilege('authenticated', p.oid, 'EXECUTE') u,
    has_function_privilege('service_role', p.oid, 'EXECUTE') s
    from pg_proc p where proname='panel_boot_read_bundle'`)).rows[0];
  assert.deepEqual(result, { prosecdef: false, a: false, u: false, s: true });
});
test('HOJE e etapas compartilham apenas a consulta idêntica: outra projeção ou filtro usa a leitura original', async () => {
  const { readBootSource } = require('../panel-boot-reads');
  const boot = { ...ctx, readCache: new Map() };
  const [table, params] = BUNDLES.buscas(ctx)[5];
  const start = backend.calls.length;
  const [source, bundle] = await Promise.all([readBootSource(boot, table, params), readBundle(boot, 'buscas')]);
  assert.deepEqual(source, bundle[5]);
  assert.equal(backend.calls.length - start, 1);
  source.pop(); assert.notEqual(source.length, bundle[5].length);
  const filtered = await readBootSource(boot, table, { ...params, id: 'eq.1' });
  assert.equal(filtered.length, 1);
  assert.equal(backend.calls.at(-1).path, '/rest/v1/calc_runs');
});
test('boot real: transporte novo e consultas anteriores entregam a mesma página, casos, grupos, filtros e contadores', async () => {
  const handler = require('../api/panel/boot');
  const boot = async () => {
    const res = { statusCode: 200, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
    await handler({ method: 'POST', __mcsCtx: { ...ctx, panel: { id: demo.IDS.ACTOR, role: 'admin' } }, body: { part: 'main', includeCounters: true, sort: 'recent', page: { limit: 10000, ref: 'all' } } }, res);
    assert.equal(res.statusCode, 200);
    return Object.fromEntries(Object.entries(res.payload.parts).map(([name, part]) => {
      assert.equal(part.ok, true, name);
      const body = name === 'today' ? { ...part.body, items: part.order.map(key => part.items[key]) } : part.body;
      return [name, body];
    }));
  };
  const real = global.fetch;
  global.fetch = async (url, options) => String(url).includes('/rpc/panel_boot_read_bundle') ? { ok: false, status: 404, text: async () => '{}' } : real(url, options);
  const old = await boot();
  global.fetch = real;
  const current = await boot();
  // Ignore only the reading timestamp and elapsed wait; all saved information is compared.
  const stable = value => normalize(JSON.parse(JSON.stringify(value, (key, item) => ['generatedAt','dataUpdatedAt','waitedMs'].includes(key) ? undefined : item)));
  assert.deepEqual(stable(current), stable(old));
  assert.ok(backend.calls.every(call => call.method === 'GET' || call.path.startsWith('/rest/v1/rpc/')), 'nenhuma gravação em tabela');
});

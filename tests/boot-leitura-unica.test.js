'use strict';

// Abertura do painel: as funções pesadas do lote (resumo, seleção, carros) rodam uma vez por /api/panel/boot,
// mesmo quando PESQUISAS e ENVIAR OPÇÕES pedem a mesma coisa; e começam junto com a leitura da base (não depois).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const server = require('../panel-server');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const ctx = { config: { url: 'https://example.test', secretKey: 'test' }, environment: 'production' };

async function withFetch(answer, work) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => { calls.push({ url, body: options && options.body }); return { ok: true, status: 200, json: async () => answer(url), text: async () => JSON.stringify(answer(url)) }; };
  try { await work(calls); } finally { global.fetch = original; }
}

test('dentro do boot: a mesma função com os mesmos argumentos vai ao banco uma vez e cada um recebe sua cópia', async () => {
  await withFetch(() => [{ demand_key: 'journey:a:VALOR', match_count: 3 }], async (calls) => {
    const boot = { ...ctx, readCache: new Map() };
    const args = { p_environment: 'production', p_upload_id: 'u1' };
    const [first, second] = await Promise.all([server.readRpc(boot, 'panel_manheim_batch_summary_v2', args), server.readRpc(boot, 'panel_manheim_batch_summary_v2', args)]);
    assert.equal(calls.length, 1);
    assert.deepEqual(first, second);
    first[0].match_count = 99;
    assert.equal(second[0].match_count, 3);
    // Other arguments are another read.
    await server.readRpc(boot, 'panel_manheim_batch_summary_v2', { ...args, p_upload_id: 'u2' });
    assert.equal(calls.length, 2);
  });
});

test('caminho comum fora do boot: cada chamada vai ao banco, como antes (nada guardado entre pedidos)', async () => {
  await withFetch(() => [], async (calls) => {
    await server.readRpc(ctx, 'panel_manheim_offer_summary', { p_upload_id: 'u1' });
    await server.readRpc(ctx, 'panel_manheim_offer_summary', { p_upload_id: 'u1' });
    assert.equal(calls.length, 2);
    assert.equal(ctx.readCache, undefined);
  });
});

test('ENVIAR OPÇÕES e PESQUISAS: as leituras do lote usam a leitura única e começam junto com a base', () => {
  const view = read('panel-buscas-view.js');
  assert.match(view, /async function batchSummary\(ctx, uploadId, call = readRpc, overviewRead = null\)/);
  assert.match(view, /readRpc\(ctx, 'panel_manheim_batch_overview'/);
  // Before the migration, the three functions answer as before.
  assert.match(view, /readRpc\(ctx, 'panel_manheim_offer_summary'/);
  assert.match(view, /readRpc\(ctx, 'panel_manheim_batch_cars'/);
  // The batch reads start before the base is awaited.
  const body = view.slice(view.indexOf('async function manheimView'));
  assert.ok(body.indexOf('const batchReads =') < body.indexOf("timed('base', loadBuscasBase"));
  const pesquisas = read('api/panel/pesquisas.js');
  const build = pesquisas.slice(pesquisas.indexOf('async function buildList'));
  assert.ok(build.indexOf('const summaryRead = uploadRead.then') < build.indexOf('loadBuscasBase(ctx, { allRows })'));
});

test('ficha: o resumo do lote usa a visão que o painel já tem (60 s) e só relê depois de "Atualizar"', () => {
  const js = read('painel/painel.js');
  const summary = js.slice(js.indexOf('async function renderFichaOffersSummary'), js.indexOf('// ===== Opções do cliente · PDF e V1 ====='));
  assert.match(summary, /fresh \? request\('\/api\/panel\/records\?view=manheim'\) : sharedGet\('\/api\/panel\/records\?view=manheim', 60000\)/);
  assert.match(summary, /renderFichaOffersSummary\(container, \{ journeyId, ref, kind, key \}, true\)/);
});

// panel-buscas-view loaded with a simulated database function call (nothing reaches a database).
function viewWith(rpc) {
  const root = path.join(__dirname, '..'), file = path.join(root, 'panel-buscas-view.js'), mod = { exports: {} };
  const mocks = { './panel-server': { ...server, rpc } };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(root, name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  return mod.exports;
}

test('visão única do lote: o resumo sai da chamada única; PESQUISAS e ENVIAR OPÇÕES dividem a mesma chamada no boot', async () => {
  const calls = [];
  const overview = { summary: [{ demand_key: 'journey:a:VALOR', match_count: 3 }], offer: [], cars: [] };
  const view = viewWith(async (_ctx, name) => { calls.push(name); return overview; });
  const boot = { ...ctx, readCache: new Map() };
  const [first, second] = await Promise.all([view.batchSummary(boot, 'u1'), view.batchSummary(boot, 'u1')]);
  assert.deepEqual(first, overview.summary);
  assert.deepEqual(second, overview.summary);
  assert.deepEqual(calls, ['panel_manheim_batch_overview']);
});

test('visão única ainda não aplicada no banco: o resumo vem da função de antes, como sempre', async () => {
  const calls = [];
  const view = viewWith(async (_ctx, name) => {
    calls.push(name);
    if (name === 'panel_manheim_batch_overview') throw Object.assign(new Error('Could not find the function'), { code: 'PGRST202' });
    return [{ demand_key: 'journey:a:VALOR', match_count: 2 }];
  });
  assert.deepEqual(await view.batchSummary(ctx, 'u1'), [{ demand_key: 'journey:a:VALOR', match_count: 2 }]);
  assert.deepEqual(calls, ['panel_manheim_batch_overview', 'panel_manheim_batch_summary_v2']);
});

test('PESQUISAS: os pedidos lidos das conversas carregam junto com a base, e as mensagens de prova em páginas paralelas', () => {
  const pesquisas = read('api/panel/pesquisas.js');
  const build = pesquisas.slice(pesquisas.indexOf('async function buildList'));
  assert.ok(build.indexOf("const conversationRead = timed('conversation', loadConversationRequests(ctx))") < build.indexOf('loadBuscasBase(ctx, { allRows })'));
  const load = pesquisas.slice(pesquisas.indexOf('async function loadConversationRequests'));
  assert.match(load, /const \[stored, versionRows, contactRows\] = await Promise\.all\(\[/);
  assert.match(load, /pages\.slice\(index, index \+ MESSAGE_PAGES_AT_ONCE\)\.map/);
  // Same pages of 100 ids as before (the URL size of each read does not change).
  assert.match(load, /pages\.push\(ids\.slice\(index, index \+ 100\)\)/);
});

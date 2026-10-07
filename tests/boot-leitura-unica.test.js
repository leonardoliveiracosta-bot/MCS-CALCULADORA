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
  assert.match(view, /async function batchSummary\(ctx, uploadId, call = readRpc\)/);
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

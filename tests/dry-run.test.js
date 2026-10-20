'use strict';
// Modo simulação (dryRun): nada é gravado nem enviado, leituras passam, e o modo vale para o resto do
// pedido (inclusive depois do await do requirePanel). Pedido sem o cabeçalho: caminho comum intacto.
const test = require('node:test');
const assert = require('node:assert/strict');

const calls = [];
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: String(init.method || 'GET').toUpperCase() }); return { ok: true, status: 200, text: async () => '[]', json: async () => [] }; };
const dryRun = require('../panel-dry-run');
const { send } = require('../panel-server');

// Igual ao requirePanel: begin no começo síncrono de uma função async chamada com await.
async function requireLike(req) { dryRun.begin(req); await new Promise((resolve) => setTimeout(resolve, 1)); return { ok: true }; }
const fakeRes = () => ({ headers: {}, statusCode: 200, body: null, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('pedido comum (sem cabeçalho): gravação e envio seguem direto, sem passo novo', async () => {
  calls.length = 0;
  await dryRun.storage.run(undefined, async () => {
    await requireLike({ headers: {} });
    await fetch('https://x.supabase.co/rest/v1/journeys', { method: 'PATCH' });
    await fetch('https://graph.facebook.com/v26.0/123/messages', { method: 'POST' });
    const res = fakeRes(); send(res, 200, { ok: 1 });
    assert.deepEqual(res.body, { ok: 1 });
  });
  assert.equal(calls.length, 2);
});

test('dryRun: leitura passa, gravação, função que grava e envio externo param sem sair do servidor', async () => {
  calls.length = 0;
  await dryRun.storage.run(undefined, async () => {
    await requireLike({ headers: { 'x-mcs-dry-run': '1' } });
    assert.equal(dryRun.active(), true, 'o modo continua depois do await');
    await fetch('https://x.supabase.co/rest/v1/journeys?id=eq.1');
    await fetch('https://x.supabase.co/rest/v1/rpc/panel_manheim_demand_options', { method: 'POST' });
    await assert.rejects(fetch('https://x.supabase.co/rest/v1/journeys', { method: 'PATCH' }), { code: 'DRY_RUN_STOP' });
    await assert.rejects(fetch('https://x.supabase.co/rest/v1/rpc/panel_set_journey_enabled', { method: 'POST' }), { code: 'DRY_RUN_STOP' });
    await assert.rejects(fetch('https://graph.facebook.com/v26.0/123/messages', { method: 'POST' }), { code: 'DRY_RUN_STOP' });
    assert.equal(dryRun.guard('push do painel'), true);
    const res = fakeRes(); send(res, 500, { error: 'X' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.dryRun, true);
    assert.equal(res.body.wouldDo.length, 4);
    assert.deepEqual(res.body.wouldDo[2], { tipo: 'envio_externo', alvo: 'graph.facebook.com', metodo: 'POST' });
  });
  assert.deepEqual(calls.map((c) => c.method), ['GET', 'POST'], 'só a leitura e a função que só lê saíram');
});

test('dryRun: recusa de validação volta como recusa, marcada como simulação', async () => {
  await dryRun.storage.run(undefined, async () => {
    await requireLike({ headers: { 'x-mcs-dry-run': '1' } });
    const res = fakeRes(); send(res, 400, { error: 'JOURNEY_INVALID' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'JOURNEY_INVALID');
    assert.equal(res.body.dryRun, true);
  });
});

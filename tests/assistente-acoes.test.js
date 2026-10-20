'use strict';
// Execução das propostas do assistente pelas rotas que o painel já usa: envio da V1 só pelo clique e só dentro
// da janela de 24 h (fora dela, só o link do WhatsApp para o Leo enviar), V1 montada pelo caminho normal
// (seleciona e cria), anexo conferido byte a byte, registro de rotas e dreno de logs da Vercel.
process.env.VERCEL_ENV = 'preview';
process.env.SUPABASE_URL = 'https://mock.supabase';
process.env.SUPABASE_SECRET_KEY = 'sb-secreta-teste';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createFake } = require('./support/fake-postgrest');
const routes = require('../panel-assistant-routes');
const exec = require('../panel-assistant-exec');

const PANEL = '55555555-5555-4555-8555-555555555555';
const JID = '11111111-1111-4111-8111-111111111111';
const ctx = { environment: 'preview', config: { url: 'https://mock.supabase', secretKey: 'k' }, panel: { id: PANEL } };
function setup(proposal, tables = {}) {
  const fake = createFake({ panel_assistant_proposals: [{ id: '99999999-9999-4999-8999-999999999999', environment: 'preview', created_by: PANEL, status: 'PENDENTE', expires_at: new Date(Date.now() + 600000).toISOString(), ...proposal }], ...tables });
  globalThis.fetch = fake.fetchImpl;
  const calls = [];
  const fakeRoute = (handler) => async (c, name, options = {}) => { calls.push({ name, body: options.body, query: options.query }); return handler(name, options.body || {}, options); };
  return { fake, calls, fakeRoute };
}
async function withRoutes(handler, run) {
  const original = { call: routes.call, must: routes.must };
  routes.call = async (c, name, options = {}) => ({ status: 200, body: await handler(name, options.body || {}, options) });
  routes.must = async (c, name, options = {}) => { const body = await handler(name, options.body || {}, options); if (body && body.error) throw Object.assign(new Error(body.error), { code: body.error }); return body; };
  try { return await run(); } finally { routes.call = original.call; routes.must = original.must; }
}

test('enviar V1: dentro da janela, envia pelo v1-send com a chave da proposta; uma vez só', async () => {
  const { fake } = setup({ kind: 'send_v1', params: { journeyId: JID, token: 'TOK123', demandKey: `journey:${JID}:VALOR`, direct: true, resend: false } });
  const seen = [];
  await withRoutes(async (name, body) => {
    seen.push({ name, action: body.action, requestKey: body.requestKey, confirmed: body.confirmed });
    if (body.action === 'prepare') return { eligible: true, windowOpen: true, mode: 'LIVE', text: 'Hi Maria, link /v/TOK123', whatsappLink: 'https://wa.me/1?text=x' };
    if (body.action === 'send') return { sendStatus: 'SENT', simulated: false };
    return {};
  }, async () => {
    const out = await exec.confirm(ctx, { id: '99999999-9999-4999-8999-999999999999', baseUrl: 'https://www.mycarscout.net' });
    assert.equal(out.ok, true);
    assert.equal(out.text, 'V1 enviada pelo WhatsApp');
    const again = await exec.confirm(ctx, { id: '99999999-9999-4999-8999-999999999999', baseUrl: 'https://www.mycarscout.net' });
    assert.equal(again.code, 'PROPOSAL_USED');
  });
  const sends = seen.filter((s) => s.action === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].requestKey, '99999999-9999-4999-8999-999999999999');
  assert.equal(sends[0].confirmed, true);
  assert.equal(fake.db.panel_assistant_proposals[0].status, 'FEITA');
});

test('enviar V1: fora da janela de 24 h não envia; devolve o link do WhatsApp para o Leo enviar', async () => {
  setup({ kind: 'send_v1', params: { journeyId: JID, token: 'TOK123', demandKey: `journey:${JID}:CARRO`, direct: true } });
  const seen = [];
  await withRoutes(async (name, body) => { seen.push(body.action); return body.action === 'prepare' ? { eligible: true, windowOpen: false, mode: 'LIVE', text: 'Hi', whatsappLink: 'https://wa.me/19544785595?text=Hi' } : { sendStatus: 'SENT' }; }, async () => {
    const out = await exec.confirm(ctx, { id: '99999999-9999-4999-8999-999999999999', baseUrl: 'https://www.mycarscout.net' });
    assert.equal(out.whatsappLink, 'https://wa.me/19544785595?text=Hi');
    assert.match(out.text, /Fora da janela de 24 h/);
  });
  assert.deepEqual(seen, ['prepare'], 'nenhum send');
});

test('montar V1: seleciona só o que falta e cria pela rota de V1; nada é enviado', async () => {
  const upload = '44444444-4444-4444-8444-444444444444';
  setup({ kind: 'v1', params: { journeyId: JID, matchIds: ['a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002'], demandKey: `journey:${JID}:CARRO` } },
    { manheim_uploads: [{ id: upload, environment: 'preview', activated_at: '2026-10-01T00:00:00Z', undone_at: null, uploaded_at: '2026-10-01T00:00:00Z' }], manheim_option_selections: [{ id: 's1', environment: 'preview', upload_id: upload, status: 'SELECTED', match_id: 'a0000000-0000-4000-8000-000000000001' }] });
  const seen = [];
  await withRoutes(async (name, body) => { seen.push({ name, action: body.action || null, matchId: body.matchId || null }); return name === 'vitrines' ? { token: 'NEW', link: '/v/NEW', cars: [] } : { ok: true }; }, async () => {
    const out = await exec.confirm(ctx, { id: '99999999-9999-4999-8999-999999999999' });
    assert.equal(out.ok, true);
    assert.equal(out.link, '/v/NEW');
  });
  assert.deepEqual(seen, [{ name: 'manheim-options', action: 'select', matchId: 'a0000000-0000-4000-8000-000000000002' }, { name: 'vitrines', action: null, matchId: null }]);
  assert.ok(!seen.some((s) => s.name === 'v1-send'));
});

test('anexar: arquivo diferente do que o assistente leu não é anexado', async () => {
  const bytes = Buffer.from('%PDF-1.4 teste');
  setup({ kind: 'attach', params: { journeyId: JID, contactId: '22222222-2222-4222-8222-222222222222', file: { index: 1, name: 'a.pdf', mime: 'application/pdf', size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, sms: null } });
  await withRoutes(async () => ({ ok: true }), async () => {
    const out = await exec.confirm(ctx, { id: '99999999-9999-4999-8999-999999999999', files: [{ index: 1, base64: Buffer.from('outro arquivo').toString('base64') }] });
    assert.equal(out.code, 'FILE_CHANGED');
  });
});

test('registro de rotas: só erro de servidor ou lentidão vira linha; pedido rápido e sem erro não grava', async () => {
  const log = require('../panel-request-log');
  const fake = createFake({ panel_request_log: [] });
  globalThis.fetch = fake.fetchImpl;
  const fast = {}; log.start({ url: '/api/panel/today?x=1', method: 'GET' }, fast); await log.finish(fast, 200, {});
  const broken = {}; log.start({ url: '/api/panel/ai-conversations', method: 'POST' }, broken); await log.finish(broken, 500, { error: 'AI_UNAVAILABLE' });
  assert.equal(fake.db.panel_request_log.length, 1);
  assert.deepEqual({ path: fake.db.panel_request_log[0].path, status: fake.db.panel_request_log[0].status, code: fake.db.panel_request_log[0].code }, { path: '/api/panel/ai-conversations', status: 500, code: 'AI_UNAVAILABLE' });
});

test('dreno de logs da Vercel: só aceita envio assinado e só guarda erro', async () => {
  const drain = require('../api/panel/log-drain');
  process.env.LOG_DRAIN_SECRET = 'segredo-do-dreno';
  const body = Buffer.from(JSON.stringify([{ level: 'error', statusCode: 500, path: '/api/panel/boot?x=1', message: 'Task timed out', timestamp: Date.now(), environment: 'production' }, { level: 'info', statusCode: 200, path: '/api/panel/today' }]));
  const signature = crypto.createHmac('sha1', 'segredo-do-dreno').update(body).digest('hex');
  assert.equal(drain.signed('segredo-do-dreno', body, signature), true);
  assert.equal(drain.signed('segredo-do-dreno', body, 'x'.repeat(40)), false);
  const rows = JSON.parse(body.toString()).filter(drain.keep).map(drain.rowOf);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, '/api/panel/boot');
});

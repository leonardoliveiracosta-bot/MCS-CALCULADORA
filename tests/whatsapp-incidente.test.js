'use strict';

// Incidente de 29/09 (19h-01h UTC): banco sobrecarregado, 107 respostas 504 do webhook e 108 do
// media-cron. Casos cobertos, com o webhook e a manutenção reais sobre PGlite e rede bloqueada:
//  1. item que falhou por um erro passageiro (tempo esgotado no banco) volta sozinho no cron e a
//     mensagem entra uma vez, sem resposta automática, notificação ou envio;
//  2. o cron respeita o limite de tentativas e nunca refaz telefone ambíguo; duas execuções juntas
//     aplicam o item uma vez só;
//  3. banco lento na gravação do evento: o webhook responde 503 a tempo (o WhatsApp reenvia) em vez de
//     ficar preso até o limite de 60 s; o reenvio grava uma vez só;
//  4. processamento depois da resposta com prazo: o que não coube termina pelo cron;
//  5. media-cron: a cada minuto só as últimas horas; leitura de 30 dias e limpeza a cada meia hora.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada', WHATSAPP_WEBHOOK_SECRET: 'segredo-simulado' });
for (const key of ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'D360_API_KEY', 'MANHEIM_OPENAI_ENABLED']) delete process.env[key];
// The fixed greeting is ON here on purpose: the retried item must still never send it.
process.env.AUTO_REPLY_ENABLED = '1';
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const maintenance = require('../whatsapp-maintenance');
const webhook = require('../api/whatsapp/webhook');

const id = (n) => `6e300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CONTACT = id(11);
const seed = [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Fictício','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_primary,is_current,created_at) values('preview','${CONTACT}','+14075550199','+14075550199',true,true,now());`
].join('\n');
const customerMessage = (wamid, text) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'pn' }, contacts: [{ wa_id: '14075550199', profile: { name: 'Cliente Fictício' } }], messages: [{ from: '14075550199', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });

let backend, ctx;
// Database faults for this test: the path fails (as a statement timeout) or answers late.
const faults = { failApply: 0, slowRawInsertMs: 0 };
const sent = [];
test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (!target.startsWith(BASE)) { sent.push(target); throw new Error('REDE_BLOQUEADA'); }
    if (target.includes('/rpc/panel_whatsapp_apply_message') && faults.failApply > 0) {
      faults.failApply -= 1;
      return { ok: false, status: 500, text: async () => JSON.stringify({ code: '57014', message: 'canceling statement due to statement timeout' }), json: async () => ({}) };
    }
    if (target.includes('/rest/v1/whatsapp_raw_events?on_conflict') && faults.slowRawInsertMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, faults.slowRawInsertMs);
        options.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); });
      });
    }
    return backend.fetch(url, options);
  };
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview' };
});
test.after(async () => { if (backend) await backend.db.close(); });

async function post(body) {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  const tasks = [];
  await webhook({ method: 'POST', url: '/api/whatsapp/webhook', headers: { 'x-mcs-webhook-secret': 'segredo-simulado' }, query: {}, body, waitUntil: (task) => tasks.push(task) }, res);
  await Promise.all(tasks);
  return res;
}
const one = async (sql, params = []) => (await backend.db.query(sql, params)).rows[0];
const count = async (sql, params = []) => Number((await one(sql, params)).n);
const ageErrors = () => backend.db.query("update public.whatsapp_item_errors set created_at = now() - interval '5 minutes'");

test('1. item com falha passageira volta pelo cron: mensagem entra uma vez, nada é enviado', async () => {
  faults.failApply = 1;
  const res = await post(customerMessage('wamid.incidente.1', 'Oi, ainda tem o carro?'));
  assert.equal(res.statusCode, 200);
  // The state found in production: event DONE with ITEM_ERRORS, message missing, error left alone.
  const raw = await one("select status,error_code from public.whatsapp_raw_events where event_key is not null order by received_at desc limit 1");
  assert.deepEqual([raw.status, raw.error_code], ['DONE', 'ITEM_ERRORS:1']);
  assert.equal(await count("select count(*) n from public.whatsapp_message_ids where wa_message_id='wamid.incidente.1'"), 0);
  // Before this fix the cron only closed errors whose message already existed: nothing changed.
  await maintenance.resolveStoredItemErrors(ctx);
  assert.equal((await one("select status from public.whatsapp_item_errors")).status, 'ERROR');
  // Too recent (under 2 minutes): not touched yet.
  assert.deepEqual(await maintenance.retryItemErrors(ctx), { resolved: 0, failed: 0, busy: 0 });
  await ageErrors();
  const replies = await count('select count(*) n from public.whatsapp_auto_replies');
  const out = await maintenance.retryItemErrors(ctx, { deadlineAt: Date.now() + 20000 });
  assert.deepEqual(out, { resolved: 1, failed: 0, busy: 0 });
  assert.equal(await count("select count(*) n from public.whatsapp_message_ids where wa_message_id='wamid.incidente.1'"), 1);
  assert.equal(await count("select count(*) n from public.messages where body_text='Oi, ainda tem o carro?'"), 1);
  const error = await one('select status,attempts from public.whatsapp_item_errors');
  assert.deepEqual([error.status, error.attempts], ['RESOLVED', 1]);
  assert.equal((await one("select error_code from public.whatsapp_raw_events order by received_at desc limit 1")).error_code, null);
  // Nothing sent: no automatic reply recorded, no request outside the simulated database.
  assert.equal(await count('select count(*) n from public.whatsapp_auto_replies'), replies);
  assert.deepEqual(sent, []);
  // Running again changes nothing (no duplicate).
  assert.deepEqual(await maintenance.retryItemErrors(ctx), { resolved: 0, failed: 0, busy: 0 });
  assert.equal(await count("select count(*) n from public.messages where body_text='Oi, ainda tem o carro?'"), 1);
});

test('2. limite de tentativas, erro não passageiro fica e duas execuções juntas aplicam uma vez', async () => {
  // Fails 6 times: 1 live + 5 retries; then it stays ERROR for the operator.
  faults.failApply = 6;
  await post(customerMessage('wamid.incidente.2', 'Segunda mensagem'));
  for (let round = 0; round < 7; round += 1) { await ageErrors(); await maintenance.retryItemErrors(ctx); }
  const capped = await one("select status,attempts from public.whatsapp_item_errors where item_json->>'messageId'='wamid.incidente.2'");
  assert.deepEqual([capped.status, capped.attempts], ['ERROR', maintenance.MAX_ITEM_ATTEMPTS]);
  assert.equal(faults.failApply, 0, 'exatamente 1 + 5 tentativas');
  // The panel button still works after the cap.
  await backend.db.query("update public.whatsapp_item_errors set attempts=0 where item_json->>'messageId'='wamid.incidente.2'");
  // A phone that needs review is never retried here.
  await backend.db.query("update public.whatsapp_item_errors set error_code='PHONE_AMBIGUOUS', attempts=0 where item_json->>'messageId'='wamid.incidente.2'");
  await ageErrors();
  assert.deepEqual(await maintenance.retryItemErrors(ctx), { resolved: 0, failed: 0, busy: 0 });
  // Back to a passing error: two cron runs at once apply it once.
  await backend.db.query("update public.whatsapp_item_errors set error_code='ITEM_PROCESSING_FAILED' where item_json->>'messageId'='wamid.incidente.2'");
  const [left, right] = await Promise.all([maintenance.retryItemErrors(ctx), maintenance.retryItemErrors(ctx)]);
  assert.equal(left.resolved + right.resolved, 1);
  assert.equal(await count("select count(*) n from public.messages where body_text='Segunda mensagem'"), 1);
});

test('3. banco lento na gravação: 503 a tempo, reenvio grava uma vez só', async () => {
  const saved = { ...webhook.LIMITS };
  webhook.LIMITS.rawEventMs = 150;
  faults.slowRawInsertMs = 2000;
  try {
    const started = Date.now();
    const busy = await post(customerMessage('wamid.incidente.3', 'Terceira mensagem'));
    assert.deepEqual([busy.statusCode, busy.payload.error], [503, 'RECEIVER_BUSY']);
    assert.ok(Date.now() - started < 1500, 'respondeu antes do banco');
  } finally { faults.slowRawInsertMs = 0; }
  // WhatsApp delivers again: stored and processed; a third delivery is ignored.
  const again = await post(customerMessage('wamid.incidente.3', 'Terceira mensagem'));
  assert.equal(again.statusCode, 200);
  const third = await post(customerMessage('wamid.incidente.3', 'Terceira mensagem'));
  assert.equal(third.statusCode, 200);
  assert.equal(await count("select count(*) n from public.messages where body_text='Terceira mensagem'"), 1);
  Object.assign(webhook.LIMITS, saved);
});

test('4. processamento com prazo: o que não coube termina pelo cron', async () => {
  const saved = { ...webhook.LIMITS };
  webhook.LIMITS.processingMs = -1; // already past: the event is kept for the cron
  try {
    const res = await post(customerMessage('wamid.incidente.4', 'Quarta mensagem'));
    assert.equal(res.statusCode, 200);
  } finally { Object.assign(webhook.LIMITS, saved); }
  const raw = await one("select id,status,error_code from public.whatsapp_raw_events order by received_at desc limit 1");
  assert.deepEqual([raw.status, raw.error_code], ['PENDING', 'PROCESSING_DEFERRED']);
  assert.equal(await count("select count(*) n from public.messages where body_text='Quarta mensagem'"), 0);
  const out = await maintenance.recoverStalledEvents(ctx, { maxEvents: 5, deadlineAt: Date.now() + 20000 });
  assert.equal(out.reprocessed, 1);
  assert.equal(await count("select count(*) n from public.messages where body_text='Quarta mensagem'"), 1);
  assert.deepEqual(sent, []);
});

test('5. media-cron: a cada minuto só as últimas horas; 30 dias e limpeza a cada meia hora', async () => {
  const file = path.join(__dirname, '..', 'api/panel/media-cron.js');
  const calls = [];
  const media = {
    recoverMediaJobs: async () => calls.push(['recover']),
    cleanupMcsMedia: async () => { calls.push(['cleanup']); return { found: 0 }; },
    enqueueRecentMedia: async (_ctx, options) => { calls.push(['enqueue', options.sinceMs || null, options.maxEvents]); return { found: 0, queued: 0 }; },
    processMediaJobs: async () => ({ stored: 0, failed: 0 })
  };
  const load = () => { const mod = { exports: {} }; const req = (name) => name === '../../whatsapp-media' ? media : name === '../../panel-server' ? { configuration: () => ({ url: 'u', secretKey: 'k' }), SERVER_ENVIRONMENT: 'production', send: (res, code, payload) => res.status(code).json(payload) } : require(name); new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports); return mod.exports; };
  const run = async (minute) => {
    const RealDate = Date, at = new RealDate(Date.UTC(2026, 8, 30, 12, minute, 5)).getTime();
    global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [at])); } static now() { return at; } };
    process.env.CRON_SECRET = 'cron-simulado';
    const res = { status(code) { this.code = code; return this; }, json(value) { this.payload = value; return value; }, setHeader() {} };
    try { await load()({ method: 'GET', headers: { authorization: 'Bearer cron-simulado' } }, res); } finally { global.Date = RealDate; }
    return res;
  };
  calls.length = 0;
  const minute = await run(7);
  assert.equal(minute.code, 200);
  assert.deepEqual(calls.filter(([name]) => name !== 'recover'), [['enqueue', 2 * 3600000, 200]], 'só as últimas 2 horas, sem limpeza');
  calls.length = 0;
  const half = await run(30);
  assert.equal(half.payload.full, true);
  assert.deepEqual(calls.filter(([name]) => name !== 'recover'), [['cleanup'], ['enqueue', null, 1000]]);
  delete process.env.CRON_SECRET;
});

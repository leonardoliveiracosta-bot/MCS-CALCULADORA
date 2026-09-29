'use strict';

// O processamento do Manheim nunca impede o WhatsApp: com blocos de um lote sendo enviados ao mesmo
// tempo, a mensagem do cliente e o eco da equipe entram pelo webhook real, o evento cru é gravado
// antes da resposta, a mensagem é gravada uma vez só (reenvio não duplica), e nenhuma resposta
// automática ou mensagem sai. Recuperação no cron: até 5 eventos por ciclo, com limite de tempo, e o
// evento que nunca começou também volta. Banco PGlite local; nenhuma rede externa.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada', WHATSAPP_WEBHOOK_SECRET: 'segredo-simulado' });
for (const key of ['AUTO_REPLY_ENABLED', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'D360_API_KEY', 'MANHEIM_OPENAI_ENABLED']) delete process.env[key];
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const id = (n) => `6d300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), JOURNEY = id(10), CONTACT = id(11);
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Zap','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_primary,is_current,created_at) values('preview','${CONTACT}','+14075550123','+14075550123',true,true,now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`
].join('\n');

let backend;
async function call(name, method, body, headers = { authorization: 'Bearer token-simulado' }) {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  const tasks = [];
  await require('../api/' + name)({ method, url: '/api/' + name, headers, query: {}, body, waitUntil: (task) => tasks.push(task) }, res);
  return { res, tasks };
}
const customerMessage = (wamid, text) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'pn' }, contacts: [{ wa_id: '14075550123', profile: { name: 'Cliente Zap' } }], messages: [{ from: '14075550123', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const echo = (wamid, text) => ({ object: 'whatsapp_business_account', entry: [{ id: 'waba', changes: [{ field: 'smb_message_echoes', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'pn' }, message_echoes: [{ from: '15550000000', to: '14075550123', id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }] });
const car = (n) => ({ fingerprint: 'vin:VINW' + String(n).padStart(11, '0'), vehicle: { vin: 'VINW' + String(n).padStart(11, '0'), year: 2020, make: 'Honda', model: 'CR-V', miles: 20000 + n, mmrCents: 2500000 } });

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

test('webhook do cliente e eco da equipe entram durante o envio de um lote do Manheim', async () => {
  const { contentHash } = require('../panel-manheim-batch');
  const blocks = [0, 1, 2].map((chunkIndex) => Array.from({ length: 500 }, (_, n) => car(chunkIndex * 500 + n)));
  const files = [{ name: 'Z.csv', size: 1, rowCount: 1500, vehicleCount: 1500, chunkCount: 3, chunks: blocks.map((block) => ({ count: block.length, hash: contentHash(block) })) }];
  const started = await call('panel/manheim-batch', 'POST', { action: 'start', clientKey: 'd'.repeat(32), vehicleCount: 1500, headers: [['Vin']], headerMap: {}, files, manifestHash: contentHash(files) });
  assert.equal(started.res.statusCode, 201, JSON.stringify(started.res.payload));
  const uploadId = started.res.payload.uploadId;
  const chunks = blocks.map((vehicles, chunkIndex) => call('panel/manheim-batch', 'POST', { action: 'chunk', uploadId, fileIndex: 0, chunkIndex, vehicles }));
  const secret = { 'x-mcs-webhook-secret': 'segredo-simulado' };
  const webhookStarted = Date.now();
  const [inbound, outbound] = await Promise.all([call('whatsapp/webhook', 'POST', customerMessage('wamid.cliente.1', 'Oi, ainda tem o CR-V?'), secret), call('whatsapp/webhook', 'POST', echo('wamid.eco.1', 'Temos sim, vou te mandar'), secret)]);
  const acknowledged = Date.now() - webhookStarted;
  assert.equal(inbound.res.statusCode, 200);
  assert.equal(outbound.res.statusCode, 200);
  // The raw event is durable before the answer (the processing runs after, in waitUntil).
  const { rows: raws } = await backend.db.query(`select event_key, status from public.whatsapp_raw_events where environment='preview' order by received_at`);
  assert.equal(raws.length, 2);
  await Promise.all([...inbound.tasks, ...outbound.tasks]);
  const results = await Promise.all(chunks);
  assert.ok(results.every(({ res }) => res.statusCode === 200), 'todos os blocos gravados');
  const done = await call('panel/manheim-batch', 'POST', { action: 'finalize', uploadId });
  assert.equal(done.res.statusCode, 200, JSON.stringify(done.res.payload));
  const { rows: messages } = await backend.db.query(`select direction, body_text from public.messages where environment='preview' order by direction`);
  assert.deepEqual(messages.map((row) => row.direction), ['CUSTOMER', 'MCS']);
  const { rows: statuses } = await backend.db.query(`select status from public.whatsapp_raw_events where environment='preview'`);
  assert.ok(statuses.every((row) => row.status === 'DONE'), JSON.stringify(statuses));
  // The same webhook delivered again (Meta retries) never duplicates the message.
  const again = await call('whatsapp/webhook', 'POST', customerMessage('wamid.cliente.1', 'Oi, ainda tem o CR-V?'), secret);
  await Promise.all(again.tasks);
  const { rows: [{ count }] } = await backend.db.query(`select count(*)::int from public.messages where environment='preview' and direction='CUSTOMER'`);
  assert.equal(count, 1);
  // Nothing left the machine: no automatic reply, no push, no paid call.
  assert.deepEqual(backend.refused, []);
  assert.ok(acknowledged < 5000, `webhook respondeu em ${acknowledged} ms`);
  console.log(`webhook respondido em ${acknowledged} ms com 3 blocos de 500 carros em andamento`);
});

test('recuperação no cron: até 5 por ciclo, com limite de tempo; evento que nunca começou também volta', async () => {
  const maintenance = require('../whatsapp-maintenance');
  const ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview' };
  // Seven events received 5 minutes ago whose background work was lost (never started).
  for (let n = 0; n < 7; n += 1) {
    await backend.db.query(`insert into public.whatsapp_raw_events(environment,event_key,event_type,payload_json,status,received_at) values('preview',$1,'messages',$2,'PENDING',now()-interval '5 minutes')`, ['perdido-' + n, JSON.stringify(customerMessage('wamid.perdido.' + n, 'Mensagem ' + n))]);
  }
  const first = await maintenance.recoverStalledEvents(ctx, { maxEvents: 5, deadlineAt: Date.now() + 20000 });
  assert.equal(first.reprocessed + first.done, 5, JSON.stringify(first));
  const second = await maintenance.recoverStalledEvents(ctx, { maxEvents: 5, deadlineAt: Date.now() + 20000 });
  assert.equal(second.reprocessed + second.done, 2);
  const { rows: [{ count }] } = await backend.db.query(`select count(*)::int from public.whatsapp_raw_events where event_key like 'perdido-%' and status='DONE'`);
  assert.equal(count, 7);
  // A recent PENDING event (its webhook may still be working on it) is left alone.
  await backend.db.query(`insert into public.whatsapp_raw_events(environment,event_key,event_type,payload_json,status,received_at) values('preview','recente','messages',$1,'PENDING',now())`, [JSON.stringify(customerMessage('wamid.recente', 'x'))]);
  const third = await maintenance.recoverStalledEvents(ctx, { maxEvents: 5, deadlineAt: Date.now() + 20000 });
  assert.deepEqual(third, { done: 0, reprocessed: 0, deferred: 0, failed: 0 });
  // Deadline already reached: nothing starts.
  await backend.db.query(`update public.whatsapp_raw_events set received_at=now()-interval '5 minutes' where event_key='recente'`);
  const late = await maintenance.recoverStalledEvents(ctx, { maxEvents: 5, deadlineAt: Date.now() - 1 });
  assert.deepEqual(late, { done: 0, reprocessed: 0, deferred: 0, failed: 0 });
  assert.match(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api/panel/ai-cron.js'), 'utf8'), /recoverStalledEvents\(ctx,\{maxEvents:5,deadlineAt:Date\.now\(\)\+20000\}\)/);
  assert.deepEqual(backend.refused, []);
});

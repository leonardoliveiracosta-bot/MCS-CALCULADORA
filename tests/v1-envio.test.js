'use strict';

// Envio manual da V1 pelo 360dialog e histórico de lotes, com os handlers reais contra um banco
// PGlite com todas as migrações. Fora de produção o envio é sempre simulado: nenhuma chamada ao
// 360dialog sai daqui (o fetch só alcança o banco simulado). O modo real é testado com um 360dialog
// falso injetado: sem ID de mensagem nunca é "Enviado".
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');
const v1Send = require('../api/panel/v1-send');

const id = (n) => `6c700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const token = (n) => 'tok' + String(n).repeat(40);
const person = (n, name, phone, lastCustomerSql, ref) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(10 + n)}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,reference_code,created_at,updated_at) values('${id(20 + n)}','preview','${id(10 + n)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}','${ref}',now(),now());`,
  `insert into public.vitrines(id,environment,token,journey_id,contact_id,reference_code,customer_name,version,expires_at,created_by) values('${id(40 + n)}','preview','${token(n)}','${id(20 + n)}','${id(10 + n)}','${ref}','${name}','V1',now()+interval '7 days','${ACTOR}');`,
  ...(phone ? [
    `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,created_at) values('preview','${id(10 + n)}','${phone}','${phone}',true,now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(30 + n)}','preview','WHATSAPP','${id(10 + n)}','wa:${phone}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(50 + n)}','preview','${id(30 + n)}','WHATSAPP','CUSTOMER','oi','oi',${lastCustomerSql},'s${n}',1,'WHATSAPP_WEBHOOK',now());`
  ] : [])
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...person(1, 'Maria Silva', '+13055550101', `now() - interval '1 hour'`, 'VNVA2'),
  ...person(2, 'Joao', '+13055550102', `now() - interval '3 days'`, 'VNVB3'),
  ...person(3, 'Sem Telefone', null, null, 'VNVC4')
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const v1 = (body) => call('v1-send', '/api/panel/v1-send', 'POST', body);
const q = async (sql) => (await backend.db.query(sql)).rows;
const BASE_URL = 'https://painel.example.test';
const LINK = (n) => BASE_URL + '/v/' + token(n);

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['D360_API_KEY', 'V1_DIRECT_SEND_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

test('preparação: telefone da ficha, modelo pela origem da busca, sem telefone fica indisponível', async () => {
  const valor = await v1({ action: 'prepare', token: token(1), baseUrl: BASE_URL, demandKey: `journey:${id(21)}:VALOR` });
  assert.equal(valor.statusCode, 200, JSON.stringify(valor.payload));
  assert.deepEqual([valor.payload.eligible, valor.payload.mode, valor.payload.phone, valor.payload.origin, valor.payload.windowOpen], [true, 'SIMULATED', '+13055550101', 'VALOR', true]);
  assert.equal(valor.payload.text, `Hi Maria,\n\nI put together a first look at what the current auction market supports within the range we are working with\n\nYou can view it here: ${LINK(1)}\n\nThis is a practical reference point for what is realistic right now\n\nIf an option makes sense, we can review the details before deciding whether to pursue it`);
  const carro = await v1({ action: 'prepare', token: token(1), baseUrl: BASE_URL, demandKey: `journey:${id(21)}:CARRO` });
  assert.match(carro.payload.text, /^Hi Maria,\n\nI reviewed the current auction listings against the vehicle details you provided/);
  // Origin not clear (no demand, or a demand of another ficha): no model is picked.
  for (const demandKey of [undefined, `journey:${id(22)}:VALOR`]) {
    const unknown = await v1({ action: 'prepare', token: token(1), baseUrl: BASE_URL, demandKey });
    assert.deepEqual([unknown.payload.origin, unknown.payload.text], [null, '']);
  }
  const noPhone = await v1({ action: 'prepare', token: token(3), baseUrl: BASE_URL });
  assert.deepEqual([noPhone.payload.eligible, noPhone.payload.reason], [false, 'NO_VALID_PHONE']);
});

test('envio simulado com confirmação: sem duplicar, reenvio só explícito, nada sai para o 360dialog', async () => {
  const text = `Hi Maria, see ${LINK(1)}`;
  const base = { action: 'send', token: token(1), text, confirmed: true, demandKey: `journey:${id(21)}:VALOR` };
  assert.equal((await v1({ ...base, confirmed: false, requestKey: id(901) })).payload.error, 'V1_SEND_CONFIRM_REQUIRED');
  assert.equal((await v1({ ...base, text: 'Hi Maria', requestKey: id(902) })).payload.error, 'V1_LINK_MISSING');
  const first = await v1({ ...base, requestKey: id(903) });
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.deepEqual([first.payload.sendStatus, first.payload.simulated], ['SENT', true]);
  // The same V1 again: refused unless the operator asks for "Reenviar".
  const again = await v1({ ...base, requestKey: id(904) });
  assert.deepEqual([again.statusCode, again.payload.error], [409, 'V1_ALREADY_SENT']);
  // The same confirmation twice (double click): never a second message.
  const duplicate = await v1({ ...base, requestKey: id(903), resend: true });
  assert.deepEqual([duplicate.statusCode, duplicate.payload.error], [409, 'SEND_IN_PROGRESS']);
  const resent = await v1({ ...base, requestKey: id(905), resend: true });
  assert.equal(resent.payload.sendStatus, 'SENT');
  const sends = await q(`select status, simulated, resend, phone_e164, origin, body_text, created_by from public.v1_sends order by created_at`);
  assert.deepEqual(sends.map((row) => [row.status, row.simulated, row.resend, row.phone_e164, row.origin]), [['SENT', true, false, '+13055550101', 'VALOR'], ['SENT', true, true, '+13055550101', 'VALOR']]);
  assert.ok(sends.every((row) => row.body_text === text && row.created_by === ACTOR));
  const prepared = await v1({ action: 'prepare', token: token(1), baseUrl: BASE_URL });
  assert.deepEqual([prepared.payload.last.status, prepared.payload.last.simulated], ['SENT', true]);
  // Simulated: nothing reached the conversation and no request left for the 360dialog.
  assert.equal((await q(`select count(*)::int n from public.messages where direction = 'MCS'`))[0].n, 0);
  assert.deepEqual(backend.refused, []);
});

test('fora da janela do WhatsApp nada é tentado; sem telefone também não', async () => {
  const closed = await v1({ action: 'send', token: token(2), text: `Hi ${LINK(2)}`, confirmed: true, requestKey: id(911) });
  assert.deepEqual([closed.statusCode, closed.payload.error], [409, 'WINDOW_CLOSED']);
  assert.equal(closed.payload.whatsappLink, 'https://wa.me/13055550102?text=' + encodeURIComponent(`Hi ${LINK(2)}`));
  const noPhone = await v1({ action: 'send', token: token(3), text: `Hi ${LINK(3)}`, confirmed: true, requestKey: id(912) });
  assert.equal(noPhone.payload.error, 'NO_VALID_PHONE');
  assert.equal((await q(`select count(*)::int n from public.v1_sends where vitrine_id in ('${id(42)}','${id(43)}')`))[0].n, 0);
});

test('produção: desligado por padrão; ligado, só um ID do 360dialog confirma o envio', async () => {
  const ctx = { environment: 'preview', config: { url: BASE, secretKey: 'secreta-simulada' }, panel: { id: ACTOR } };
  const { rows, insert, patchRows } = require('../panel-server');
  const reply = require('../api/panel/reply');
  const services = (d360Send) => ({ rows, insert, patchRows, applyMessage: reply.applyMessage, d360Send });
  const body = (key, resend = true) => ({ action: 'send', token: token(1), text: `Hi ${LINK(1)}`, confirmed: true, requestKey: key, resend });
  let calls = 0;
  const off = await v1Send.handle(ctx, body(id(921)), services(async () => { calls += 1; return { messageId: 'x' }; }), { VERCEL_ENV: 'production' });
  assert.deepEqual([off.status, off.error, calls], [409, 'V1_DIRECT_SEND_DISABLED', 0]);
  const live = { VERCEL_ENV: 'production', V1_DIRECT_SEND_ENABLED: '1' };
  const timeout = await v1Send.handle(ctx, body(id(922)), services(async () => ({ error: 'D360_TIMEOUT' })), live);
  assert.equal(timeout.sendStatus, 'UNCONFIRMED');
  const refused = await v1Send.handle(ctx, body(id(923)), services(async () => ({ error: 'D360_HTTP_400' })), live);
  assert.equal(refused.sendStatus, 'FAILED');
  const ok = await v1Send.handle(ctx, body(id(924)), services(async () => ({ messageId: 'wamid.TESTE123' })), live);
  assert.deepEqual([ok.sendStatus, ok.simulated], ['SENT', false]);
  const last = await q(`select status, provider_message_id, error_code from public.v1_sends order by created_at desc limit 3`);
  assert.deepEqual(last.map((row) => [row.status, row.provider_message_id, row.error_code]), [['SENT', 'wamid.TESTE123', null], ['FAILED', null, 'D360_HTTP_400'], ['UNCONFIRMED', null, 'D360_TIMEOUT']]);
  // The confirmed send is in the conversation, with the V1 text.
  const [message] = await q(`select body_text, direction from public.messages where direction = 'MCS'`);
  assert.deepEqual([message.direction, message.body_text], ['MCS', `Hi ${LINK(1)}`]);
});

test('histórico de lotes: ocultar só lote desfeito, por operador, sem mudar nada do lote', async () => {
  const car = (n) => ({ fingerprint: 'vin:HIST' + String(n).padStart(13, '0'), vehicle: { vin: 'HIST' + String(n).padStart(13, '0'), year: 2020, make: 'Honda', model: 'CR-V', miles: 20000, mmrCents: 2500000, cleanTitle: true, odometerOk: true } });
  const uploads = [];
  for (const n of [1, 2, 3]) {
    const cars = [car(n)];
    const files = [{ name: `H${n}.csv`, size: 1, rowCount: 1, vehicleCount: 1, chunkCount: 1, chunks: [{ count: 1, hash: contentHash(cars) }] }];
    const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: String(n).repeat(32), vehicleCount: 1, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
    await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
    await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'finalize', uploadId: started.payload.uploadId });
    uploads.push(started.payload.uploadId);
  }
  await backend.db.exec(`update public.manheim_uploads set undone_at = now() where id in ('${uploads[0]}','${uploads[1]}')`);
  const before = await q(`select id, undone_at, activated_at, vehicle_count from public.manheim_uploads order by id`);
  const post = (body) => call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'visibility', ...body });
  const active = await post({ op: 'hide', uploadId: uploads[2] });
  assert.deepEqual([active.statusCode, active.payload.error], [409, 'MANHEIM_BATCH_NOT_UNDONE']);
  assert.equal((await post({ op: 'hide', uploadId: uploads[0] })).statusCode, 200);
  let view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.deepEqual(view.hiddenBatchIds, [uploads[0]]);
  await post({ op: 'hide_all' });
  view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.deepEqual(view.hiddenBatchIds.sort(), [uploads[0], uploads[1]].sort());
  await post({ op: 'restore', uploadId: uploads[0] });
  view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.deepEqual(view.hiddenBatchIds, [uploads[1]]);
  assert.deepEqual(await q(`select id, undone_at, activated_at, vehicle_count from public.manheim_uploads order by id`), before);
});

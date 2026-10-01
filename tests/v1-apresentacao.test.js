'use strict';

// A V1 enviada pelo painel conta como apresentação dos seus carros, igual a "Apresentei ao cliente":
// uma unidade por carro (sem duplicar no reenvio), a busca do modo fica "Opções enviadas", o contexto
// do cliente deixa de sugerir gerar a V1 e o cartão de OPÇÕES lê a última V1 depois de recarregar.
// Handlers reais contra o banco PGlite; fora de produção o envio é sempre simulado (nada sai daqui).
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');
const v1Send = require('../api/panel/v1-send');

const id = (n) => `6c900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const JOURNEY = id(10), CONTACT = id(11), CHAT = id(12);
const JOURNEY2 = id(20), CONTACT2 = id(21), CHAT2 = id(22);
const token = (n) => 'apr' + String(n).repeat(40);
const BASE_URL = 'https://painel.example.test';
const LINK = (n) => BASE_URL + '/v/' + token(n);
const criteria = JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] });
const person = (journey, contact, chat, name, phone, n) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${criteria}',now(),now());`,
  `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,created_at) values('preview','${contact}','${phone}','${phone}',true,now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','wa:${phone}','RESOLVED',false,now(),now(),now(),now());`,
  // The customer wrote two hours ago (window open) and the MCS answered after: waiting on the customer.
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(100 + n)}','preview','${chat}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now() - interval '2 hours','c${n}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(110 + n)}','preview','${chat}','WHATSAPP','MCS','Vou procurar','x',now() - interval '1 hour','m${n}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(100 + n)}','${journey}','IMPORT',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(110 + n)}','${journey}','IMPORT',now());`
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...person(JOURNEY, CONTACT, CHAT, 'Ana Apresentada', '+13055550301', 1),
  ...person(JOURNEY2, CONTACT2, CHAT2, 'Bruno Falha', '+13055550302', 2)
].join('\n');
const car = (n) => {
  const vin = 'APRE' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', startsAt: '2026-10-01T15:00:00Z', lane: '1', run: String(10 + n), saleType: 'Simulcast', conditionGrade: '4.5', cleanTitle: true, odometerOk: true } };
};

let backend;
const res = () => ({ statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} });
async function call(name, method, body, search = '') {
  const out = res();
  const parsed = new URL('/api/panel/' + name + search, 'http://painel.local');
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, out);
  return out;
}
const q = async (sql) => (await backend.db.query(sql)).rows;
const v1 = (body) => call('v1-send', 'POST', body);
const context = async (journeyId) => (await call('client-context', 'POST', { journeyIds: [journeyId] })).payload.journeys[journeyId];
let matches = [];

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['D360_API_KEY', 'V1_DIRECT_SEND_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const cars = [car(1), car(2), car(3)];
  const files = [{ name: 'APRESENTA.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await call('manheim-batch', 'POST', { action: 'start', clientKey: 'a'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  assert.equal(started.statusCode < 300, true, JSON.stringify(started.payload));
  await call('manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await call('manheim-batch', 'POST', { action: 'finalize', uploadId: started.payload.uploadId });
  matches = await q(`select id, journey_id, logical_mode from public.manheim_matches where journey_id = '${JOURNEY}' order by id`);
  assert.ok(matches.length >= 3, 'os três carros batem com a ficha: ' + JSON.stringify(matches));
  // Two V1 of the same ficha (the second one is the latest) and one V1 of the second ficha.
  await backend.db.exec(`
    insert into public.vitrines(id,environment,token,journey_id,contact_id,reference_code,customer_name,version,expires_at,created_by,created_at) values
      ('${id(41)}','preview','${token(1)}','${JOURNEY}','${CONTACT}','','Ana Apresentada','V1',now()+interval '7 days','${ACTOR}',now() - interval '10 minutes'),
      ('${id(42)}','preview','${token(2)}','${JOURNEY}','${CONTACT}','','Ana Apresentada','V1',now()+interval '7 days','${ACTOR}',now() - interval '5 minutes'),
      ('${id(43)}','preview','${token(3)}','${JOURNEY2}','${CONTACT2}','','Bruno Falha','V1',now()+interval '7 days','${ACTOR}',now());
    insert into public.vitrine_cars(environment,vitrine_id,source_match_id,short_code,vehicle_snapshot,photo_paths) values
      ('preview','${id(41)}','${matches[0].id}','APR001','{}','{}'),
      ('preview','${id(41)}','${matches[1].id}','APR002','{}','{}'),
      ('preview','${id(42)}','${matches[1].id}','APR003','{}','{}'),
      ('preview','${id(42)}','${matches[2].id}','APR004','{}','{}');
  `);
});
test.after(async () => { if (backend) await backend.db.close(); });

test('V1 enviada (simulado): carros apresentados uma vez, busca "Opções enviadas", reenvio sem duplicar', async () => {
  const before = await context(JOURNEY);
  assert.doesNotMatch(before.nextAction.text, /^V1 enviada/);
  assert.equal(before.v1, null);
  // "Apresentei ao cliente" on one car first: the V1 that carries it does not present it again.
  const presented = await call('actions', 'POST', { action: 'unit', journeyId: JOURNEY, manheimMatchId: matches[1].id, status: 'PRESENTED' });
  assert.equal(presented.statusCode, 200, JSON.stringify(presented.payload));
  const base = { action: 'send', token: token(2), text: `Hi Ana, see ${LINK(2)}`, confirmed: true, demandKey: `journey:${JOURNEY}:CARRO` };
  const first = await v1({ ...base, requestKey: id(901) });
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.deepEqual([first.payload.sendStatus, first.payload.simulated, first.payload.presentationRecorded], ['SENT', true, true]);
  const units = await q(`select u.id, u.status, u.details_json from public.units u where u.journey_id = '${JOURNEY}' order by u.created_at`);
  assert.equal(units.length, 2, 'um da ação manual e um da V1 (o carro já apresentado não duplica)');
  assert.equal(units[1].details_json.v1_vitrine_id, id(42));
  assert.equal(units[1].details_json.manheim_match_id, matches[2].id);
  const linked = await q(`select id, presented_unit_id from public.manheim_matches where id in ('${matches[1].id}','${matches[2].id}') order by id`);
  assert.ok(linked.every((row) => row.presented_unit_id), 'cada carro da V1 aponta para a sua unidade');
  const [journey] = await q(`select stage, search_started_at from public.journeys where id = '${JOURNEY}'`);
  assert.equal(journey.stage, 'EM_BUSCA');
  assert.ok(journey.search_started_at);
  const marks = await q(`select kind, logical_mode from public.panel_search_marks where journey_id = '${JOURNEY}' and undone_at is null`);
  assert.deepEqual(marks.map((row) => [row.kind, row.logical_mode]), [['SENT', 'CARRO']]);
  const { loadSearchStageIndex } = require('../panel-search-stage');
  const index = await loadSearchStageIndex({ environment: 'preview', config: { url: BASE, secretKey: 'secreta-simulada' }, panel: { id: ACTOR } }, { journeyIds: [JOURNEY] });
  assert.equal(index.get(JOURNEY).modes.CARRO.stage, 'SENT');
  const activity = await q(`select count(*)::int n from public.activity_log where journey_id = '${JOURNEY}' and activity_type = 'V1_PRESENTED'`);
  assert.equal(activity[0].n, 1);

  // Resend: the same V1 again records nothing new.
  const again = await v1({ ...base, requestKey: id(902), resend: true });
  assert.deepEqual([again.payload.sendStatus, again.payload.presentationRecorded], ['SENT', true]);
  assert.equal((await q(`select count(*)::int n from public.units where journey_id = '${JOURNEY}'`))[0].n, 2);
  assert.equal((await q(`select count(*)::int n from public.panel_search_marks where journey_id = '${JOURNEY}' and undone_at is null`))[0].n, 1);
  assert.equal((await q(`select count(*)::int n from public.activity_log where journey_id = '${JOURNEY}' and activity_type = 'V1_PRESENTED'`))[0].n, 1);
  // Simulated: nothing reached the conversation and no request left for the 360dialog.
  assert.equal((await q(`select count(*)::int n from public.messages where direction = 'MCS' and source_kind <> 'WHATSAPP_WEBHOOK'`))[0].n, 0);
  assert.deepEqual(backend.refused, []);
});

test('contexto do cliente: depois do envio, a próxima ação acompanha a V1 (com a data) em vez de gerar outra', async () => {
  const item = await context(JOURNEY);
  assert.ok(item.v1 && item.v1.at, JSON.stringify(item.v1));
  assert.equal(item.v1.status, 'SENT');
  assert.match(item.nextAction.text, /^V1 enviada em \d\d\/\d\d: acompanhar a resposta do cliente aos carros da V1$/);
  assert.doesNotMatch(item.nextAction.text, /gerar o link V1/);
  assert.equal(item.searches.find((search) => search.mode === 'CARRO').stage, 'SENT');
  // The rule itself: what the search still lacks comes first; with nothing else pending, the follow-up.
  const ctxModule = require('../panel-client-context');
  const fields = ctxModule.buildFields([]);
  const owner = { who: 'MCS', label: 'MCS' };
  const step = ctxModule.nextStep({ owner, fields, modes: [], searches: [], v1: { at: '2026-09-30T15:00:00Z', status: 'UNCONFIRMED' } });
  assert.match(step.action.text, /^Descobrir pela conversa/, 'o que falta para a busca continua antes do acompanhamento');
  const done = ctxModule.nextStep({ owner, fields: ctxModule.buildFields([{ carro: [{ kind: 'FICHA', value: 'Honda CR-V' }], anos: [{ kind: 'FICHA', value: '2019 a 2022' }], milhas: [{ kind: 'FICHA', value: 'até 60,000 mi' }] }]), modes: ['CARRO'], searches: [{ mode: 'CARRO', stage: 'SENT' }], v1: { at: '2026-09-30T15:00:00Z', status: 'UNCONFIRMED' } });
  assert.equal(done.action.text, 'V1 enviada (sem confirmação do WhatsApp) em 30/09: seguir a conversa sobre os carros da V1');
  assert.deepEqual(backend.refused, []);
});

test('GET da última V1: depois de recarregar, o cartão recebe o link e o último envio', async () => {
  const out = await call('v1-send', 'GET', undefined, `?journeyIds=${JOURNEY},${JOURNEY2}`);
  assert.equal(out.statusCode, 200, JSON.stringify(out.payload));
  const carro = out.payload.latest[`journey:${JOURNEY}:CARRO`];
  assert.equal(carro.token, token(2));
  assert.equal(carro.link, '/v/' + token(2));
  assert.deepEqual([carro.lastSent.status, carro.lastSent.simulated, carro.lastSent.resend], ['SENT', true, true]);
  assert.deepEqual(carro.modes, ['CARRO']);
  assert.equal(out.payload.latest[`journey:${JOURNEY}`].token, token(2));
  assert.equal(out.payload.latest[`journey:${JOURNEY}:VALOR`], undefined, 'nunca mostrada no cartão de outro modo');
  // The second ficha has a V1 without cars nor sends: only under the ficha key, not sent.
  const other = out.payload.latest[`journey:${JOURNEY2}`];
  assert.deepEqual([other.token, other.last, other.lastSent], [token(3), null, null]);
  for (const search of ['', '?journeyIds=nao-e-uuid']) assert.equal((await call('v1-send', 'GET', undefined, search)).statusCode, 400);
  assert.equal((await call('v1-send', 'PUT', {})).statusCode, 405);
});

test('falha no registro da apresentação nunca transforma um envio feito em erro', async () => {
  const ctx = { environment: 'preview', config: { url: BASE, secretKey: 'secreta-simulada' }, panel: { id: ACTOR } };
  const { rows, insert, patchRows } = require('../panel-server');
  const reply = require('../api/panel/reply');
  const quiet = console.error; const logged = []; console.error = (...args) => logged.push(args.join(' '));
  try {
    // 1) The whole bookkeeping throws.
    const services = { rows, insert, patchRows, applyMessage: reply.applyMessage, d360Send: reply.d360Send, recordPresentation: async () => { throw Object.assign(new Error('boom'), { code: 'BOOKKEEPING_DOWN' }); } };
    const sent = await v1Send.handle(ctx, { action: 'send', token: token(3), text: `Hi ${LINK(3)}`, confirmed: true, requestKey: id(911), demandKey: `journey:${JOURNEY2}:CARRO` }, services);
    assert.deepEqual([sent.status, sent.sendStatus, sent.presentationRecorded], [200, 'SENT', false]);
    // 2) A read inside the real bookkeeping fails (vitrine cars).
    const broken = { rows: async (c, table, params) => { if (table === 'vitrine_cars') throw Object.assign(new Error('down'), { status: 500 }); return rows(c, table, params); }, insert, patchRows, applyMessage: reply.applyMessage, d360Send: reply.d360Send };
    const resent = await v1Send.handle(ctx, { action: 'send', token: token(3), text: `Hi ${LINK(3)}`, confirmed: true, requestKey: id(912), resend: true, demandKey: `journey:${JOURNEY2}:CARRO` }, broken);
    assert.deepEqual([resent.status, resent.sendStatus, resent.presentationRecorded], [200, 'SENT', false]);
  } finally { console.error = quiet; }
  assert.deepEqual(logged.map((line) => line.split(' ')[0]), ['V1_PRESENTATION_NOT_RECORDED', 'V1_PRESENTATION_NOT_RECORDED']);
  assert.ok(logged.every((line) => !line.includes('+1305')), 'o log não leva telefone');
  const sends = await q(`select status from public.v1_sends where vitrine_id = '${id(43)}' order by created_at`);
  assert.deepEqual(sends.map((row) => row.status), ['SENT', 'SENT']);
  assert.equal((await q(`select count(*)::int n from public.panel_search_marks where journey_id = '${JOURNEY2}'`))[0].n, 0);
});

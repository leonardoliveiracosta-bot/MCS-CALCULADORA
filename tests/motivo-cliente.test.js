'use strict';

// "Por que este carro": frase para o cliente no carro selecionado. Só em carro selecionado, vale para
// qualquer venda do mesmo VIN, vai na V1 (página do cliente) e a observação interna nunca vai.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const id = (n) => `6d100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), JOURNEY = id(10), CONTACT = id(11);
const KEY = `journey:${JOURNEY}:CARRO`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Motivo','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,reference_code,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',null,'WHYQ2',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','why-1','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'s1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const car = (n, extra = {}) => {
  const vin = 'WHYV' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin + (extra.fp || ''), vehicle: { vin, year: 2021, make: 'Honda', model: 'CR-V', trim: 'EX-L', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', startsAt: '2030-10-01T15:00:00Z', lane: '1', run: String(10 + n), saleType: 'Simulcast', conditionGrade: '4.0', cleanTitle: true, odometerOk: true, ...extra.vehicle } };
};
// Car 1 comes twice (Lane/Run and Buy Now, two CSV rows): one VIN.
const cars = [car(0), car(1), car(1, { fp: ':bn', vehicle: { lane: '', run: '', buyNowPrice: '26500' } }), car(2)];

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['MANHEIM_MATCH_AUDIT_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ name: 'WHY.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: 'd'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin', 'Lane', 'Run']], headerMap: {} });
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  const done = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'finalize', uploadId: started.payload.uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
});
test.after(async () => { if (backend) await backend.db.close(); });

const page = async () => (await call('manheim-options', `/api/panel/manheim-options?key=${KEY}&group=LANE&limit=10`)).payload.options;
const post = (body) => call('manheim-options', '/api/panel/manheim-options', 'POST', body);

test('motivo só em carro selecionado; vale para o VIN; volta na página; nota interna separada', async () => {
  const options = await page();
  const target = options.find((option) => option.vehicle_json.parsed.vin.endsWith('1'));
  assert.ok(target, 'carro do VIN repetido aparece uma vez no grupo');
  const before = await post({ action: 'reason', matchId: target.id, reason: 'Menor milhagem do lote' });
  assert.deepEqual([before.statusCode, before.payload.error], [409, 'MANHEIM_OPTION_NOT_SELECTED']);
  assert.equal((await post({ action: 'select', matchId: target.id, note: 'margem boa, não contar ao cliente' })).statusCode, 200);
  const saved = await post({ action: 'reason', matchId: target.id, reason: '  Menor milhagem do lote,\n um dono  ' });
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.clientReason, 'Menor milhagem do lote,  um dono');
  const again = (await page()).find((option) => option.id === target.id);
  assert.equal(again.offer.clientReason, 'Menor milhagem do lote,  um dono');
  assert.equal(again.offer.note, 'margem boa, não contar ao cliente');
  const tooLong = await post({ action: 'reason', matchId: target.id, reason: 'x'.repeat(301) });
  assert.deepEqual([tooLong.statusCode, tooLong.payload.error], [400, 'MANHEIM_REASON_TOO_LONG']);
  const log = (await backend.db.query("select count(*)::int n from public.audit_log where action='CLIENT_REASON'")).rows[0].n;
  assert.equal(log, 1, 'registrado no histórico');
});

test('a V1 leva o motivo de cada carro e nunca a observação interna', async () => {
  const options = await page();
  const withReason = options.find((option) => option.offer.clientReason);
  const other = options.find((option) => option.id !== withReason.id);
  assert.equal((await post({ action: 'select', matchId: other.id })).statusCode, 200);
  const created = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: JOURNEY, matchIds: [withReason.id, other.id], demandKey: KEY });
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
  const vitrine = (await backend.db.query('select * from public.vitrines where token=$1', [created.payload.token])).rows[0];
  const carsRows = (await backend.db.query('select * from public.vitrine_cars where vitrine_id=$1 order by created_at', [vitrine.id])).rows;
  const { publicResponse } = require('../vitrine-domain');
  const out = publicResponse(vitrine, carsRows, []);
  const texts = JSON.stringify(out);
  assert.match(texts, /"whyChosen":"Menor milhagem do lote, um dono"/);
  assert.doesNotMatch(texts, /margem boa/, 'a observação interna nunca vai ao cliente');
  assert.equal(out.cars.filter((item) => item.whyChosen).length, 1, 'só o carro com motivo mostra o bloco');
  // The customer page draws it, escaped.
  const render = require('node:fs').readFileSync(require.resolve('../v/vitrine-render.js'), 'utf8');
  assert.match(render, /Why we picked it:<\/strong> \$\{escape\(car\.whyChosen\)\}/);
});

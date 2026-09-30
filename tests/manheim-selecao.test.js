'use strict';

// Seleção de opções Manheim para o cliente, com os handlers reais contra um banco PGlite com todas
// as migrações: no máximo 10 por demanda, V1 só com carro selecionado, fora de Lane/Run só com
// motivo, preço padrão e ajustado, MMR inválido recusado. Nenhuma rede externa, nenhuma mensagem.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');
const offer = require('../manheim-offer');

const id = (n) => `6c400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), JOURNEY = id(10), CONTACT = id(11);
const KEY = `journey:${JOURNEY}:CARRO`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Seleção','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,reference_code,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',3000000,'SELE2',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','sel-1','RESOLVED',false,now(),now(),now(),now());`,
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
const choose = (body) => call('manheim-options', '/api/panel/manheim-options', 'POST', body);

// 12 cars in Lane/Run with CR from 4.9 down to 1.9, one Buy Now and one without Lane/Run.
const car = (n, extra = {}) => {
  const vin = 'SELV' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', startsAt: '2026-10-01T15:00:00Z', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: (4.9 - n * 0.3).toFixed(1), cleanTitle: true, odometerOk: true, ...extra } };
};
const cars = [...Array.from({ length: 12 }, (_, n) => car(n)), car(20, { buyNowPrice: '26500' }), car(21, { lane: '', run: '' })];

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['MANHEIM_MATCH_AUDIT_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ name: 'SEL.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: 'e'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin', 'Lane', 'Run']], headerMap: {} });
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  const done = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'finalize', uploadId: started.payload.uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
});
test.after(async () => { if (backend) await backend.db.close(); });

const matchIdOf = async (vin) => (await backend.db.query(`select id from public.manheim_matches where vin=$1`, [vin])).rows[0].id;

test('grupos, ordem por CR e resumo sem carros', async () => {
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  const demand = view.demands.find((item) => item.key === KEY);
  assert.deepEqual([demand.offer.lane, demand.offer.offLane, demand.offer.incomplete, demand.offer.selected], [12, 1, 1, 0]);
  const page = (await call('manheim-options', `/api/panel/manheim-options?key=${KEY}&group=LANE&limit=10`)).payload;
  assert.equal(page.options.length, 10);
  assert.equal(page.total, 12);
  // Up to 5 at or above the recommended CR (2.5 for a US$ 25.000 MMR), then up to 5 below it.
  assert.deepEqual(page.options.map((option) => option.offer.cr), [4.9, 4.6, 4.3, 4.0, 3.7, 2.2, 1.9, 1.6, 3.4, 3.1]);
  assert.deepEqual(page.options.slice(5, 8).map((option) => option.offer.belowMinimum), [true, true, true]);
  assert.ok(page.nextCursor);
});

test('10 selecionados permite, o 11º é recusado; V1 só com selecionado; preço padrão e ajustado', async () => {
  const lane = await Promise.all(Array.from({ length: 12 }, (_, n) => matchIdOf('SELV' + String(n).padStart(13, '0'))));
  for (const matchId of lane.slice(0, 10)) {
    const res = await choose({ action: 'select', matchId });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  }
  const eleventh = await choose({ action: 'select', matchId: lane[10] });
  assert.equal(eleventh.statusCode, 409);
  assert.equal(eleventh.payload.error, 'MANHEIM_SELECTION_LIMIT');
  // Default markup for a US$ 25.000 MMR: 5% -> US$ 26.250. Operator's 7.5% -> US$ 26.875.
  const priced = await choose({ action: 'price', matchId: lane[0], pct: '7.5', note: 'cliente gosta de cor escura' });
  assert.deepEqual([priced.payload.defaultPct, priced.payload.manualPct, priced.payload.finalCents], [5, 7.5, 2687500]);
  assert.equal(offer.finalCents(2500000, offer.defaultPct(2500000)), 2625000);
  const reselected = await choose({ action: 'select', matchId: lane[0] });
  assert.equal(reselected.payload.manualPct, 7.5, 'o percentual manual não é sobrescrito');
  // V1: a car not selected is refused; the selected ones go in with the price, never the MMR.
  const refused = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: JOURNEY, matchIds: [lane[0], lane[11]], demandKey: KEY });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.payload.error, 'MANHEIM_OPTION_NOT_SELECTED');
  const created = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: JOURNEY, matchIds: [lane[0], lane[1]], demandKey: KEY });
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
  const { rows: snapshots } = await backend.db.query(`select vehicle_snapshot from public.vitrine_cars order by created_at`);
  assert.deepEqual(snapshots.map((row) => row.vehicle_snapshot.estimatedMarketReference).sort(), [26250, 26875]);
  assert.ok(snapshots.every((row) => row.vehicle_snapshot.averageAuctionValue === null && row.vehicle_snapshot.mmrCents === undefined));
  const publicPage = (await call('../vitrine', '/api/vitrine?token=' + created.payload.token)).payload;
  const text = JSON.stringify(publicPage);
  assert.doesNotMatch(text, /mmr|2500000|25000\b|7\.5/i, 'o cliente nunca vê MMR nem percentual');
  assert.match(text, /estimatedMarketReference/);
  // V2 from a car of this V1: refused once the car leaves the selection, accepted while selected.
  const { rows: [shown] } = await backend.db.query(`select c.id, c.vitrine_id from public.vitrine_cars c join public.manheim_matches m on m.id = c.source_match_id where m.id = $1`, [lane[1]]);
  const request = async () => (await backend.db.query(`insert into public.vitrine_requests(environment, vitrine_id, vitrine_car_id, request_kind) values ('preview', $1, $2, 'BID') returning id`, [shown.vitrine_id, shown.id])).rows[0].id;
  await choose({ action: 'remove', matchId: lane[1] });
  const v2Refused = await call('vitrines', '/api/panel/vitrines', 'POST', { action: 'create_v2', requestId: await request() });
  assert.equal(v2Refused.payload.error, 'MANHEIM_OPTION_NOT_SELECTED');
  await choose({ action: 'select', matchId: lane[1] });
  const v2 = await call('vitrines', '/api/panel/vitrines', 'POST', { action: 'create_v2', requestId: await request() });
  assert.equal(v2.statusCode, 201, JSON.stringify(v2.payload));
});

test('fora de Lane/Run só entra com inclusão manual e motivo; MMR inválido recusado', async () => {
  const buyNow = await matchIdOf('SELV0000000000020');
  const lane9 = await matchIdOf('SELV0000000000009');
  await choose({ action: 'remove', matchId: lane9 });
  const noReason = await choose({ action: 'select', matchId: buyNow });
  assert.equal(noReason.payload.error, 'MANHEIM_SELECTION_REASON_REQUIRED');
  const manual = await choose({ action: 'select', matchId: buyNow, reason: 'cliente aceita comprar no Buy Now' });
  assert.equal(manual.statusCode, 200, JSON.stringify(manual.payload));
  assert.deepEqual([manual.payload.group, manual.payload.manual, manual.payload.selectedCount], ['OFFLANE', true, 10]);
  // A match of an older import without a valid MMR (never compared today) stays refused.
  const { rows: [legacy] } = await backend.db.query(`insert into public.manheim_matches(environment, upload_id, journey_id, match_kind, row_fingerprint, vehicle_json, logical_mode, created_at)
    select environment, upload_id, journey_id, 'BATE', 'vin:SEMMMR00000000001', '{"parsed":{"year":2020,"make":"Honda","model":"CR-V"}}', 'CARRO', now() from public.manheim_matches limit 1 returning id`);
  const noMmr = await choose({ action: 'select', matchId: legacy.id });
  assert.equal(noMmr.payload.error, 'MANHEIM_MATCH_WITHOUT_MMR');
  const { rows: [audit] } = await backend.db.query(`select count(*)::int n from public.audit_log where entity_type='manheim_option_selection' and before_json is not null`);
  assert.ok(audit.n > 0, 'estado anterior registrado');
  assert.deepEqual(backend.refused, []);
  const { rows: [{ n }] } = await backend.db.query(`select count(*)::int n from public.messages`);
  assert.equal(n, 1, 'nenhuma mensagem');
});

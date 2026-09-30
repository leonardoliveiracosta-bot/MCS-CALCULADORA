'use strict';

// MMR obrigatório: um carro sem MMR válido (null, vazio, zero, negativo, "N/A", "desconhecido" ou
// texto não numérico) nunca é opção. VALOR: MMR obrigatório e dentro da faixa. CARRO: MMR
// obrigatório, mas o valor não decide; ano e milhagem decidem. Vale no matching, nos contadores,
// na releitura do lote ativo, na shortlist, em "Apresentei", na V1, na V2 e na conferência.
// Banco PGlite local e OpenAI nunca chamada.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const vehicleMatch = require('../vehicle-match');
const audit = require('../panel-manheim-audit');
const vitrines = require('../api/panel/vitrines');

const INVALID = [null, undefined, '', 0, -1500000, 'N/A', 'n/a', 'desconhecido', 'Unknown', 'abc', '21k', '$', '--'];
const id = (n) => `6b100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), CONTACT = id(2), JOURNEY = id(3), CHAT = id(4), MESSAGE = id(5), UPLOAD = id(6), OLD_UPLOAD = id(7);
const WITH = id(10), WITHOUT = id(11), OLD_WITHOUT = id(12), NA = id(13);
const wish = { make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 };
const carJson = (vin, mmrCents) => JSON.stringify({ parsed: { vin, year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents } }).replace(/'/g, "''");

function seed() {
  const match = (matchId, upload, vin, mmr) => `insert into public.manheim_matches(id,environment,upload_id,journey_id,match_kind,row_fingerprint,vehicle_json,logical_mode) values('${matchId}','preview','${upload}','${JOURNEY}','BATE','vin:${vin}','${carJson(vin, mmr)}','CARRO');`;
  return [
    `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente MMR','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [wish], logical_modes: ['CARRO'] })}',now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${CHAT}','preview','WHATSAPP','${CONTACT}','mmr','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${MESSAGE}','preview','${CHAT}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'m1',1,'WHATSAPP_WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${MESSAGE}','${JOURNEY}','IMPORT',now());`,
    `insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by,uploaded_at) values('${OLD_UPLOAD}','preview',1,10,'${ACTOR}',now()-interval '2 days');`,
    `insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by,uploaded_at) values('${UPLOAD}','preview',1,10,'${ACTOR}',now());`,
    match(OLD_WITHOUT, OLD_UPLOAD, 'OLDNOMMR', null),
    match(WITH, UPLOAD, 'WITHMMR', 3000000),
    match(WITHOUT, UPLOAD, 'NOMMR', null),
    match(NA, UPLOAD, 'ZEROMMR', 0)
  ].join('\n');
}

let backend, ctx;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.MANHEIM_MATCH_AUDIT_ENABLED; delete process.env.OPENAI_API_KEY;
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: ACTOR, role: 'admin' } };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('regra: todo MMR inválido é recusado, nos dois modos', () => {
  for (const value of INVALID) assert.equal(vehicleMatch.validMmrCents(value), null, String(value));
  assert.equal(vehicleMatch.validMmrCents(3000000), 3000000);
  const car = (mmrCents) => ({ year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents });
  const carro = { mode: 'CARRO', wishes: [wish] };
  const valor = { mode: 'VALOR', wishes: [{ make: 'Honda', model: 'CR-V' }], bidCents: 3000000 };
  for (const value of INVALID) {
    assert.equal(vehicleMatch.matchDemand(car(value), carro), null, 'CARRO ' + String(value));
    assert.equal(vehicleMatch.matchDemand(car(value), valor), null, 'VALOR ' + String(value));
  }
  // VALOR: required and inside the band. CARRO: required, the amount decides nothing.
  assert.equal(vehicleMatch.matchDemand(car(3000000), valor).kind, 'POR_VALOR');
  assert.equal(vehicleMatch.matchDemand(car(9900000), valor), null);
  assert.equal(vehicleMatch.matchDemand(car(9900000), carro).kind, 'BATE');
  assert.equal(vehicleMatch.matchDemand({ ...car(3000000), year: 2015 }, carro), null, 'ano ainda decide em CARRO');
  assert.equal(vehicleMatch.matchDemand({ ...car(3000000), miles: 90000 }, carro), null, 'milhagem ainda decide em CARRO');
});

test('releitura do lote ativo, contadores e shortlist: só o carro com MMR', async () => {
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(view.upload.id, UPLOAD);
  // Re-reading the active batch drops the stored cars without MMR (and the older batch is not active).
  // No car travels in the summary: the options of the demand come page by page.
  assert.equal(view.matches, undefined);
  const options = (await call('manheim-options', `/api/panel/manheim-options?key=journey:${JOURNEY}:CARRO`)).payload.options;
  assert.deepEqual(options.map((match) => match.id), [WITH]);
  assert.equal(view.counts.CARRO.matches, 1);
  assert.equal(view.counts.total.matches, 1);
  // CLIENTES list and ficha counters.
  const list = (await call('records', '/api/panel/records?sort=ready')).payload.items;
  assert.equal(list.find((item) => item.id === JOURNEY).manheimMatchCount, 1);
  const detail = (await call('records', '/api/panel/records?id=' + JOURNEY)).payload;
  assert.equal((detail.item || detail).manheimMatchCount, 1);
  // BUSCAS counter and the Manheim report.
  const searches = (await call('searches', '/api/panel/searches')).payload;
  const entry = (searches.items || []).find((item) => item.journeyId === JOURNEY);
  assert.ok(entry, 'a demanda aparece em BUSCAS');
  assert.equal(entry.matchCount, 1);
  const report = (await call('report', '/api/panel/report?view=manheim&period=30')).payload;
  assert.equal(report.summary.compatibleCars, 1);
});

test('"Apresentei ao cliente", V1 e V2 recusam carro sem MMR', async () => {
  const present = await call('actions', '/api/panel/actions', 'POST', { action: 'unit', journeyId: JOURNEY, manheimMatchId: WITHOUT, status: 'PRESENTED' });
  assert.deepEqual([present.statusCode, present.payload.error], [409, 'MANHEIM_MATCH_WITHOUT_MMR']);
  const v1 = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: JOURNEY, matchIds: [WITH, WITHOUT] });
  assert.deepEqual([v1.statusCode, v1.payload.error], [409, 'MANHEIM_MATCH_WITHOUT_MMR']);
  const zero = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: JOURNEY, matchIds: [NA] });
  assert.equal(zero.payload.error, 'MANHEIM_MATCH_WITHOUT_MMR');
  assert.equal(Number((await backend.db.query('select count(*) n from public.vitrines')).rows[0].n), 0, 'nenhuma V1 criada');
  // V2 from a V1 car whose source match has no MMR (an old vitrine): refused.
  const services = {
    rows: async (_ctx, table) => table === 'vitrine_requests' ? [{ id: id(20), vitrine_id: id(21), vitrine_car_id: id(22), treated_at: null }]
      : table === 'vitrines' ? [{ id: id(21), journey_id: JOURNEY, contact_id: CONTACT, reference_code: 'ABCDE' }]
      : table === 'vitrine_cars' ? [{ id: id(22), vitrine_id: id(21), source_match_id: WITHOUT, vehicle_snapshot: { year: 2020 } }]
      : table === 'manheim_matches' ? [{ id: WITHOUT, vehicle_json: { parsed: { year: 2020, mmrCents: null } } }] : [],
    insert: async () => { throw new Error('nada deveria ser criado'); }, activeFilter: async () => ({})
  };
  assert.deepEqual(await vitrines.createV2(ctx, { requestId: id(20) }, services), { error: 'MANHEIM_MATCH_WITHOUT_MMR' });
  // The car with MMR, once selected for the customer, still makes a V1.
  const picked = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'select', matchId: WITH, reason: 'carro de teste escolhido' });
  assert.equal(picked.statusCode, 200, JSON.stringify(picked.payload));
  const ok = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: JOURNEY, matchIds: [WITH] });
  assert.equal(ok.statusCode, 201);
});

test('conferência: carro sem MMR é divergência dura nos dois modos', () => {
  const demands = ['CARRO', 'VALOR'].map((mode) => ({ key: `journey:${JOURNEY}:${mode}`, mode, journeyId: JOURNEY, activeWishes: mode === 'CARRO' ? [wish] : [{ make: 'Honda', model: 'CR-V' }], bidCents: mode === 'VALOR' ? 3000000 : null, active: true, issues: [] }));
  for (const value of INVALID) {
    const matches = demands.map((demand, index) => ({ id: id(100 + index), journey_id: JOURNEY, logical_mode: demand.mode, demandKey: demand.key, match_kind: demand.mode === 'CARRO' ? 'BATE' : 'POR_VALOR', vehicle_json: { parsed: { vin: 'V' + index, year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: value } } }));
    const groups = audit.buildGroups({ upload: { id: UPLOAD }, demands, matches, base: { journeyById: new Map([[JOURNEY, { id: JOURNEY, status: 'ATIVO', contact: { is_lead: true } }]]), refsOf: () => [], calcRuns: [] } });
    groups.forEach((group) => assert.deepEqual(group.divergences.map((item) => item.code), ['MMR_MISSING'], group.mode + ' ' + String(value)));
  }
});

test('V2 com source_match_id cujo match original não existe: bloqueada, nenhuma vitrine nem vitrine_car', async () => {
  const inserts = [];
  const services = {
    rows: async (_ctx, table, query = {}) => table === 'vitrine_requests' ? [{ id: id(30), vitrine_id: id(31), vitrine_car_id: id(32), treated_at: null }]
      : table === 'vitrines' ? (query.parent_vitrine_id ? [] : [{ id: id(31), journey_id: JOURNEY, contact_id: CONTACT, reference_code: 'ABCDE' }])
      : table === 'vitrine_cars' ? (query.short_code ? [] : [{ id: id(32), vitrine_id: id(31), source_match_id: id(33), vehicle_snapshot: { year: 2020, make: 'Honda', model: 'CR-V' } }])
      : table === 'manheim_matches' ? [] : table === 'journeys' ? [{ id: JOURNEY, budget_cents: 3000000 }] : [],
    insert: async (_ctx, table, row) => { inserts.push(table); return [{ id: id(34), ...row }]; },
    patchRows: async () => null, activeFilter: async () => ({})
  };
  assert.deepEqual(await vitrines.createV2(ctx, { requestId: id(30) }, services), { error: 'VITRINE_SOURCE_MISSING' });
  assert.deepEqual(inserts, [], 'nenhuma vitrine e nenhum vitrine_car');
  // Same V1 car with its original match present and a valid MMR: the V2 is created.
  services.rows = ((base) => async (context, table, query) => table === 'manheim_matches' ? [{ id: id(33), vehicle_json: { parsed: { year: 2020, mmrCents: 3000000 } } }] : base(context, table, query))(services.rows);
  const created = await vitrines.createV2(ctx, { requestId: id(30) }, services);
  assert.ok(created.token, JSON.stringify(created));
  assert.deepEqual(inserts, ['vitrines', 'vitrine_cars']);
});

test('contador do lote: operacional recalculado com o MMR obrigatório, nunca o número congelado', async () => {
  // An earlier batch, still active, frozen at 3 matched cars: one with MMR, two without.
  const EARLIER = id(40);
  await backend.db.query(`insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,matched_vehicle_count,created_by,uploaded_at) values('${EARLIER}','preview',1,50,3,'${ACTOR}',now()-interval '1 day')`);
  const add = (n, vin, mmr) => backend.db.query(`insert into public.manheim_matches(id,environment,upload_id,journey_id,match_kind,row_fingerprint,vehicle_json,logical_mode) values('${id(n)}','preview','${EARLIER}','${JOURNEY}','BATE','vin:${vin}','${carJson(vin, mmr)}','CARRO')`);
  await add(41, 'EARLYMMR', 2900000); await add(42, 'EARLYNULL', null); await add(43, 'EARLYNA', 'N/A');
  // The active batch was also frozen with its three stored matches (one with MMR).
  await backend.db.query(`update public.manheim_uploads set matched_vehicle_count=3 where id='${UPLOAD}'`);
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  const earlier = view.uploads.find((batch) => batch.id === EARLIER);
  assert.deepEqual([earlier.frozenMatchCount, earlier.matchCount], [3, 1], 'lote anterior: 1 operacional, não 3');
  const current = view.uploads.find((batch) => batch.id === UPLOAD);
  assert.deepEqual([current.frozenMatchCount, current.matchCount], [3, 1]);
  assert.deepEqual([view.upload.frozen_matched_vehicle_count, view.upload.matched_vehicle_count], [3, 1], 'o resumo do lote ativo usa o operacional');
});

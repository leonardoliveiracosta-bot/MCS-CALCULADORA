'use strict';

// ENVIAR OPÇÕES · pedidos POR CARRO: carros "Próximo" (ano 1 a menos ou 1 a mais do pedido, milhas até 15% acima
// do máximo), com os handlers reais contra o banco PGlite com todas as migrações. O que já existia não muda:
// a importação continua só com os exatos, POR VALOR e pedido com valor informado ficam como estão, e a passada
// "Próximo" só acrescenta (linhas existentes idênticas). Caso real: Urus 2025–2026 e um Urus 2024 no lote.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const vehicleMatch = require('../vehicle-match');
const batchRules = require('../panel-manheim-batch');

const id = (n) => `6c700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const J = { urus: id(10), civic: id(20), valor: id(30) };
const URUS = { make: 'Lamborghini', model: 'Urus', trim: 'SE', yearMin: 2025, yearMax: 2026, minMiles: 1000, maxMiles: 50000 };
const CIVIC = { make: 'Honda', model: 'Civic', yearMin: 2020, yearMax: 2021, minMiles: 1000, maxMiles: 60000, budgetUsd: 30000, budgetExplicit: true };

function person(n, journey, criteria, extra = '') {
  const contact = id(n + 1), chat = id(n + 2), message = id(n + 3);
  return [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Cliente ${n}','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify(criteria)}',${extra || 'null'},now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','proximo-${n}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','Quero um carro','x',now(),'proximo-${n}',0,'WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`
  ].join('\n');
}
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  person(10, J.urus, { wishlists: [URUS], logical_modes: ['CARRO'] }),
  person(20, J.civic, { wishlists: [CIVIC], logical_modes: ['CARRO'] }),
  person(30, J.valor, { wishlists: [{ make: 'Toyota', model: 'Camry' }], logical_modes: ['VALOR'] }, '2000000')
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const batch = (body) => call('manheim-batch', '/api/panel/manheim-batch', 'POST', body);
const later = new Date(Date.now() + 3 * 86400000).toISOString();
const car = (vin, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { lane: '6', run: String(Number(vin.slice(-2))), vin, year: 2025, make: 'Lamborghini', model: 'Urus', trim: 'S', miles: 7902, mmrCents: 23400000, location: 'NJ - Manheim NY Metro Skyline', lot: 'L' + vin.slice(-3), cleanTitle: true, odometerOk: true, conditionGrade: '4.9', startsAt: later, saleDate: later, ...extra } });
const CARS = [
  car('URUS000000000001'),                                   // exato
  car('URUS000000000002', { year: 2024, miles: 4544 }),      // próximo: ano 1 a menos (o caso do Urus 2024)
  car('URUS000000000003', { year: 2025, miles: 57500 }),     // próximo: 15% acima do máximo (limite)
  car('URUS000000000004', { year: 2025, miles: 57501 }),     // fora: passou dos 15%
  car('URUS000000000005', { year: 2023, miles: 3000 }),      // fora: 2 anos a menos
  car('CIVC000000000006', { make: 'Honda', model: 'Civic', trim: 'EX', year: 2019, miles: 20000, mmrCents: 2000000 }), // pedido com valor: sem próximo
  car('CAMR000000000007', { make: 'Toyota', model: 'Camry', trim: 'SE', year: 2021, miles: 30000, mmrCents: 2000000 })   // POR VALOR
];
const { contentHash } = batchRules;
function startBody(files, clientKey) {
  const manifest = files.map((file) => {
    const vehicleCount = file.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    return { name: file.name, size: file.size, rowCount: vehicleCount, vehicleCount, chunkCount: file.chunks.length, chunks: file.chunks.map((chunk) => ({ count: chunk.length, hash: contentHash(chunk) })) };
  });
  return { action: 'start', clientKey, vehicleCount: manifest.reduce((sum, file) => sum + file.vehicleCount, 0), files: manifest, manifestHash: contentHash(manifest), headers: [['Vin', 'Year', 'Make', 'Model', 'Odometer', 'MMR']], headerMap: { files: [{ vin: 'Vin' }] } };
}
const KEY = `journey:${J.urus}:CARRO`;
const rowsOf = async (key, active = true) => (await backend.db.query(`select id, row_fingerprint, match_kind, match_reason, sort_rank, vehicle_json, undone_at, created_at from public.manheim_matches where upload_id=$1 and demand_key=$2 ${active ? 'and undone_at is null' : ''} order by row_fingerprint`, [uploadId, key])).rows;

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.MANHEIM_MATCH_AUDIT_ENABLED; delete process.env.OPENAI_API_KEY; delete process.env.MANHEIM_OPENAI_ENABLED;
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

test('regra: a exata não muda; próximo só POR CARRO, ano ±1 e até 15% a mais de milhas, sem pedido com valor', () => {
  const urus = { mode: 'CARRO', wishes: [URUS] };
  const v = (vin) => CARS.find((item) => item.vehicle.vin === vin).vehicle;
  // A regra exata de sempre: o Urus 2024 não bate.
  assert.equal(vehicleMatch.matchDemand(v('URUS000000000002'), urus), null);
  assert.equal(vehicleMatch.matchDemand(v('URUS000000000001'), urus).basis, 'CRITERIA');
  const near = vehicleMatch.matchCarroNear(v('URUS000000000002'), urus);
  assert.deepEqual([near.kind, near.basis, near.near, near.notice], ['BATE', 'CRITERIA_NEAR', true, 'Próximo · ano 2024 (pedido 2025–2026)']);
  assert.equal(vehicleMatch.matchCarroNear(v('URUS000000000003'), urus).notice, 'Próximo · 57.500 milhas (pedido até 50.000)');
  assert.equal(vehicleMatch.matchCarroNear({ ...v('URUS000000000001'), year: 2027 }, urus).notice, 'Próximo · ano 2027 (pedido 2025–2026)');
  for (const vin of ['URUS000000000001', 'URUS000000000004', 'URUS000000000005']) assert.equal(vehicleMatch.matchCarroNear(v(vin), urus), null, vin);
  assert.equal(vehicleMatch.matchCarroNear({ ...v('URUS000000000002'), miles: 900 }, urus), null, 'milhas abaixo do mínimo continuam fora');
  assert.equal(vehicleMatch.matchCarroNear(v('URUS000000000002'), { ...urus, mode: 'VALOR', bidCents: 25000000 }), null, 'POR VALOR nunca');
  assert.equal(vehicleMatch.matchCarroNear(v('CIVC000000000006'), { mode: 'CARRO', wishes: [CIVIC] }), null, 'desejo com valor informado fica de fora');
  const entry = (vin) => ({ fingerprint: 'vin:' + vin, makeKey: batchRules.makeKey(v(vin).make), mmrCents: v(vin).mmrCents, vehicle: v(vin) });
  const target = { key: KEY, mode: 'CARRO', targetType: 'JOURNEY', journeyId: J.urus, wishes: [URUS] };
  const exact = batchRules.matchChunk(['URUS000000000001', 'URUS000000000002', 'URUS000000000003'].map(entry), [target]);
  assert.deepEqual(exact.map((row) => row.fingerprint), ['vin:URUS000000000001'], 'a comparação exata continua igual');
  const rows = batchRules.nearRows(['URUS000000000001', 'URUS000000000002', 'URUS000000000003'].map(entry), target);
  assert.deepEqual(rows.map((row) => [row.fingerprint, row.kind, row.sortRank, row.vehicle.parsed.matchNear]), [['vin:URUS000000000002', 'BATE', 1, true], ['vin:URUS000000000003', 'BATE', 1, true]]);
  assert.deepEqual(batchRules.nearRows(rows.map(() => entry('URUS000000000002')), { ...target, reactivation: true }), [], 'ficha parada só volta com exato');
});

let uploadId, before;
test('importação: igual a hoje, só os exatos', async () => {
  const files = [{ name: 'MCS_01.csv', size: 1000, chunks: [CARS] }];
  const started = await batch(startBody(files, 'c'.repeat(32)));
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  uploadId = started.payload.uploadId;
  assert.equal((await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 0, vehicles: CARS })).statusCode, 200);
  const done = await batch({ action: 'finalize', uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
  assert.deepEqual((await rowsOf(KEY)).map((row) => row.row_fingerprint), ['vin:URUS000000000001']);
  assert.deepEqual((await rowsOf(`journey:${J.civic}:CARRO`)).map((row) => row.row_fingerprint), []);
  assert.deepEqual((await rowsOf(`journey:${J.valor}:VALOR`)).map((row) => row.row_fingerprint), ['vin:CAMR000000000007']);
  before = (await backend.db.query(`select id, demand_key, match_kind, match_reason, sort_rank, vehicle_json, undone_at from public.manheim_matches where upload_id=$1 order by id`, [uploadId])).rows;
});

test('passada "Próximo": só acrescenta; o que existia fica idêntico; POR VALOR e pedido com valor intactos', async () => {
  const sync = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'sync' });
  assert.equal(sync.statusCode, 200, JSON.stringify(sync.payload));
  assert.ok(sync.payload.near && sync.payload.near.synced >= 2, JSON.stringify(sync.payload));
  const urus = await rowsOf(KEY);
  assert.deepEqual(urus.map((row) => [row.row_fingerprint, row.sort_rank, row.vehicle_json.parsed.matchNear === true]),
    [['vin:URUS000000000001', 0, false], ['vin:URUS000000000002', 1, true], ['vin:URUS000000000003', 1, true]]);
  assert.equal(urus[1].match_reason, 'Próximo · ano 2024 (pedido 2025–2026)');
  // Every row that existed is exactly as it was.
  const { rows: after } = await backend.db.query(`select id, demand_key, match_kind, match_reason, sort_rank, vehicle_json, undone_at from public.manheim_matches where upload_id=$1 order by id`, [uploadId]);
  const byId = new Map(after.map((row) => [row.id, row]));
  for (const row of before) assert.deepEqual(byId.get(row.id), row, row.id);
  assert.equal(after.length, before.length + 2, 'só os dois próximos do Urus entraram');
  // Again: nothing pending, nothing added.
  const again = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'sync' });
  assert.equal(again.payload.near, undefined, JSON.stringify(again.payload));
  assert.equal((await backend.db.query(`select count(*)::int n from public.manheim_matches where upload_id=$1`, [uploadId])).rows[0].n, after.length);
  // The existing sync table was not touched by this rule.
  const { rows: syncs } = await backend.db.query(`select demand_key from public.manheim_demand_syncs where upload_id=$1`, [uploadId]);
  assert.deepEqual(syncs, []);
});

test('lista: exatos primeiro, depois os próximos com o selo; pedido sai de "sem resultado"; seleção normal', async () => {
  for (const sort of ['cr', 'miles_asc', 'miles_desc', 'year_desc', 'mmr_desc']) {
    const page = (await call('manheim-options', `/api/panel/manheim-options?key=${KEY}&group=LANE&sort=${sort}&limit=10`)).payload;
    assert.deepEqual(page.options.map((option) => option.vehicle_json.parsed.vin), ['URUS000000000001', ...page.options.slice(1).map((option) => option.vehicle_json.parsed.vin)], sort);
    assert.deepEqual(page.options.map((option) => option.vehicle_json.parsed.matchNear === true), [false, true, true], sort);
  }
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(view.demands.find((demand) => demand.key === KEY).matchCount, 3);
  const near = (await rowsOf(KEY)).find((row) => row.row_fingerprint === 'vin:URUS000000000002');
  const selected = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'select', matchId: near.id });
  assert.equal(selected.statusCode, 200, JSON.stringify(selected.payload));
  assert.equal(selected.payload.status, 'SELECTED');
});

test('"Comparar de novo": exatos como sempre; os próximos continuam (o selecionado também)', async () => {
  const rematch = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'rematch', key: KEY });
  assert.equal(rematch.statusCode, 200, JSON.stringify(rematch.payload));
  assert.deepEqual((await rowsOf(KEY)).map((row) => [row.row_fingerprint, row.vehicle_json.parsed.matchNear === true]),
    [['vin:URUS000000000001', false], ['vin:URUS000000000002', true], ['vin:URUS000000000003', true]]);
  const { rows: [chosen] } = await backend.db.query(`select status from public.manheim_option_selections s join public.manheim_matches m on m.id=s.match_id where m.upload_id=$1 and m.row_fingerprint='vin:URUS000000000002'`, [uploadId]);
  assert.equal(chosen.status, 'SELECTED');
  assert.deepEqual((await rowsOf(`journey:${J.valor}:VALOR`)).map((row) => row.row_fingerprint), ['vin:CAMR000000000007']);
});

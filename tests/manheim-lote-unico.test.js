'use strict';

// Importação do Manheim em lote único e blocos retomáveis, com os handlers reais contra um banco
// PGlite com todas as migrações: um lote para vários arquivos, deduplicação global, bloco reenviado
// sem duplicar, ativação só no fim, montagem invisível, cancelamento, MMR obrigatório, resumo por
// demanda sem carros, páginas estáveis por cursor, critério mudado e nova comparação dirigida, e
// nenhuma tela comum lendo o inventário. Nenhuma rede externa.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const id = (n) => `6c200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const J = { carro: id(10), valor: id(20), off: id(30) };
const CARRO_WISH = { make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 };

function person(n, journey, criteria, extra = '') {
  const contact = id(n + 1), chat = id(n + 2), message = id(n + 3);
  return [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Cliente ${n}','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify(criteria)}',${extra || 'null'},now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','lote-${n}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','Quero um carro','x',now(),'m${n}',1,'WHATSAPP_WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`
  ].join('\n');
}
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  person(10, J.carro, { wishlists: [CARRO_WISH], logical_modes: ['CARRO'] }),
  person(20, J.valor, { wishlists: [{ make: 'Toyota', model: 'Camry' }], logical_modes: ['VALOR'] }, '2000000'),
  person(30, J.off, { wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const batch = (body) => call('manheim-batch', '/api/panel/manheim-batch', 'POST', body);

// Cars as the browser sends them (already read by the panel parser).
const car = (vin, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 30000, mmrCents: 2500000, location: 'FL - Orlando', lot: 'L' + vin.slice(-3), cleanTitle: true, odometerOk: true, ...extra } });
const camry = (vin, mmrCents) => car(vin, { make: 'Toyota', model: 'Camry', mmrCents });

function startBody(files, clientKey) {
  return {
    action: 'start', clientKey, vehicleCount: files.reduce((sum, file) => sum + file.vehicleCount, 0),
    files, headers: [['Vin', 'Year', 'Make', 'Model', 'Odometer', 'MMR']], headerMap: { files: [{ vin: 'Vin' }] }
  };
}

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.MANHEIM_MATCH_AUDIT_ENABLED; delete process.env.OPENAI_API_KEY; delete process.env.MANHEIM_OPENAI_ENABLED;
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

let uploadId;
test('dois arquivos formam um lote; montagem invisível; bloco reenviado não duplica; ativação só no fim', async () => {
  // File 1: 2 blocks. File 2: 1 block with a VIN already in file 1 and one car without MMR.
  const fileA1 = [car('VINA00000000001'), car('VINA00000000002', { miles: 70000 }), camry('VINC00000000001', 2000000)];
  const fileA2 = [car('VINA00000000003', { year: 2021, miles: 12000 }), camry('VINC00000000002', 9000000)];
  const fileB = [car('VINA00000000001'), car('VINB00000000001', { mmrCents: null }), car('VINB00000000002', { mmrCents: 0 }), camry('VINC00000000003', 1500000)];
  const started = await batch(startBody([
    { name: 'MCS_01.csv', size: 1000, rowCount: 5, vehicleCount: 5, chunkCount: 2 },
    { name: 'MCS_02.csv', size: 800, rowCount: 4, vehicleCount: 4, chunkCount: 1 }
  ], 'a'.repeat(32)));
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  uploadId = started.payload.uploadId;
  assert.ok(started.payload.targetCount >= 2);

  // Same selection again (page reload): same batch, nothing duplicated.
  const again = await batch(startBody([
    { name: 'MCS_01.csv', size: 1000, rowCount: 5, vehicleCount: 5, chunkCount: 2 },
    { name: 'MCS_02.csv', size: 800, rowCount: 4, vehicleCount: 4, chunkCount: 1 }
  ], 'a'.repeat(32)));
  assert.equal(again.payload.uploadId, uploadId);
  assert.equal(again.payload.resumed, true);

  let res = await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 0, vehicles: fileA1 });
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.storedVehicles, 3);
  // While being assembled the batch is never shown.
  const hidden = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(hidden.upload, null);
  assert.equal(hidden.uploads.length, 0);
  // Finalizing with a block missing is refused and nothing becomes active.
  const early = await batch({ action: 'finalize', uploadId });
  assert.equal(early.statusCode, 409);
  assert.equal(early.payload.error, 'MANHEIM_BATCH_INCOMPLETE');

  res = await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 1, vehicles: fileA2 });
  assert.equal(res.statusCode, 200);
  // A failure after the block reached the server: the client sends it again.
  const repeat = await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 1, vehicles: fileA2 });
  assert.equal(repeat.statusCode, 200);
  assert.equal(repeat.payload.storedVehicles, 0);
  assert.equal(repeat.payload.storedMatches, 0);
  const status = (await batch({ action: 'status', uploadId })).payload;
  assert.deepEqual(status.received, [[0, 0], [0, 1]]);
  assert.equal(status.files[0].received, 2);
  assert.equal(status.files[1].received, 0);

  res = await batch({ action: 'chunk', uploadId, fileIndex: 1, chunkIndex: 0, vehicles: fileB });
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.storedVehicles, 3, 'o VIN repetido entre arquivos não entra de novo');
  const done = await batch({ action: 'finalize', uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
  assert.equal(done.payload.fileCount, 2);
  assert.equal(done.payload.vehicleCount, 8);

  const { rows: stored } = await backend.db.query(`select row_fingerprint, make_key, mmr_cents from public.manheim_vehicles where upload_id=$1`, [uploadId]);
  assert.equal(stored.length, 8);
  assert.equal(new Set(stored.map((row) => row.row_fingerprint)).size, 8);
  const { rows: matches } = await backend.db.query(`select row_fingerprint, demand_key, match_kind, mmr_cents, logical_mode from public.manheim_matches where upload_id=$1`, [uploadId]);
  // CARRO: VINA01 (ok), VINA02 (70k miles out), VINA03 (ok), VINB01/B02 without MMR never.
  // VALOR (bid 20k, 70% to 115%): VINC01 (20k ok), VINC02 (90k out), VINC03 (15k ok).
  const carro = matches.filter((row) => row.demand_key === `journey:${J.carro}:CARRO`).map((row) => row.row_fingerprint).sort();
  assert.deepEqual(carro, ['vin:VINA00000000001', 'vin:VINA00000000003']);
  const valor = matches.filter((row) => row.demand_key === `journey:${J.valor}:VALOR`).map((row) => row.row_fingerprint).sort();
  assert.deepEqual(valor, ['vin:VINC00000000001', 'vin:VINC00000000003']);
  assert.ok(matches.every((row) => Number(row.mmr_cents) > 0), 'nenhum match sem MMR');
  assert.equal(new Set(matches.map((row) => row.row_fingerprint + row.demand_key)).size, matches.length, 'nenhum match duplicado');

  const { rows: [upload] } = await backend.db.query(`select source_file_count, activated_at, undone_at from public.manheim_uploads where id=$1`, [uploadId]);
  assert.equal(upload.source_file_count, 2);
  assert.ok(upload.activated_at);
  // A block after activation is refused (the batch is closed), the same block is answered as done.
  assert.equal((await batch({ action: 'chunk', uploadId, fileIndex: 1, chunkIndex: 0, vehicles: fileB })).payload.duplicate, true);
});

test('BUSCAS: resumo por demanda sem carro nenhum; opções em páginas estáveis', async () => {
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(view.upload.id, uploadId);
  assert.equal(view.matches, undefined, 'a primeira resposta não traz carros');
  assert.equal(view.targets, undefined);
  const carro = view.demands.find((demand) => demand.key === `journey:${J.carro}:CARRO`);
  assert.equal(carro.matchCount, 2);
  assert.equal(carro.stale, false);
  assert.equal(view.counts.CARRO.matches, 4, 'duas fichas CARRO com dois carros cada');
  assert.equal(view.counts.VALOR.matches, 2);
  assert.equal(view.uploads.length, 1);
  assert.equal(view.uploads[0].fileCount, 2);

  const first = (await call('manheim-options', `/api/panel/manheim-options?key=journey:${J.carro}:CARRO&limit=1`)).payload;
  assert.equal(first.options.length, 1);
  assert.equal(first.options[0].vehicle_json.parsed.miles, 12000, 'menor milhagem primeiro');
  assert.equal(first.options[0].vehicle_json.parsed.lot, 'L003');
  assert.equal(first.options[0].vehicle_json.raw, undefined);
  assert.ok(first.nextCursor);
  const second = (await call('manheim-options', `/api/panel/manheim-options?key=journey:${J.carro}:CARRO&limit=1&cursor=${first.nextCursor}`)).payload;
  assert.equal(second.options.length, 1);
  assert.notEqual(second.options[0].id, first.options[0].id);
  assert.equal(second.nextCursor, null);
  // The same car also fits the other active CARRO ficha.
  assert.ok(first.options[0].alsoFitsFor.length >= 1);
  const bad = await call('manheim-options', '/api/panel/manheim-options?key=journey:x:CARRO');
  assert.equal(bad.statusCode, 400);
});

test('critério mudou: "Conferir novamente" e nova comparação dirigida só da demanda', async () => {
  // The customer now wants only 2021-2022.
  await backend.db.query(`update public.journeys set criteria_json=$2 where id=$1`, [J.carro, JSON.stringify({ wishlists: [{ ...CARRO_WISH, yearMin: 2021 }], logical_modes: ['CARRO'] })]);
  let view = (await call('records', '/api/panel/records?view=manheim')).payload;
  let carro = view.demands.find((demand) => demand.key === `journey:${J.carro}:CARRO`);
  assert.equal(carro.stale, true);
  const page = (await call('manheim-options', `/api/panel/manheim-options?key=journey:${J.carro}:CARRO&limit=10`)).payload;
  assert.deepEqual(page.options.map((option) => option.criteriaChanged).sort(), [false, true]);
  const rematch = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'rematch', key: `journey:${J.carro}:CARRO` });
  assert.equal(rematch.statusCode, 200, JSON.stringify(rematch.payload));
  assert.equal(rematch.payload.withdrawn, 1);
  view = (await call('records', '/api/panel/records?view=manheim')).payload;
  carro = view.demands.find((demand) => demand.key === `journey:${J.carro}:CARRO`);
  assert.equal(carro.stale, false);
  assert.equal(carro.matchCount, 1);
  // The other ficha was not touched.
  assert.equal(view.demands.find((demand) => demand.key === `journey:${J.off}:CARRO`).matchCount, 2);
  // Nothing was deleted: the withdrawn option stays in the database with undone_at.
  const { rows: [{ count }] } = await backend.db.query(`select count(*)::int from public.manheim_matches where upload_id=$1 and demand_key=$2`, [uploadId, `journey:${J.carro}:CARRO`]);
  assert.equal(count, 2);
});

test('montagem cancelada nunca aparece; retomada responde os blocos confirmados', async () => {
  const started = await batch(startBody([{ name: 'X.csv', size: 10, rowCount: 1, vehicleCount: 1, chunkCount: 1 }], 'b'.repeat(32)));
  const other = started.payload.uploadId;
  await batch({ action: 'chunk', uploadId: other, fileIndex: 0, chunkIndex: 0, vehicles: [car('VINZ00000000001')] });
  const resumed = await batch(startBody([{ name: 'X.csv', size: 10, rowCount: 1, vehicleCount: 1, chunkCount: 1 }], 'b'.repeat(32)));
  assert.deepEqual(resumed.payload.received, [[0, 0]]);
  const canceled = await batch({ action: 'cancel', uploadId: other });
  assert.equal(canceled.payload.canceled, true);
  assert.equal((await batch({ action: 'finalize', uploadId: other })).payload.error, 'MANHEIM_BATCH_CANCELED');
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(view.upload.id, uploadId, 'o lote ativo continua o mesmo');
  assert.ok(!view.uploads.some((row) => row.id === other));
});

test('CLIENTES, HOJE, ficha e sessão nunca leem o inventário nem os matches', async () => {
  const before = backend.calls.length;
  await call('records', '/api/panel/records?sort=ready');
  await call('today', '/api/panel/today');
  await call('records', '/api/panel/records?id=' + J.carro);
  await call('session', '/api/panel/session');
  // Only the presented cars (units already created by a person) are read, by their own index.
  const touched = backend.calls.slice(before).filter((entry) => /\/rest\/v1\/(manheim_vehicles|manheim_matches)\b/.test(entry.path) && !/presented_unit_id=not\.is\.null/.test(entry.search));
  assert.deepEqual(touched, []);
  const list = (await call('records', '/api/panel/records?sort=ready')).payload.items;
  assert.equal(list.find((item) => item.id === J.off).manheimMatchCount, 2);
});

test('fluxo antigo em partes responde como substituído', async () => {
  const res = await call('actions', '/api/panel/actions', 'POST', { action: 'manheim_upload_part', uploadId: null, partIndex: 1, partCount: 1, matches: [] });
  assert.equal(res.statusCode, 410);
  assert.equal(res.payload.error, 'MANHEIM_FLOW_REPLACED');
  assert.deepEqual(backend.refused, []);
});

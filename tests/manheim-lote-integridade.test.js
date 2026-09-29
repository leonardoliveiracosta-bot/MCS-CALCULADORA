'use strict';

// Integridade do lote Manheim, com os handlers reais contra um banco PGlite com todas as
// migrações: o bloco vale pelo conteúdo (hash no manifesto), repetir não grava nada, conteúdo
// diferente é recusado sem gravar nada, a retomada nunca continua em silêncio e a ativação confere
// blocos, hashes e quantidades. Nenhuma rede externa, nenhuma mensagem.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const id = (n) => `6c300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const J = { carro: id(10), valor: id(20) };
const WISH = { make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 };

function person(n, journey, criteria, budget = 'null') {
  const contact = id(n + 1), chat = id(n + 2), message = id(n + 3);
  return [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Cliente ${n}','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify(criteria)}',${budget},now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','integ-${n}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','Quero um carro','x',now(),'i${n}',1,'WHATSAPP_WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`
  ].join('\n');
}
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  person(10, J.carro, { wishlists: [WISH], logical_modes: ['CARRO'] }),
  person(20, J.valor, { wishlists: [{ make: 'Toyota', model: 'Camry' }], logical_modes: ['VALOR'] }, '2000000')
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const batch = (body) => call('manheim-batch', '/api/panel/manheim-batch', 'POST', body);

const car = (vin, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 30000, mmrCents: 2500000, location: 'FL - Orlando', lot: 'L' + vin.slice(-3), cleanTitle: true, odometerOk: true, ...extra } });
const cars = (prefix, count, extra) => Array.from({ length: count }, (_, n) => car(prefix + String(n).padStart(17 - prefix.length, '0'), extra));

// The manifest the browser builds: per file, per block, count and content hash.
function manifestOf(files) {
  return files.map((file) => {
    const vehicleCount = file.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    return { name: file.name, size: file.size || 100, rowCount: vehicleCount, vehicleCount, chunkCount: file.chunks.length, chunks: file.chunks.map((chunk) => ({ count: chunk.length, hash: contentHash(chunk) })) };
  });
}
function startBody(files, clientKey, patch) {
  const manifest = manifestOf(files);
  if (patch) patch(manifest);
  return {
    action: 'start', clientKey, vehicleCount: manifest.reduce((sum, file) => sum + file.vehicleCount, 0), files: manifest, manifestHash: contentHash(manifest),
    headers: [['Vin', 'Year', 'Make', 'Model', 'Odometer', 'MMR']], headerMap: { files: [{ vin: 'Vin' }] }
  };
}
async function counts(uploadId) {
  const { rows: [row] } = await backend.db.query(`select
    (select count(*)::int from public.manheim_vehicles where upload_id=$1) vehicles,
    (select count(*)::int from public.manheim_matches where upload_id=$1) matches,
    (select count(*)::int from public.manheim_upload_chunks where upload_id=$1) chunks,
    (select coalesce(sum(stored_vehicle_count),0)::int from public.manheim_upload_chunks where upload_id=$1) stored,
    (select coalesce(sum(match_count),0)::int from public.manheim_upload_chunks where upload_id=$1) match_count,
    (select activated_at from public.manheim_uploads where id=$1) activated_at`, [uploadId]);
  return row;
}
// BUSCAS never shows a batch that is not active.
async function assertNothingLive(label) {
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(view.upload, null, label);
  assert.equal(view.uploads.length, 0, label);
  assert.ok(!(view.demands || []).some((demand) => demand.matchCount), label);
}

let messagesBefore;
test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['MANHEIM_MATCH_AUDIT_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  messagesBefore = (await backend.db.query(`select count(*)::int n from public.messages`)).rows[0].n;
});
test.after(async () => { if (backend) await backend.db.close(); });

const A = { name: 'A.csv', chunks: [cars('VINA', 3), cars('VINB', 2)] };
const B = { name: 'B.csv', chunks: [[car('VINC00000000000001', { make: 'Toyota', model: 'Camry', mmrCents: 2000000 }), car('VINC00000000000002', { mmrCents: null })]] };
let main;

test('1 e 2: mesmo bloco e mesmo conteúdo grava uma vez; conteúdo diferente é recusado sem gravar nada', async () => {
  const started = await batch(startBody([A, B], '1'.repeat(32)));
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  main = started.payload.uploadId;
  const first = await batch({ action: 'chunk', uploadId: main, fileIndex: 0, chunkIndex: 0, vehicles: A.chunks[0] });
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.duplicate, false);
  assert.equal(first.payload.storedVehicles, 3);
  const after = await counts(main);
  // Same content again, even with the keys in another order: duplicate, nothing written.
  const reordered = A.chunks[0].map((item) => ({ vehicle: Object.fromEntries(Object.entries(item.vehicle).reverse()), fingerprint: item.fingerprint }));
  const again = await batch({ action: 'chunk', uploadId: main, fileIndex: 0, chunkIndex: 0, vehicles: reordered });
  assert.equal(again.statusCode, 200);
  assert.deepEqual([again.payload.duplicate, again.payload.storedVehicles, again.payload.storedMatches], [true, 0, 0]);
  assert.deepEqual(await counts(main), after, 'nada mudou');
  // Different content in the same block: refused, no car, no match, no counter changed.
  const other = [car('VINX00000000000001'), car('VINX00000000000002'), car('VINX00000000000003')];
  const conflict = await batch({ action: 'chunk', uploadId: main, fileIndex: 0, chunkIndex: 0, vehicles: other });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.payload.error, 'MANHEIM_CHUNK_CONFLICT');
  assert.deepEqual(await counts(main), after, 'a tentativa conflitante não gravou nada');
  const { rows } = await backend.db.query(`select count(*)::int n from public.manheim_vehicles where row_fingerprint like 'vin:VINX%'`);
  assert.equal(rows[0].n, 0);
  await assertNothingLive('montagem nunca aparece');
});

test('3: duas chamadas simultâneas do mesmo bloco produzem uma única gravação', async () => {
  const [left, right] = await Promise.all([
    batch({ action: 'chunk', uploadId: main, fileIndex: 0, chunkIndex: 1, vehicles: A.chunks[1] }),
    batch({ action: 'chunk', uploadId: main, fileIndex: 0, chunkIndex: 1, vehicles: A.chunks[1] })
  ]);
  assert.deepEqual([left.statusCode, right.statusCode], [200, 200]);
  assert.deepEqual([left.payload.duplicate, right.payload.duplicate].sort(), [false, true]);
  const { rows } = await backend.db.query(`select count(*)::int n, sum(stored_vehicle_count)::int stored from public.manheim_upload_chunks where upload_id=$1 and file_index=0 and chunk_index=1`, [main]);
  assert.deepEqual(rows[0], { n: 1, stored: 2 });
  assert.equal((await counts(main)).vehicles, 5);
});

test('4, 5 e 6: bloco vazio, parcial ou com conteúdo trocado é recusado e a ativação também', async () => {
  const before = await counts(main);
  const empty = await batch({ action: 'chunk', uploadId: main, fileIndex: 1, chunkIndex: 0, vehicles: [] });
  assert.equal(empty.payload.error, 'MANHEIM_CHUNK_HASH_MISMATCH', 'bloco vazio quando o manifesto espera carros');
  const partial = await batch({ action: 'chunk', uploadId: main, fileIndex: 1, chunkIndex: 0, vehicles: B.chunks[0].slice(0, 1) });
  assert.equal(partial.payload.error, 'MANHEIM_CHUNK_HASH_MISMATCH', 'bloco parcial');
  const tampered = JSON.parse(JSON.stringify(B.chunks[0])); tampered[0].vehicle.mmrCents = 1990000;
  const wrong = await batch({ action: 'chunk', uploadId: main, fileIndex: 1, chunkIndex: 0, vehicles: tampered });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.payload.error, 'MANHEIM_CHUNK_HASH_MISMATCH', 'hash incorreto');
  const outside = await batch({ action: 'chunk', uploadId: main, fileIndex: 1, chunkIndex: 1, vehicles: B.chunks[0] });
  assert.equal(outside.payload.error, 'MANHEIM_UPLOAD_INVALID', 'bloco fora do manifesto');
  assert.deepEqual(await counts(main), before, 'nenhuma recusa gravou nada');
  const finalize = await batch({ action: 'finalize', uploadId: main });
  assert.equal(finalize.statusCode, 409);
  assert.equal(finalize.payload.error, 'MANHEIM_BATCH_INCOMPLETE');
  assert.equal((await counts(main)).activated_at, null);
  await assertNothingLive('lote parcial não aparece');
});

test('7 e 8: quantidade do arquivo ou total do lote diferentes da soma são recusados no início', async () => {
  const fileOff = await batch(startBody([A], '2'.repeat(32), (manifest) => { manifest[0].vehicleCount += 1; }));
  assert.equal(fileOff.statusCode, 400);
  assert.equal(fileOff.payload.error, 'MANHEIM_UPLOAD_INVALID');
  const totalOff = startBody([A, B], '3'.repeat(32)); totalOff.vehicleCount += 1;
  const res = await batch(totalOff);
  assert.equal(res.statusCode, 400);
  // The manifest hash must be the one of the manifest sent.
  const forged = startBody([A], '4'.repeat(32)); forged.manifestHash = 'f'.repeat(64);
  assert.equal((await batch(forged)).payload.error, 'MANHEIM_UPLOAD_INVALID');
  const { rows } = await backend.db.query(`select count(*)::int n from public.manheim_uploads where client_key in ('${'2'.repeat(32)}','${'3'.repeat(32)}','${'4'.repeat(32)}')`);
  assert.equal(rows[0].n, 0, 'nenhum lote criado');
});

test('9 e 10: retomada com manifesto ou demandas diferentes é recusada, com o lote para descartar', async () => {
  // Same key (same files) but another manifest (content read differently).
  const changed = { ...B, chunks: [[B.chunks[0][0]], [B.chunks[0][1]]] };
  const manifest = await batch(startBody([A, changed], '1'.repeat(32)));
  assert.equal(manifest.statusCode, 409);
  assert.deepEqual([manifest.payload.error, manifest.payload.reason, manifest.payload.uploadId], ['MANHEIM_BATCH_RESUME_MISMATCH', 'MANIFEST', main]);
  // Same manifest, but a customer's search changed since the batch started.
  await backend.db.query(`update public.journeys set criteria_json=$2 where id=$1`, [J.carro, JSON.stringify({ wishlists: [{ ...WISH, yearMin: 2020 }], logical_modes: ['CARRO'] })]);
  const targets = await batch(startBody([A, B], '1'.repeat(32)));
  assert.equal(targets.statusCode, 409);
  assert.deepEqual([targets.payload.error, targets.payload.reason, targets.payload.uploadId], ['MANHEIM_BATCH_RESUME_MISMATCH', 'TARGETS', main]);
  assert.equal((await counts(main)).activated_at, null);
  // The operator discards it; the same files start a new batch.
  const discarded = await batch({ action: 'cancel', uploadId: main });
  assert.equal(discarded.payload.canceled, true);
  const fresh = await batch(startBody([A, B], '1'.repeat(32)));
  assert.equal(fresh.statusCode, 201);
  assert.notEqual(fresh.payload.uploadId, main);
  await batch({ action: 'cancel', uploadId: fresh.payload.uploadId });
  await assertNothingLive('descartados nunca aparecem');
});

test('11: falha e retomada legítima continuam; a ativação confere tudo e vale uma vez', async () => {
  const files = [{ name: 'R1.csv', chunks: [cars('VINR', 4), cars('VINS', 3)] }, { name: 'R2.csv', chunks: [cars('VINT', 2)] }];
  const started = await batch(startBody(files, '5'.repeat(32)));
  const uploadId = started.payload.uploadId;
  await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 0, vehicles: files[0].chunks[0] });
  // The network fails; the operator chooses the same files again.
  const resumed = await batch(startBody(files, '5'.repeat(32)));
  assert.equal(resumed.statusCode, 200);
  assert.equal(resumed.payload.resumed, true);
  assert.deepEqual(resumed.payload.received, [[0, 0]]);
  await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 1, vehicles: files[0].chunks[1] });
  await batch({ action: 'chunk', uploadId, fileIndex: 1, chunkIndex: 0, vehicles: files[1].chunks[0] });
  const done = await batch({ action: 'finalize', uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
  assert.deepEqual([done.payload.vehicleCount, done.payload.fileCount, done.payload.alreadyActive], [9, 2, false]);
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(view.upload.id, uploadId);
  assert.equal((await batch({ action: 'finalize', uploadId })).payload.alreadyActive, true);
  // A block of an active batch: same content answers duplicate, other content is still refused.
  assert.equal((await batch({ action: 'chunk', uploadId, fileIndex: 1, chunkIndex: 0, vehicles: files[1].chunks[0] })).payload.duplicate, true);
  assert.equal((await batch({ action: 'chunk', uploadId, fileIndex: 1, chunkIndex: 0, vehicles: cars('VINU', 2) })).payload.error, 'MANHEIM_CHUNK_CONFLICT');
});

test('carro recusado pela validação conta como ignorado, nunca como gravado; repetido que escapou recusa a ativação', async () => {
  // One car without model: the server ignores it and says so; the batch still closes exactly.
  const withInvalid = [{ name: 'I.csv', chunks: [[car('VINI00000000000001'), car('VINI00000000000002', { model: '' })]] }];
  let started = await batch(startBody(withInvalid, '6'.repeat(32)));
  let uploadId = started.payload.uploadId;
  const chunk = await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 0, vehicles: withInvalid[0].chunks[0] });
  assert.deepEqual([chunk.payload.storedVehicles, chunk.payload.ignored], [1, 1]);
  const done = await batch({ action: 'finalize', uploadId });
  assert.deepEqual([done.statusCode, done.payload.vehicleCount, done.payload.ignored], [200, 1, 1]);
  // The same car in two files (the browser should have removed it): the batch is not the declared
  // deduplicated batch and is never activated with fewer cars than declared.
  const repeated = [{ name: 'D1.csv', chunks: [[car('VIND00000000000001')]] }, { name: 'D2.csv', chunks: [[car('VIND00000000000001', { lot: 'OUTRO' })]] }];
  started = await batch(startBody(repeated, '7'.repeat(32)));
  uploadId = started.payload.uploadId;
  await batch({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 0, vehicles: repeated[0].chunks[0] });
  await batch({ action: 'chunk', uploadId, fileIndex: 1, chunkIndex: 0, vehicles: repeated[1].chunks[0] });
  const refused = await batch({ action: 'finalize', uploadId });
  assert.equal(refused.statusCode, 409);
  assert.equal(refused.payload.error, 'MANHEIM_BATCH_INTEGRITY_ERROR');
  assert.equal((await counts(uploadId)).activated_at, null);
  await batch({ action: 'cancel', uploadId });
});

test('14, 15 e 16: nenhum match sem MMR, nenhuma chamada externa, nenhuma mensagem', async () => {
  const { rows } = await backend.db.query(`select count(*)::int n from public.manheim_matches where coalesce(mmr_cents,0) <= 0`);
  assert.equal(rows[0].n, 0);
  assert.deepEqual(backend.refused, [], 'nenhuma chamada fora do banco simulado (OpenAI incluída)');
  const { rows: [{ n }] } = await backend.db.query(`select count(*)::int n from public.messages`);
  assert.equal(n, messagesBefore, 'nenhuma mensagem criada');
});

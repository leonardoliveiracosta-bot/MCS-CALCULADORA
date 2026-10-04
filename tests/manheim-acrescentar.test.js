'use strict';

// Acrescentar arquivos ao lote ativo do Manheim, com os handlers reais contra um banco PGlite com todas as
// migrações: os carros novos entram no MESMO lote (mesmo id), o repetido é pulado, a seleção feita antes
// continua, nada aparece pela metade, e se o lote ativo mudar no meio nada é juntado. Nenhuma rede externa.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const id = (n) => `6c900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), JOURNEY = id(10), CONTACT = id(11);
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','ac-1','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'ac1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const batch = (body) => call('manheim-batch', '/api/panel/manheim-batch', 'POST', body);
const car = (vin, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 30000, mmrCents: 2500000, location: 'FL - Orlando', lot: 'L' + vin.slice(-3), lane: '1', run: vin.slice(-2), cleanTitle: true, odometerOk: true, ...extra } });
function startBody(files, clientKey, append) {
  const manifest = files.map((file) => {
    const vehicleCount = file.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    return { name: file.name, size: file.size, rowCount: vehicleCount, vehicleCount, chunkCount: file.chunks.length, chunks: file.chunks.map((chunk) => ({ count: chunk.length, hash: contentHash(chunk) })) };
  });
  return { action: 'start', clientKey, vehicleCount: manifest.reduce((sum, file) => sum + file.vehicleCount, 0), files: manifest, manifestHash: contentHash(manifest),
    headers: [['Vin', 'Year', 'Make', 'Model', 'Odometer', 'MMR']], headerMap: { files: [{ vin: 'Vin' }] }, ...(append ? { append: true } : {}) };
}
async function importLot(files, key, append = false) {
  const started = await batch(startBody(files, key, append));
  assert.ok([200, 201].includes(started.statusCode), JSON.stringify(started.payload));
  const uploadId = started.payload.uploadId;
  for (let f = 0; f < files.length; f += 1) for (let c = 0; c < files[f].chunks.length; c += 1) {
    const res = await batch({ action: 'chunk', uploadId, fileIndex: f, chunkIndex: c, vehicles: files[f].chunks[c] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  }
  return { uploadId, started: started.payload };
}
const q = async (sql, params) => (await backend.db.query(sql, params)).rows;
const activeId = async () => (await q(`select public.panel_manheim_active_upload_id('preview') id`))[0].id;

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.MANHEIM_MATCH_AUDIT_ENABLED; delete process.env.OPENAI_API_KEY; delete process.env.MANHEIM_OPENAI_ENABLED;
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

let lotA, selectedMatch;
test('acrescentar: carros novos entram no mesmo lote, repetido é pulado, seleção continua', async () => {
  const first = await importLot([{ name: 'MCS_01.csv', size: 100, chunks: [[car('ACVIN0000000001'), car('ACVIN0000000002'), car('ACVIN0000000003')]] }], 'a1'.repeat(16));
  const done = await batch({ action: 'finalize', uploadId: first.uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
  lotA = first.uploadId;
  assert.equal(await activeId(), lotA);
  // A selection made on the active batch before the append.
  [{ id: selectedMatch }] = await q(`select id from public.manheim_matches where upload_id=$1 and row_fingerprint='vin:ACVIN0000000001' limit 1`, [lotA]);
  const picked = await q(`select public.panel_manheim_offer_select_v2('preview',$1,$2,'SELECT',null,null,null,null) r`, [ACTOR, selectedMatch]);
  assert.equal(picked[0].r.status, 'SELECTED');

  // Append: one car already in the batch (002) and two new ones.
  const extra = await importLot([{ name: 'MCS_NOVO.csv', size: 50, chunks: [[car('ACVIN0000000002'), car('ACVIN0000000004'), car('ACVIN0000000005', { year: 2021 })]] }], 'b2'.repeat(16), true);
  assert.equal(extra.started.appendTo, lotA);
  // While being assembled, nothing of it shows: the active batch still has 3 cars.
  assert.equal((await q(`select count(*)::int n from public.manheim_vehicles where upload_id=$1`, [lotA]))[0].n, 3);
  const merged = await batch({ action: 'finalize', uploadId: extra.uploadId });
  assert.equal(merged.statusCode, 200, JSON.stringify(merged.payload));
  assert.equal(merged.payload.appended, true);
  assert.equal(merged.payload.uploadId, lotA, 'o lote ativo é o mesmo');
  assert.equal(merged.payload.added, 2);
  assert.equal(merged.payload.alreadyInBatch, 1);
  assert.equal(merged.payload.vehicleCount, 5);
  assert.equal(await activeId(), lotA);
  const [lot] = await q(`select vehicle_count, source_file_count, jsonb_array_length(appended_files_json) files from public.manheim_uploads where id=$1`, [lotA]);
  assert.deepEqual(lot, { vehicle_count: 5, source_file_count: 2, files: 1 });
  // The new cars and their combinations are in the active batch; the repeated one was not duplicated.
  assert.equal((await q(`select count(*)::int n from public.manheim_vehicles where upload_id=$1 and row_fingerprint='vin:ACVIN0000000002'`, [lotA]))[0].n, 1);
  assert.ok((await q(`select count(*)::int n from public.manheim_matches where upload_id=$1 and row_fingerprint='vin:ACVIN0000000004'`, [lotA]))[0].n >= 1);
  // The selection made before is still there, on the same car.
  const [sel] = await q(`select status, upload_id from public.manheim_option_selections where match_id=$1`, [selectedMatch]);
  assert.equal(sel.status, 'SELECTED'); assert.equal(sel.upload_id, lotA);
  // The assembly is recorded as merged and never shows as a batch.
  const [staging] = await q(`select activated_at, merged_at, undo_summary from public.manheim_uploads where id=$1`, [extra.uploadId]);
  assert.equal(staging.activated_at, null); assert.ok(staging.merged_at); assert.equal(staging.undo_summary.mergedInto, lotA);
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  assert.equal(view.upload.id, lotA);
  assert.ok(!view.uploads.some((upload) => upload.id === extra.uploadId));
  // Finalizing again answers the same, without moving anything.
  const again = await batch({ action: 'finalize', uploadId: extra.uploadId });
  assert.equal(again.payload.alreadyMerged, true); assert.equal(again.payload.vehicleCount, 5);
});

test('acréscimo pela metade não junta nada', async () => {
  const half = await batch(startBody([{ name: 'MCS_METADE.csv', size: 50, chunks: [[car('ACVIN0000000006')], [car('ACVIN0000000007')]] }], 'c3'.repeat(16), true));
  await batch({ action: 'chunk', uploadId: half.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: [car('ACVIN0000000006')] });
  const early = await batch({ action: 'finalize', uploadId: half.payload.uploadId });
  assert.equal(early.statusCode, 409); assert.equal(early.payload.error, 'MANHEIM_BATCH_INCOMPLETE');
  assert.equal((await q(`select count(*)::int n from public.manheim_vehicles where upload_id=$1`, [lotA]))[0].n, 5);
});

test('lote ativo trocado no meio do acréscimo: nada é juntado', async () => {
  const pending = await importLot([{ name: 'MCS_TARDE.csv', size: 50, chunks: [[car('ACVIN0000000008')]] }], 'd4'.repeat(16), true);
  // Another full batch is activated meanwhile.
  const other = await importLot([{ name: 'MCS_TUDO.csv', size: 100, chunks: [[car('ACVIN0000000009')]] }], 'e5'.repeat(16));
  assert.equal((await batch({ action: 'finalize', uploadId: other.uploadId })).statusCode, 200);
  const refused = await batch({ action: 'finalize', uploadId: pending.uploadId });
  assert.equal(refused.statusCode, 409); assert.equal(refused.payload.error, 'MANHEIM_APPEND_TARGET_CHANGED');
  assert.equal(await activeId(), other.uploadId);
  assert.equal((await q(`select count(*)::int n from public.manheim_vehicles where upload_id=$1`, [other.uploadId]))[0].n, 1);
  assert.equal((await q(`select count(*)::int n from public.manheim_vehicles where row_fingerprint='vin:ACVIN0000000008' and upload_id<>$1`, [pending.uploadId]))[0].n, 0);
});

test('sem lote ativo não há o que acrescentar', async () => {
  await q(`update public.manheim_uploads set undone_at=now() where activated_at is not null`);
  const res = await batch(startBody([{ name: 'X.csv', size: 1, chunks: [[car('ACVIN0000000010')]] }], 'f6'.repeat(16), true));
  assert.equal(res.statusCode, 409); assert.equal(res.payload.error, 'MANHEIM_APPEND_NO_ACTIVE');
});

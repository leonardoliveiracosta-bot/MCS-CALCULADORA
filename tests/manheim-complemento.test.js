'use strict';

// Complemento do lote Manheim ativo, com o handler real contra um banco PGlite com todas as
// migrações. O lote é montado como o lote real antigo (sem Lane, Run, Inventory, Status e Event Sale
// Name). Os mesmos arquivos acrescentam só esses dados: nenhum lote, match ou carro novo, nada de
// MMR, critério, seleção ou histórico muda, e arquivo que não corresponde é recusado sem gravar.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const id = (n) => `6c600000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOURNEY = id(10), CONTACT = id(11);
const KEY = `journey:${JOURNEY}:CARRO`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Complemento','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','cmp-1','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'c1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const batchCall = (body) => call('manheim-batch', '/api/panel/manheim-batch', 'POST', body);

// 6 CR-V that match (two of them also in another file position) and 2 cars that match nobody.
const SALE = [
  { lane: '3', run: '41', saleType: 'Simulcast', saleStatus: 'Active', eventSaleName: 'Orlando Tuesday', buyNowPrice: '26500' },
  { lane: '4', run: '12', saleType: 'Simulcast', saleStatus: 'Active', eventSaleName: 'Orlando Tuesday', buyNowPrice: '' },
  { lane: '', run: '', saleType: 'OVE', saleStatus: 'Active', eventSaleName: 'Buy Now / Make Offer', buyNowPrice: '27000' },
  { lane: '', run: '', saleType: 'OVE', saleStatus: 'Active', eventSaleName: '', buyNowPrice: '28000' },
  { lane: '', run: '', saleType: 'OVE', saleStatus: 'Active', eventSaleName: '', buyNowPrice: '' },
  { lane: '7', run: '3', saleType: 'Simulcast', saleStatus: 'Active', eventSaleName: 'Orlando Tuesday', buyNowPrice: '' },
  { lane: '1', run: '1', saleType: 'Simulcast', saleStatus: '', eventSaleName: '', buyNowPrice: '' },
  { lane: '', run: '', saleType: 'OVE', saleStatus: '', eventSaleName: '', buyNowPrice: '9000' }
];
const car = (n) => {
  const vin = 'CMPV' + String(n).padStart(13, '0');
  const other = n >= 6;
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: other ? 'Ford' : 'Honda', model: other ? 'F-150' : 'CR-V', trim: 'EX', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', startsAt: '2026-10-01T15:00:00Z', conditionGrade: '4.2', buyNowPrice: SALE[n].buyNowPrice, cleanTitle: true, odometerOk: true } };
};
const cars = Array.from({ length: 8 }, (_, n) => car(n));
const FILES = [{ name: 'CMP.csv', size: 4096, rowCount: 9, vehicleCount: cars.length }];
const items = () => cars.map((entry, n) => ({ fingerprint: entry.fingerprint, lane: SALE[n].lane, run: SALE[n].run, saleType: SALE[n].saleType, saleStatus: SALE[n].saleStatus, eventSaleName: SALE[n].eventSaleName }));
let uploadId;

// Everything the complement must never touch: counts, ids, MMR, criteria, selection, history.
async function frozen() {
  const q = async (sql) => (await backend.db.query(sql)).rows;
  return {
    uploads: await q(`select id, activated_at, canceled_at, undone_at, vehicle_count, files_json, manifest_hash from public.manheim_uploads order by id`),
    vehicles: await q(`select id, upload_id, row_fingerprint, mmr_cents, make_key, undone_at, vehicle_json - array['lane','run','saleType','saleStatus','eventSaleName'] rest from public.manheim_vehicles order by id`),
    matches: await q(`select id, upload_id, journey_id, match_kind, row_fingerprint, mmr_cents, criteria_hash, demand_key, sort_rank, sort_miles, undone_at,
                      vehicle_json - 'parsed' outer_json, (vehicle_json -> 'parsed') - array['lane','run','saleType','saleStatus','eventSaleName'] rest from public.manheim_matches order by id`),
    selections: await q(`select * from public.manheim_option_selections order by id`),
    chunks: await q(`select * from public.manheim_upload_chunks order by file_index, chunk_index`),
    vitrines: await q(`select count(*)::int n from public.vitrine_cars`),
    messages: await q(`select count(*)::int n from public.messages`)
  };
}
const saleOf = async () => (await backend.db.query(`select row_fingerprint, vehicle_json ->> 'lane' lane, vehicle_json ->> 'run' run from public.manheim_vehicles order by row_fingerprint`)).rows;

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['MANHEIM_MATCH_AUDIT_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ ...FILES[0], chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await batchCall({ action: 'start', clientKey: 'c'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  uploadId = started.payload.uploadId;
  await batchCall({ action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  const done = await batchCall({ action: 'finalize', uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
  // As the real batch imported before this change: no sale fields stored at all.
  await backend.db.exec(`update public.manheim_vehicles set vehicle_json = vehicle_json - array['lane','run','saleType','saleStatus','eventSaleName'];
    update public.manheim_matches set vehicle_json = jsonb_set(vehicle_json, '{parsed}', (vehicle_json -> 'parsed') - array['lane','run','saleType','saleStatus','eventSaleName']);`);
});
test.after(async () => { if (backend) await backend.db.close(); });

test('lote antigo: sem dados de venda tudo fica incompleto (Buy Now sozinho não vira fora de Lane/Run)', async () => {
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  const demand = view.demands.find((item) => item.key === KEY);
  assert.deepEqual([demand.offer.lane, demand.offer.offLane, demand.offer.incomplete], [0, 0, 6]);
  const latest = (await call('manheim-batch', '/api/panel/manheim-batch')).payload.latest;
  assert.deepEqual(latest.files, [{ name: 'CMP.csv', size: 4096, rowCount: 9, vehicleCount: 8 }]);
});

test('arquivo que não corresponde ao lote ativo é recusado sem gravar', async () => {
  const before = await frozen();
  const sale = await saleOf();
  const base = { action: 'complement', uploadId, files: FILES, vehicleCount: cars.length, items: items() };
  const refusals = [
    [{ ...base, files: [{ ...FILES[0], rowCount: 10 }], apply: true, confirmed: true }, 409, 'MANHEIM_COMPLEMENT_MISMATCH'],
    [{ ...base, files: [{ ...FILES[0], name: 'OUTRO.csv' }], apply: false }, 409, 'MANHEIM_COMPLEMENT_MISMATCH'],
    [{ ...base, vehicleCount: 9, apply: true, confirmed: true }, 409, 'MANHEIM_COMPLEMENT_MISMATCH'],
    // A car the batch does not have: the whole block is refused.
    [{ ...base, items: [...items().slice(0, 7), { fingerprint: 'vin:NAOEXISTE00000001', lane: '9', run: '9' }], apply: true, confirmed: true }, 409, 'MANHEIM_COMPLEMENT_MISMATCH'],
    [{ ...base, uploadId: id(99), apply: true, confirmed: true }, 409, 'MANHEIM_COMPLEMENT_NOT_ACTIVE'],
    // Writing needs the operator's explicit confirmation.
    [{ ...base, apply: true }, 400, 'MANHEIM_COMPLEMENT_CONFIRM_REQUIRED'],
    [{ ...base, items: [...items(), items()[0]], apply: false }, 400, 'MANHEIM_UPLOAD_INVALID']
  ];
  for (const [body, status, code] of refusals) {
    const res = await batchCall(body);
    assert.deepEqual([res.statusCode, res.payload.error], [status, code], JSON.stringify(res.payload));
  }
  // The count shows the missing car before anything is written.
  const preview = await batchCall({ ...base, items: [...items().slice(0, 7), { fingerprint: 'vin:NAOEXISTE00000001', lane: '9', run: '9' }], apply: false });
  assert.deepEqual([preview.statusCode, preview.payload.found, preview.payload.missing], [200, 7, 1]);
  assert.deepEqual(await frozen(), before);
  assert.deepEqual(await saleOf(), sale, 'nenhum dado de venda gravado');
});

test('complemento conta, pede confirmação e só acrescenta os dados de venda', async () => {
  const before = await frozen();
  const base = { action: 'complement', uploadId, files: FILES, vehicleCount: cars.length, items: items() };
  const preview = await batchCall({ ...base, apply: false });
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.payload));
  // 8 cars found: Lane/Run 4 (one with Buy Now Price), Buy Now / Make Offer 3, incomplete 1.
  assert.deepEqual([preview.payload.found, preview.payload.missing, preview.payload.changed, preview.payload.lane, preview.payload.offLane, preview.payload.incomplete, preview.payload.vehiclesUpdated],
    [8, 0, 8, 4, 3, 1, 0]);
  assert.deepEqual(await frozen(), before, 'a prévia não grava nada');

  const applied = await batchCall({ ...base, apply: true, confirmed: true });
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.payload));
  assert.deepEqual([applied.payload.vehiclesUpdated, applied.payload.matchesUpdated, applied.payload.lane, applied.payload.offLane, applied.payload.incomplete], [8, 6, 4, 3, 1]);
  // Nothing else changed: same batch, same cars, same matches (no new, none removed), same MMR,
  // criteria and selection; no V1/V2 and no message.
  assert.deepEqual(await frozen(), before);
  const { rows: [counts] } = await backend.db.query(`select (select count(*) from public.manheim_uploads)::int uploads, (select count(*) from public.manheim_vehicles)::int vehicles,
    (select count(*) from public.manheim_matches)::int matches, (select count(distinct row_fingerprint) from public.manheim_vehicles)::int distinct_vehicles`);
  assert.deepEqual(counts, { uploads: 1, vehicles: 8, matches: 6, distinct_vehicles: 8 });
  const { rows: [first] } = await backend.db.query(`select vehicle_json from public.manheim_vehicles where row_fingerprint = 'vin:CMPV0000000000000'`);
  assert.deepEqual([first.vehicle_json.lane, first.vehicle_json.run, first.vehicle_json.saleType, first.vehicle_json.eventSaleName, first.vehicle_json.mmrCents, first.vehicle_json.buyNowPrice], ['3', '41', 'Simulcast', 'Orlando Tuesday', 2500000, '26500']);
  // BUSCAS now groups by the complemented data: the car in Lane/Run with Buy Now stays in Lane/Run.
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  const demand = view.demands.find((item) => item.key === KEY);
  assert.deepEqual([demand.offer.lane, demand.offer.offLane, demand.offer.incomplete], [3, 2, 1]);
  // Audit trail, and the same files again change nothing.
  const { rows: audit } = await backend.db.query(`select after_json from public.audit_log where action = 'MANHEIM_COMPLEMENT'`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].after_json.vehiclesUpdated, 8);
  const again = await batchCall({ ...base, apply: true, confirmed: true });
  assert.deepEqual([again.payload.changed, again.payload.vehiclesUpdated, again.payload.matchesUpdated], [0, 0, 0]);
  assert.deepEqual(backend.refused, []);
});

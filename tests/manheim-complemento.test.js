'use strict';

// Complemento do lote Manheim ativo, com os handlers reais contra um banco PGlite com todas as
// migrações. O lote é importado como o lote real (blocos sem Lane, Run, Inventory, Status e Event Sale
// Name). Os mesmos CSVs, lidos de novo, acrescentam só esses dados; a prévia não grava; arquivo com o
// mesmo nome, tamanho e número de linhas mas conteúdo diferente é recusado sem gravar; repetir não
// muda nada; faltou bloco, nada é gravado.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const csv = require('./fixtures/manheim-csv');

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

const HEADERS = 'Inventory,Vin,Year,Make,Model,Trim,Odometer Value,MMR,Condition Report Grade,Pickup Location,Starts At,Lane,Run,Buy Now Price,Event Sale Name,Status';
const row = (inventory, vin, make, model, miles, cr, lane, run, buyNow, event) => [inventory, vin, '2020', make, model, 'EX', miles, '25000', cr, 'FL - Orlando', '2026-10-01T15:00:00Z', lane, run, buyNow, event, 'Active'].join(',');
// Two files. CR-V: in Lane/Run with Buy Now (stays Lane/Run), in Lane/Run, OVE with Buy Now / Make
// Offer, OVE with Buy Now, OVE without anything (incomplete). A car repeated in both files. A Ford.
const FILE_A = [HEADERS,
  row('Simulcast', '2HKRW2H59LH700001', 'Honda', 'CR-V', '21000', '4.1', '3', '41', '26500', 'Orlando Tuesday'),
  row('Simulcast', '2HKRW2H59LH700002', 'Honda', 'CR-V', '22000', '4.0', '4', '12', '', 'Orlando Tuesday'),
  row('OVE', '2HKRW2H59LH700003', 'Honda', 'CR-V', '23000', '3.9', '', '', '27000', 'Buy Now / Make Offer')].join('\n') + '\n';
const FILE_B = [HEADERS,
  row('OVE', '2HKRW2H59LH700004', 'Honda', 'CR-V', '24000', '3.8', '', '', '28000', ''),
  row('OVE', '2HKRW2H59LH700005', 'Honda', 'CR-V', '25000', '3.7', '', '', '', ''),
  row('OVE', '2HKRW2H59LH700001', 'Honda', 'CR-V', '21000', '4.1', '', '', '', ''),
  row('Simulcast', '1FTEW1EP5LK700006', 'Ford', 'F-150', '30000', '4.0', '1', '1', '', 'Orlando Tuesday')].join('\n') + '\n';
const FILES = [{ name: 'A.csv', text: FILE_A }, { name: 'B.csv', text: FILE_B }];

let backend, batch;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const post = (body) => call('manheim-batch', '/api/panel/manheim-batch', 'POST', body);
const q = async (sql) => (await backend.db.query(sql)).rows;

// Everything the complement must never touch.
async function frozen() {
  return {
    uploads: await q(`select * from public.manheim_uploads order by id`),
    vehicles: await q(`select * from public.manheim_vehicles order by id`),
    matches: await q(`select * from public.manheim_matches order by id`),
    selections: await q(`select * from public.manheim_option_selections order by id`),
    chunks: await q(`select * from public.manheim_upload_chunks order by file_index, chunk_index`),
    vitrines: await q(`select count(*)::int n from public.vitrine_cars`),
    messages: await q(`select count(*)::int n from public.messages`)
  };
}
// Sale data in use: the items of the complement the batch points to (nothing before the switch).
const saleRows = () => q(`select i.row_fingerprint, i.sale from public.manheim_sale_current c join public.manheim_complement_items i on i.run_id = c.run_id order by i.row_fingerprint`);
const groups = async () => {
  const view = (await call('records', '/api/panel/records?view=manheim')).payload;
  const demand = view.demands.find((item) => item.key === KEY);
  return [demand.offer.lane, demand.offer.offLane, demand.offer.incomplete];
};
async function preview(read) {
  const { keys, blocks } = csv.complementBlocks(read, batch.uploadId);
  const total = { found: 0, missing: 0, changed: 0, lane: 0, offLane: 0, incomplete: 0 };
  for (const block of blocks) {
    const res = await post({ action: 'complement-check', ...keys, ...block });
    if (res.statusCode !== 200) return res;
    Object.keys(total).forEach((key) => { total[key] += res.payload[key]; });
  }
  return { statusCode: 200, payload: total };
}
async function complement(read, skip = null) {
  const { keys, blocks } = csv.complementBlocks(read, batch.uploadId);
  const started = await post({ action: 'complement-start', ...keys, confirmed: true });
  assert.equal(started.statusCode, 200, JSON.stringify(started.payload));
  for (const [index, block] of blocks.entries()) {
    if (index === skip) continue;
    const res = await post({ action: 'complement-stage', ...keys, runId: started.payload.runId, ...block });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  }
  return post({ action: 'complement-apply', runId: started.payload.runId, confirmed: true });
}

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  for (const key of ['MANHEIM_MATCH_AUDIT_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  batch = await csv.importLegacy(post, FILES);
});
test.after(async () => { if (backend) await backend.db.close(); });

test('lote antigo sem dados de venda: tudo incompleto (Buy Now sozinho não tira de Lane/Run)', async () => {
  assert.equal(batch.vehicleCount, 6);
  assert.equal((await q(`select count(*)::int n from public.manheim_vehicles where vehicle_json ? 'lane'`))[0].n, 0);
  assert.deepEqual(await groups(), [0, 0, 5]);
});

test('arquivo com mesmo nome, tamanho e linhas mas conteúdo diferente é recusado sem gravar', async () => {
  const before = await frozen();
  // Same size and rows: one digit of the mileage (car data) or of the Lane (sale data) changed.
  for (const [from, to] of [['24000', '24001'], [',3,41,', ',5,41,']]) {
    const changed = FILE_A.includes(from) ? [{ name: 'A.csv', text: FILE_A.replace(from, to) }, FILES[1]] : [FILES[0], { name: 'B.csv', text: FILE_B.replace(from, to) }];
    assert.equal(Buffer.byteLength(changed[0].text + changed[1].text), Buffer.byteLength(FILE_A + FILE_B));
    const read = await csv.readFiles(changed);
    const res = await preview(read);
    assert.deepEqual([res.statusCode, res.payload.error], [409, 'MANHEIM_COMPLEMENT_MISMATCH'], from);
    const { keys, blocks } = csv.complementBlocks(read, batch.uploadId);
    const started = await post({ action: 'complement-start', ...keys, confirmed: true });
    assert.deepEqual([started.statusCode, started.payload.error], [409, 'MANHEIM_COMPLEMENT_MISMATCH']);
    // Even inside a complement started with the right keys, a block whose car data differs is refused
    // and the complement is canceled.
    if (from === '24000') {
      const good = csv.complementBlocks(await csv.readFiles(FILES), batch.uploadId);
      const run = (await post({ action: 'complement-start', ...good.keys, confirmed: true })).payload.runId;
      const bad = await post({ action: 'complement-stage', ...good.keys, runId: run, ...blocks.find((block) => block.fileIndex === 1) });
      assert.deepEqual([bad.statusCode, bad.payload.error], [409, 'MANHEIM_COMPLEMENT_MISMATCH']);
      const after = await post({ action: 'complement-apply', runId: run, confirmed: true });
      assert.equal(after.payload.error, 'MANHEIM_COMPLEMENT_CANCELED');
    }
  }
  // Other refusals: batch not active, no confirmation, a block missing before the write.
  const read = await csv.readFiles(FILES);
  const { keys } = csv.complementBlocks(read, batch.uploadId);
  assert.equal((await post({ action: 'complement-check', ...keys, uploadId: id(99), ...csv.complementBlocks(read, batch.uploadId).blocks[0] })).payload.error, 'MANHEIM_COMPLEMENT_NOT_ACTIVE');
  assert.equal((await post({ action: 'complement-start', ...keys })).payload.error, 'MANHEIM_COMPLEMENT_CONFIRM_REQUIRED');
  const partial = await complement(read, 1);
  assert.deepEqual([partial.statusCode, partial.payload.error], [409, 'MANHEIM_COMPLEMENT_INCOMPLETE']);
  assert.deepEqual(await frozen(), before);
  assert.deepEqual(await saleRows(), [], 'nenhum dado de venda gravado');
});

test('prévia só lê; o complemento grava só os cinco dados, de uma vez; repetir não muda nada', async () => {
  const before = await frozen();
  const read = await csv.readFiles(FILES);
  const shown = await preview(read);
  assert.equal(shown.statusCode, 200, JSON.stringify(shown.payload));
  // 6 cars: Lane/Run 3 (one with Buy Now Price), Buy Now / Make Offer 2, incomplete 1.
  assert.deepEqual(shown.payload, { found: 6, missing: 0, changed: 6, lane: 3, offLane: 2, incomplete: 1 });
  assert.deepEqual(await saleRows(), [], 'a prévia não grava');

  const applied = await complement(read);
  assert.equal(applied.statusCode, 200, JSON.stringify(applied.payload));
  assert.deepEqual([applied.payload.applied, applied.payload.cars, applied.payload.changed], [true, 6, 6]);
  const totals = await post({ action: 'complement-result', uploadId: batch.uploadId });
  assert.deepEqual(totals.payload, { cars: 6, withSale: 6, lane: 3, offLane: 2, incomplete: 1, matches: 5 });
  // Batch, cars, matches (none created, removed or recalculated), MMR, criteria, selection: identical.
  assert.deepEqual(await frozen(), before);
  const sale = await saleRows();
  assert.equal(sale.length, 6);
  assert.ok(sale.every((item) => Object.keys(item.sale).sort().join() === 'eventSaleName,lane,run,saleStatus,saleType'));
  assert.deepEqual(sale.find((item) => item.row_fingerprint === 'vin:2HKRW2H59LH700001').sale, { lane: '3', run: '41', saleType: 'Simulcast', saleStatus: 'Active', eventSaleName: 'Orlando Tuesday' });
  // BUSCAS: the car in Lane/Run with Buy Now stays in Lane/Run.
  assert.deepEqual(await groups(), [2, 2, 1]);
  const audit = await q(`select after_json from public.audit_log where action = 'MANHEIM_COMPLEMENT'`);
  assert.equal(audit.length, 1);

  // The same files again: nothing to complement, and a second write changes nothing.
  const again = await preview(await csv.readFiles(FILES));
  assert.equal(again.payload.changed, 0);
  const second = await complement(await csv.readFiles(FILES));
  assert.deepEqual([second.payload.applied, second.payload.changed], [false, 0]);
  assert.deepEqual(await saleRows(), sale);
  assert.deepEqual(await frozen(), before);
  assert.deepEqual(backend.refused, []);
});

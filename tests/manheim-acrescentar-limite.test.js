'use strict';

// Acrescentar ao lote ativo quando o lote já tem 19 arquivos: 19 + 2 = 21 arquivos entram (o limite de 20 é por
// envio, não do lote somado). Antes, o CHECK de manheim_uploads (1..20) fazia a junção falhar com erro 500.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const id = (n) => `6cb00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`;

let backend;
async function batch(body) {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/manheim-batch')({ method: 'POST', url: '/api/panel/manheim-batch', headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res);
  return res;
}
const car = (vin) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 30000, mmrCents: 2500000, location: 'FL - Orlando', cleanTitle: true, odometerOk: true } });
const vin = (n) => 'LMVIN' + String(n).padStart(12, '0');
async function importLot(count, offset, key, append) {
  const files = Array.from({ length: count }, (_, i) => ({ name: `MCS_${offset + i}.csv`, size: 10, chunks: [[car(vin(offset + i))]] }));
  const manifest = files.map((file) => ({ name: file.name, size: file.size, rowCount: 1, vehicleCount: 1, chunkCount: 1, chunks: [{ count: 1, hash: contentHash(file.chunks[0]) }] }));
  const started = await batch({ action: 'start', clientKey: key, vehicleCount: count, files: manifest, manifestHash: contentHash(manifest), headers: [['Vin']], headerMap: {}, ...(append ? { append: true } : {}) });
  assert.ok([200, 201].includes(started.statusCode), JSON.stringify(started.payload));
  for (let f = 0; f < files.length; f += 1) {
    const res = await batch({ action: 'chunk', uploadId: started.payload.uploadId, fileIndex: f, chunkIndex: 0, vehicles: files[f].chunks[0] });
    assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  }
  return started.payload.uploadId;
}

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.MANHEIM_MATCH_AUDIT_ENABLED; delete process.env.OPENAI_API_KEY; delete process.env.MANHEIM_OPENAI_ENABLED;
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

test('lote ativo com 19 arquivos recebe um acréscimo de 2 (21 no total)', async () => {
  const lot = await importLot(19, 1, 'c1'.repeat(16), false);
  assert.equal((await batch({ action: 'finalize', uploadId: lot })).statusCode, 200);
  const extra = await importLot(2, 100, 'c2'.repeat(16), true);
  const merged = await batch({ action: 'finalize', uploadId: extra });
  assert.equal(merged.statusCode, 200, JSON.stringify(merged.payload));
  assert.equal(merged.payload.appended, true);
  assert.equal(merged.payload.uploadId, lot);
  assert.equal(merged.payload.added, 2);
  assert.equal(merged.payload.vehicleCount, 21);
  const [row] = (await backend.db.query(`select source_file_count, vehicle_count from public.manheim_uploads where id=$1`, [lot])).rows;
  assert.deepEqual(row, { source_file_count: 21, vehicle_count: 21 });
});

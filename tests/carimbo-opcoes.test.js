'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const stamp = require('../panel-option-stamp');

const wish = (make, model) => ({ make, model, yearMin: 2020, yearMax: 2026, minMiles: 10000, maxMiles: 90000, trim: '' });
const JOURNEY = '77c63c19-0000-4000-8000-000000000001';
const demand = (over = {}) => ({ key: `journey:${JOURNEY}:CARRO`, mode: 'CARRO', active: true, journeyId: JOURNEY, ref: '9BN8J', criteriaHash: 'hash-v2', activeWishes: [wish('Honda', 'HR-V')], wishes: [wish('Honda', 'HR-V')], ...over });
const match = (over = {}) => ({ id: 'm1', upload_id: 'lot-1', journey_id: JOURNEY, calc_ref: '9BN8J', logical_mode: 'CARRO', vehicle_json: { parsed: { lane: '1', run: '1', make: 'Honda', model: 'HR-V', year: 2022, miles: 30000, mmrCents: 2000000 } }, ...over });

test('carimbo traz ficha, Ref, tipo, critérios, versão, lote e validade', () => {
  const result = stamp.stampOf({ match: match(), demand: demand(), key: demand().key, activeUploadId: 'lot-1', hashes: ['hash-v1', 'hash-v2'] });
  assert.equal(result.journeyId, JOURNEY);
  assert.equal(result.ref, '9BN8J');
  assert.equal(result.type, 'CARRO');
  assert.equal(result.criteriaHash, 'hash-v2');
  assert.equal(result.version, 2);
  assert.equal(result.uploadId, 'lot-1');
  assert.equal(result.valid, true);
});

test('troca de lote invalida na hora', () => {
  const result = stamp.stampOf({ match: match(), demand: demand(), activeUploadId: 'lot-2', hashes: ['hash-v2'] });
  assert.deepEqual([result.valid, result.reason], [false, 'LOTE_MUDOU']);
  assert.match(result.reasonText, /lote/);
});

test('troca de critério invalida: o carro não serve mais ao pedido atual', () => {
  const other = demand({ criteriaHash: 'hash-v3', activeWishes: [wish('Toyota', 'Camry')], wishes: [wish('Toyota', 'Camry')] });
  const result = stamp.stampOf({ match: match(), demand: other, activeUploadId: 'lot-1', hashes: ['hash-v2'] });
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'CRITERIO_MUDOU');
  assert.equal(result.version, null);
});

test('pedido inativo, tipo diferente e carro sem MMR também invalidam', () => {
  assert.equal(stamp.stampOf({ match: match(), demand: null, activeUploadId: 'lot-1' }).reason, 'SEM_PEDIDO');
  assert.equal(stamp.stampOf({ match: match({ logical_mode: 'VALOR' }), demand: demand(), activeUploadId: 'lot-1' }).reason, 'TIPO_DIFERENTE');
  assert.equal(stamp.stampOf({ match: match({ vehicle_json: { parsed: { lane: '1', run: '1', make: 'Honda', model: 'HR-V' } } }), demand: demand(), activeUploadId: 'lot-1' }).reason, 'SEM_MMR');
});

test('o portão recusa carro inválido e deixa o válido passar (seleção e V1)', async () => {
  const deps = (rowsOf) => ({ rows: async () => rowsOf, latestActiveUpload: async () => ({ id: 'lot-1' }), loadBase: async () => ({}), demandContext: () => ({ listed: [demand()] }) });
  const stale = await stamp.gate({ environment: 'PRODUCTION' }, ['m1'], deps([match({ upload_id: 'lot-0' })]));
  assert.equal(stale && stale.code, 'MANHEIM_STAMP_INVALID');
  assert.equal(stale.reason, 'LOTE_MUDOU');
  assert.equal(await stamp.gate({ environment: 'PRODUCTION' }, ['m1'], deps([match()])), null);
  assert.equal((await stamp.gate({ environment: 'PRODUCTION' }, ['m1'], deps([]))).reason, 'LOTE_MUDOU');
});

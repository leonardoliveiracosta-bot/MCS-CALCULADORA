'use strict';
// BUSCAR CARROS / ENVIAR OPÇÕES: opções elegíveis agora, prova de comparação e critério mais
// recente. A regra de combinação (vehicle-match) não muda.
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../vehicle-catalog');

const FUTURE = '2099-01-01';
const car = (extra = {}) => ({ make: 'Toyota', model: 'Camry', trim: 'SE', year: 2020, miles: 40000, mmrCents: 2000000, lane: '12', run: '34', saleDate: FUTURE, ...extra });
// ---------------------------------------------------------------- C: só o critério mais recente
const requestDemands = require('../panel-request-demands');
const domain = require('../panel-domain');

test('C: versão ativa = maior created_at por request_id, qualquer que seja a ordem da leitura', () => {
  const rows = [
    { id: 'b', request_id: 'r1', created_at: '2026-10-05T10:00:00Z', criteria_json: { model: 'Wraith' } },
    { id: 'a', request_id: 'r1', created_at: '2026-10-01T10:00:00Z', criteria_json: { model: 'Wrist' } },
    { id: 'c', request_id: 'r2', created_at: '2026-10-02T10:00:00Z', criteria_json: { model: 'X5' } }
  ];
  const latest = requestDemands.latestVersions(rows);
  assert.equal(latest.get('r1').criteria_json.model, 'Wraith');
  assert.equal(latest.get('r2').criteria_json.model, 'X5');
});

test('C: conversa editada: só a última versão vira desejo da demanda ativa', async () => {
  const journey = { id: 'j1', reference_code: 'SNH5P', status: 'ATIVO', contact_id: 'c1' };
  const base = { journeyById: new Map([['j1', journey]]), demands: { byJourney: new Map([['j1', []]]) }, messageLinks: [] };
  const versions = [
    { id: 'v2', request_id: 'r1', created_at: '2026-10-05T10:00:00Z', criteria_json: { make: 'Rolls-Royce', model: 'Wraith', yearMin: 2015, yearMax: 2019, minMiles: 25000, maxMiles: 55000 }, evidence_json: {} },
    { id: 'v1', request_id: 'r1', created_at: '2026-10-01T10:00:00Z', criteria_json: { make: 'Rolls-Royce', model: 'Wrist', yearMin: 2015, yearMax: 2019, minMiles: 25000, maxMiles: 55000 }, evidence_json: {} }
  ];
  const read = async (ctx, table) => table === 'vehicle_requests' ? [{ id: 'r1', journey_id: 'j1' }] : table === 'vehicle_request_versions' ? versions : [];
  await requestDemands.attach({ environment: 'preview' }, base, read);
  const [demand] = base.demands.byJourney.get('j1');
  assert.deepEqual(demand.activeWishes.map((wish) => wish.model), ['Wraith']);
});

test('C: Ref SNH5P: critério salvo na ficha (Wraith) vale sobre o pedido antigo da calculadora (Wrist)', () => {
  const journey = { id: 'b110b167-0f90-43e6-9ab5-d4bae0c228af', reference_code: 'SNH5P', status: 'ATIVO', source: 'CALCULATOR',
    criteria_json: { mode_overrides: { CARRO: { wishlists: [{ make: 'Rolls-Royce', trim: '', model: 'Wraith', yearMax: 2019, yearMin: 2015, maxMiles: 55000, minMiles: 25000, budgetUsd: null, budgetExplicit: true, acceptAnyTitleCondition: false }], wishlistOverride: true } } } };
  const calc = [{ ref: 'SNH5P', logicalMode: 'CARRO', occurredAt: '2026-09-30T10:00:00Z', wishlists: [{ make: 'Rolls-Royce', model: 'Wrist', yearMin: 2015, yearMax: 2019, minMiles: 25000, maxMiles: 55000 }] }];
  const [demand] = domain.journeyDemands(journey, calc);
  assert.equal(demand.mode, 'CARRO');
  assert.deepEqual(demand.activeWishes.map((wish) => wish.model), ['Wraith']);
});

// ---------------------------------------------------------------- A/B: elegíveis agora e prova
const buscasView = require('../panel-buscas-view');

test('A: contagem elegível agora; opções que existiram e expiraram não viram "sem carro"', () => {
  assert.deepEqual(buscasView.batchCounts({ match_count: 3, bate_count: 3, por_valor_count: 0, stored_count: 5 }),
    { matchCount: 3, bateCount: 3, porValorCount: 0, servedCount: 3, storedCount: 5, expired: false });
  const gone = buscasView.batchCounts({ match_count: 0, bate_count: 0, quase_count: 0, por_valor_count: 0, stored_count: 4 });
  assert.equal(gone.expired, true);
  assert.equal(buscasView.batchCounts({ match_count: 0, bate_count: 0, stored_count: 0 }).expired, false);
  // Sem o resumo novo (migração pendente) não se afirma expirado.
  assert.equal(buscasView.batchCounts({ match_count: 0, bate_count: 0 }).expired, false);
});

test('B: só a prova (foto do lote ou manheim_demand_syncs) do criteriaHash atual tira de "Ainda não comparado"', () => {
  const known = buscasView.comparedKeys([{ key: 'journey:a:CARRO', criteriaHash: 'h1' }], [{ demand_key: 'journey:b:CARRO', criteria_hash: 'h2' }]);
  assert.equal(known.has('journey:a:CARRO|h1'), true);
  assert.equal(known.has('journey:b:CARRO|h2'), true);
  assert.equal(known.has('journey:a:CARRO|h9'), false, 'critério mudou: precisa comparar de novo');
});

test('A: motivo de pedido sem opção: carros que serviam e já expiraram', () => {
  const reasons = require('../search-empty-reason');
  catalog.configureAliases([]);
  const wish = { make: 'Toyota', model: 'Camry', yearMin: 2019, yearMax: 2021, minMiles: 20000, maxMiles: 50000 };
  const past = car({ saleDate: '2020-01-01', startsAt: '2020-01-01' });
  assert.equal(reasons.wishReason(wish, [past], { target: { mode: 'CARRO' } }).text, 'As opções encontradas neste lote já expiraram');
  assert.equal(reasons.wishReason(wish, [], { target: { mode: 'CARRO' } }).text, 'sem carro no lote');
});

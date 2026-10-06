'use strict';
// Matching A-E: opções elegíveis agora, prova de comparação, critério mais recente, BATE/QUASE e
// versões no trim (TRIM_VERSION). Cada teste reproduz o problema antes da correção.
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../vehicle-catalog');
const match = require('../vehicle-match');
const batch = require('../panel-manheim-batch');

const FUTURE = '2099-01-01';
const car = (extra = {}) => ({ make: 'Toyota', model: 'Camry', trim: 'SE', year: 2020, miles: 40000, mmrCents: 2000000, lane: '12', run: '34', saleDate: FUTURE, ...extra });
const carro = (wish, extra = {}) => ({ mode: 'CARRO', wishes: [{ make: 'Toyota', model: 'Camry', yearMin: 2019, yearMax: 2021, minMiles: 20000, maxMiles: 50000, ...wish }], ...extra });
// E: aliases do mecanismo que já existe (EQUIVALENT), como a migração 20261030010000 grava.
const ALIAS_ROWS = [['BMW', 'M550i', '5 Series'], ['BMW', '550i', '5 Series'], ['BMW', 'M340i', '3 Series'], ['BMW', '340i', '3 Series'],
  ['Lexus', 'ES 300h', 'ES'], ['Lexus', 'ES300h', 'ES'], ['Lexus', '300h', 'ES']]
  .map(([make, client, base]) => ({ make, client_model: client, manheim_models: [base], kind: 'EQUIVALENT', target_make: make }));
const kindOf = (vehicle, demand) => { const found = match.matchDemand(vehicle, demand); return found ? found.kind : null; };

test('D: dentro dos limites pedidos entra', () => {
  catalog.configureAliases([]);
  assert.equal(kindOf(car(), carro({})), 'BATE');
});

test('D: ano ±1 entra na mesma lista; dois anos fora não', () => {
  catalog.configureAliases([]);
  assert.equal(kindOf(car({ year: 2022 }), carro({})), 'BATE');
  assert.equal(kindOf(car({ year: 2018 }), carro({})), 'BATE');
  assert.equal(kindOf(car({ year: 2023 }), carro({})), null);
  assert.equal(kindOf(car({ year: 2017 }), carro({})), null);
});

test('D: milhas floor(mín×0,85) e ceil(máx×1,15), extremos inclusive', () => {
  catalog.configureAliases([]);
  const wish = { minMiles: 20001, maxMiles: 50001 };
  // floor(20001×0,85) = 17000; ceil(50001×1,15) = 57502
  assert.equal(kindOf(car({ miles: 17000 }), carro(wish)), 'BATE');
  assert.equal(kindOf(car({ miles: 16999 }), carro(wish)), null);
  assert.equal(kindOf(car({ miles: 57502 }), carro(wish)), 'BATE');
  assert.equal(kindOf(car({ miles: 57503 }), carro(wish)), null);
});

test('D: só alarga limite que a pessoa definiu (nenhum limite é criado)', () => {
  catalog.configureAliases([]);
  const open = { yearMin: 2019, yearMax: null, minMiles: null, maxMiles: 50000 };
  assert.equal(kindOf(car({ year: 2026, miles: 0 }), carro(open)), 'BATE', 'sem mínimo de milhas e sem ano máximo: nada é inventado');
  assert.equal(kindOf(car({ year: 2018, miles: 57500 }), carro(open)), 'BATE');
  assert.equal(kindOf(car({ year: 2017 }), carro(open)), null);
});

test('D: uma lista só, os mais próximos primeiro; sem tipo novo nem contagem separada', () => {
  catalog.configureAliases([]);
  const target = { key: 'journey:x:CARRO', targetType: 'JOURNEY', journeyId: 'x', ...carro({}) };
  const entries = [car({ year: 2022 }), car()].map((vehicle, index) => ({ fingerprint: 'f' + index, makeKey: 'toyota', mmrCents: vehicle.mmrCents, vehicle }));
  const rows = batch.matchChunk(entries, [target]);
  assert.deepEqual(rows.map((row) => row.kind), ['BATE', 'BATE']);
  // Pedido exato antes do alargado (mesma lista, ordem do servidor por sort_rank e milhas).
  assert.deepEqual(rows.map((row) => [row.fingerprint, row.sortRank]).sort((a, b) => a[1] - b[1]), [['f1', 0], ['f0', 1]]);
  assert.equal(match.countsAsServed('BATE'), true);
});

test('D: reativação também vê o alargado (é a mesma busca)', () => {
  catalog.configureAliases([]);
  assert.equal(batch.matchOne(car({ year: 2022 }), { key: 'journey:x:CARRO', ...carro({}), reactivation: true }).kind, 'BATE');
});

test('Ordem: sem venda ativa, sem MMR ou título ruim nunca entra; aceita qualquer título libera só título/CR', () => {
  catalog.configureAliases([]);
  const near = { year: 2022 };
  assert.equal(kindOf(car({ ...near, lane: '', run: '', buyNowPrice: '' }), carro({})), null);
  assert.equal(kindOf(car({ ...near, mmrCents: null }), carro({})), null);
  assert.equal(kindOf(car({ ...near, titleStatus: 'Salvage' }), carro({})), null);
  assert.equal(kindOf(car({ ...near, titleStatus: 'Salvage' }), carro({ acceptAnyTitleCondition: true })), 'BATE');
  assert.equal(kindOf(car({ ...near, titleStatus: 'Salvage', lane: '', run: '' }), carro({ acceptAnyTitleCondition: true })), null);
});

test('E: M550i/550i → 5 Series, M340i/340i → 3 Series, ES 300h/ES300h/300h → ES', () => {
  const want = (make, model) => ({ mode: 'CARRO', wishes: [{ make, model, yearMin: 2019, yearMax: 2021, minMiles: 0, maxMiles: 50000 }] });
  const cases = [['BMW', 'M550i', '5 Series', 'M550i xDrive'], ['BMW', '550i', '5 Series', '550i xDrive'], ['BMW', 'M340i', '3 Series', 'M340I XDR'],
    ['BMW', '340i', '3 Series', '340i'], ['Lexus', 'ES 300h', 'ES', 'ES 300h'], ['Lexus', 'ES300h', 'ES', 'ES 300h'], ['Lexus', '300h', 'ES', 'ES 300h']];
  catalog.configureAliases([]);
  for (const [make, model, base, trim] of cases) assert.equal(kindOf(car({ make, model: base, trim }), want(make, model)), null, 'sem o alias não combina: ' + model);
  catalog.configureAliases(ALIAS_ROWS);
  for (const [make, model, base, trim] of cases) assert.equal(kindOf(car({ make, model: base, trim }), want(make, model)), 'BATE', model);
  // Nada inferido: 540i não tem alias; outro modelo-base não combina.
  assert.equal(kindOf(car({ make: 'BMW', model: '5 Series', trim: '540i' }), want('BMW', '540i')), null);
  assert.equal(kindOf(car({ make: 'BMW', model: 'X5', trim: 'M50i' }), want('BMW', 'M550i')), null);
  catalog.configureAliases([]);
});

test('E: o dicionário muda o criteriaHash (alias novo pede nova comparação)', () => {
  const target = { key: 'journey:x:CARRO', ...carro({}) };
  catalog.configureAliases([], [], 'r1');
  const before = batch.criteriaHash(target);
  catalog.configureAliases(ALIAS_ROWS, [], 'r2');
  assert.notEqual(batch.criteriaHash(target), before);
  catalog.configureAliases([]);
});

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

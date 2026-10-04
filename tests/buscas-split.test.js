'use strict';

// buscas-split-desfazer-lote: BUSCAS por modo (VALOR = Calculate My Cost, CARRO = Find One For
// Me), distribuição individual do CSV, desfazer lote e OpenAI só para linhas ambíguas.
// Os números seguem a lista "TESTES OBRIGATÓRIOS" do comando.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const domain = require('../panel-domain');
const vehicleMatch = require('../vehicle-match');
const manheim = require('../painel/manheim');
const upload = require('../painel/manheim-upload');
const manheimAi = require('../panel-manheim-ai');
const realServer = require('../panel-server');
const buscas = require('../panel-buscas');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ACTOR = '62000000-0000-4000-8000-000000000001';
const uuid = (n) => `63000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function loadWith(relative, mocks) {
  const file = path.join(root, relative), mod = { exports: {} };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  return mod.exports;
}
const response = () => ({ code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.payload = value; return value; } });
const ctx = { modelAliasesLoaded: true, config: { url: 'https://example.test', secretKey: 'test' }, panel: { id: ACTOR }, environment: 'preview' };
const panelCtx = async () => ctx;
const car = (overrides) => ({ lane: '1', run: '1', year: 2022, make: 'BMW', model: 'X5', miles: 70000, mmrCents: 4500000, ...overrides });
const now = Date.now();
const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
const valorRow = (ref, extra = {}) => ({ id: 'v' + ref, created_at: iso(5), dados: { sid: 's-' + ref, ref, evento: 'simulacao', logical_mode: 'VALOR', marca: 'BMW', modelo: 'X5', lance: 50000, ...extra } });
const carroRow = (ref, extra = {}) => ({ id: 'c' + ref, created_at: iso(4), dados: { sid: 's-' + ref + '-find-1', ref, evento: 'busca', logical_mode: 'CARRO', canal: 'whatsapp', marca: 'BMW', modelo: 'X5', ano_de: 2020, ano_ate: 2025, milhas_de: 50000, milhas_ate: 90000, ...extra } });
const clickRow = (ref) => ({ id: 'k' + ref, created_at: iso(3), dados: { sid: 's-' + ref, ref, evento: 'whatsapp', logical_mode: 'VALOR' } });
const targetsOf = (built) => [...[...built.byJourney.values()].flat(), ...built.orders].filter((demand) => demand.active)
  .map((demand) => ({ key: demand.key, mode: demand.mode, targetType: demand.targetType, journeyId: demand.journeyId, ref: demand.ref, wishes: demand.activeWishes, bidCents: demand.bidCents }));
const withCsv = (vehicle) => ({ ...vehicle, headers: ['Year'], raw: { Year: String(vehicle.year) }, vin: vehicle.vin || 'VIN' + vehicle.year + vehicle.miles });

// ------------------------------------------------------------------ 1-2 payload do site
test('1 · o Calculate My Cost envia logical_mode VALOR e 2 · o Find One For Me envia CARRO', () => {
  const site = read('msc-calculadora.html');
  const registrar = site.slice(site.indexOf('function registrar(evento){'), site.indexOf('function registrarBusca('));
  const busca = site.slice(site.indexOf('function registrarBusca('), site.indexOf('var tmrLog'));
  assert.match(registrar, /evento: evento \|\| "simulacao",\s*logical_mode: "VALOR",/);
  assert.doesNotMatch(registrar, /logical_mode: "CARRO"/);
  assert.match(busca, /evento:"busca",logical_mode:"CARRO"/);
  assert.doesNotMatch(busca, /logical_mode:"VALOR"/);
  // The panel reads the explicit mode first; the historical inference stays for old rows.
  assert.equal(domain.logicalMode({ dados: { evento: 'whatsapp', logical_mode: 'CARRO' } }), 'CARRO');
  assert.equal(domain.logicalMode({ dados: { evento: 'busca' } }), 'CARRO');
  for (const evento of ['simulacao', 'saida', 'share', 'whatsapp', 'sms']) assert.equal(domain.logicalMode({ dados: { evento } }), 'VALOR');
  assert.equal(domain.logicalMode({ dados: { evento: 'outro' } }), 'REVIEW');
  // The restrictive policy accepts the new key (it limits size, Ref, event and sid only).
  assert.match(read('supabase/migrations/20260929030000_calc_runs_insert_limits.sql'), /octet_length\(dados::text\) <= 4096/);
});

// ------------------------------------------------------------------ 3-5, 18 BUSCAS por modo
// The database answers the summary per demand (panel_manheim_batch_summary); simulated here over the
// same rows, with the same rules (active rows only, MMR mandatory, key from target and mode).
function summaryOf(tables, uploadId) {
  const rows = (tables.manheim_matches || []).filter((row) => row.upload_id === undefined || row.upload_id === uploadId).filter((row) => !row.undone_at && vehicleMatch.hasValidMmr(row.vehicle_json && row.vehicle_json.parsed));
  const groups = new Map();
  rows.forEach((row) => {
    const key = row.demand_key || (row.journey_id ? 'journey:' + row.journey_id : 'ref:' + String(row.calc_ref).trim()) + ':' + (row.logical_mode || '');
    if (!groups.has(key)) groups.set(key, { demand_key: key, logical_mode: row.logical_mode, journey_id: row.journey_id || null, calc_ref: row.calc_ref ? String(row.calc_ref).trim() : null, match_count: 0, bate_count: 0, por_valor_count: 0, presented_count: 0, criteria_hashes: [] });
    const group = groups.get(key);
    group.match_count += 1; if (row.match_kind === 'BATE') group.bate_count += 1; if (row.match_kind === 'POR_VALOR') group.por_valor_count += 1; if (row.presented_unit_id) group.presented_count += 1;
  });
  return [...groups.values()];
}
async function buscasView(tables) {
  const server = { ...realServer, allRows: async (_ctx, table) => tables[table] || [], rows: async (_ctx, table, params = {}) => (tables[table] || []).filter((row) => params.undone_at !== 'is.null' || !row.undone_at),
    panelMeta: async () => ({}), rpc: async (_ctx, name, args) => name === 'panel_manheim_batch_summary' ? summaryOf(tables, args.p_upload_id) : [] };
  const view = loadWith('panel-buscas-view.js', {
    './panel-server': server,
    './panel-ready': { score: () => ({}), loadScoreIndex: async () => [] },
    './panel-search-stage': { decorateWithSearchStage: (item) => item, loadSearchStageIndex: async () => new Map() },
    './panel-manheim-state': { undoSupported: async () => true, batchSupported: async () => true, activeFilter: async () => ({ undone_at: 'is.null' }), liveUploadFilter: async () => ({ undone_at: 'is.null' }) },
    './panel-buscas': loadWith('panel-buscas.js', { './panel-server': server })
  });
  return view.manheimView(ctx);
}
const contacted = (refs) => refs.map(clickRow);

test('3 · Ref só VALOR aparece só em VALOR, 4 · Ref só CARRO só em CARRO, 5 · Ref com os dois vira duas demandas e 18 · contadores independentes', async () => {
  const upload1 = { id: uuid(90), source_file_count: 2, vehicle_count: 3, matched_vehicle_count: 4, lead_count: 3, uploaded_at: iso(1) };
  const x5 = car({ vin: 'VINX5A' });
  const matches = [
    { id: uuid(1), calc_ref: 'VAAA2', logical_mode: 'VALOR', match_kind: 'POR_VALOR', row_fingerprint: 'vin:VINX5A', vehicle_json: { parsed: x5 } },
    { id: uuid(2), calc_ref: 'CBBB3', logical_mode: 'CARRO', match_kind: 'BATE', row_fingerprint: 'vin:VINX5A', vehicle_json: { parsed: x5 } },
    { id: uuid(3), calc_ref: 'DCCC4', logical_mode: 'VALOR', match_kind: 'POR_VALOR', row_fingerprint: 'vin:VINX5A', vehicle_json: { parsed: x5 } },
    { id: uuid(4), calc_ref: 'DCCC4', logical_mode: 'CARRO', match_kind: 'BATE', row_fingerprint: 'vin:VINX5A', vehicle_json: { parsed: x5 } }
  ];
  // A calculator click is not contact: each Ref here belongs to a ficha whose client really wrote.
  const owners = { VAAA2: uuid(61), CBBB3: uuid(62), DCCC4: uuid(63) };
  matches.forEach((match) => { match.journey_id = owners[match.calc_ref]; });
  const journeys = Object.entries(owners).map(([ref, id], index) => ({ id, contact_id: uuid(71 + index), reference_code: ref, status: 'ATIVO', source: 'CALCULATOR', criteria_json: {}, created_at: iso(9), updated_at: iso(9) }));
  const contacts = journeys.map((journey) => ({ id: journey.contact_id, display_name: 'Cliente ' + journey.reference_code, is_lead: true }));
  const messages = journeys.map((journey, index) => ({ id: 'w' + index, direction: 'CUSTOMER', occurred_at_utc: iso(2), source_kind: 'WHATSAPP_WEBHOOK' }));
  const message_journeys = journeys.map((journey, index) => ({ journey_id: journey.id, message_id: 'w' + index }));
  const calc_runs = [valorRow('VAAA2'), carroRow('CBBB3'), valorRow('DCCC4'), carroRow('DCCC4'), ...contacted(['VAAA2', 'CBBB3', 'DCCC4'])];
  const data = await buscasView({ calc_runs, journeys, contacts, messages, message_journeys, manheim_uploads: [upload1], manheim_matches: matches });
  const modesOf = (ref) => data.demands.filter((demand) => demand.ref === ref).map((demand) => demand.mode).sort();
  assert.deepEqual(modesOf('VAAA2'), ['VALOR']);
  assert.deepEqual(modesOf('CBBB3'), ['CARRO']);
  assert.deepEqual(modesOf('DCCC4'), ['CARRO', 'VALOR']);
  // No car travels in the BUSCAS answer: each demand carries its own counts.
  assert.equal(data.matches, undefined);
  const liveModes = (ref) => data.demands.filter((demand) => demand.ref === ref && demand.matchCount > 0).map((demand) => demand.mode).sort();
  assert.deepEqual(liveModes('VAAA2'), ['VALOR']);
  assert.deepEqual(liveModes('CBBB3'), ['CARRO']);
  assert.deepEqual(liveModes('DCCC4'), ['CARRO', 'VALOR']);
  assert.ok(data.demands.every((demand) => ['CARRO', 'VALOR'].includes(demand.mode)), 'nenhuma demanda MIXED');
  assert.deepEqual([data.counts.VALOR.demands, data.counts.VALOR.served, data.counts.VALOR.matches], [2, 2, 2]);
  assert.deepEqual([data.counts.CARRO.demands, data.counts.CARRO.served, data.counts.CARRO.matches], [2, 2, 2]);
  // The total counts people once: DCCC4 is served in both modes and is one person.
  assert.deepEqual([data.counts.total.people, data.counts.total.served, data.counts.total.matches], [3, 3, 4]);
  // One demand per person and mode, never MIXED (they are also the targets of a new batch).
  assert.deepEqual(data.demands.map((demand) => demand.key).sort(), [`journey:${owners.VAAA2}:VALOR`, `journey:${owners.CBBB3}:CARRO`, `journey:${owners.DCCC4}:CARRO`, `journey:${owners.DCCC4}:VALOR`].sort());
  // 24 · a batch made of several CSV files is one batch.
  assert.deepEqual(data.uploads.map((batch) => [batch.fileCount, batch.status, batch.current]), [[2, 'ACTIVE', true]]);
});

// ------------------------------------------------------------------ 6-8 estados independentes
test('6 · mesma ficha nos dois modos tem estados independentes, 7 · busca salva VALOR não altera CARRO e 8 · enviada CARRO não altera VALOR', async () => {
  const journey = { id: uuid(10), reference_code: 'DCCC4', status: 'ATIVO', source: 'CALCULATOR', criteria_json: {}, budget_cents: null, created_at: iso(10) };
  const tables = {
    journeys: [journey], journey_refs: [], calc_runs: [valorRow('DCCC4'), carroRow('DCCC4')], calculator_request_links: [],
    manheim_saved_searches: [], panel_search_marks: [{ journey_id: uuid(10), kind: 'SAVED', created_at: iso(1), logical_mode: 'VALOR' }, { journey_id: uuid(10), kind: 'SENT', created_at: iso(1), logical_mode: 'CARRO' }],
    lead_events: [], units: [], sms_print_reads: [], journey_toggle_states: [], manheim_matches: []
  };
  const server = { ...realServer, allRows: async (_ctx, table) => tables[table] || [] };
  const stage = loadWith('panel-search-stage.js', { './panel-server': server, './panel-manheim-state': { undoSupported: async () => true } });
  const index = await stage.loadSearchStageIndex(ctx);
  const modes = index.get(uuid(10)).modes;
  assert.deepEqual([modes.VALOR.stage, modes.CARRO.stage], ['SAVED', 'SENT']);
  assert.deepEqual([modes.VALOR.searchKey, modes.CARRO.searchKey], ['bmw|x5|valor', 'bmw|x5']);
  // Actions send and store the mode; the other mode is never touched.
  const inserted = [], patched = [];
  const searches = loadWith('api/panel/searches.js', {
    '../../panel-server': { ...realServer, requirePanel: panelCtx, jsonBody: async (req) => req.body, rows: async () => [], insert: async (_ctx, table, payload) => { inserted.push({ table, payload }); return [payload]; }, patchRows: async (_ctx, table, filters, payload) => { patched.push({ table, filters, payload }); return [payload]; } },
    '../../panel-search-stage': { ...stage, loadSearchStageIndex: async () => new Map([[uuid(10), { modes: { VALOR: { searchKey: 'bmw|x5|valor' }, CARRO: { searchKey: 'bmw|x5' } } }], [uuid(11), { modes: { CARRO: { searchKey: 'bmw|x5' } } }]]) },
    '../../panel-manheim-state': { latestActiveUpload: async () => null, undoSupported: async () => true }
  });
  const call = async (body) => { const res = response(); await searches({ method: 'POST', headers: {}, body }, res); return res; };
  assert.equal((await call({ action: 'mark', journeyId: uuid(10), kind: 'SAVED', mode: 'VALOR' })).code, 201);
  assert.deepEqual(inserted.map((row) => [row.payload.journey_id, row.payload.kind, row.payload.logical_mode]), [[uuid(10), 'SAVED', 'VALOR']], 'a busca VALOR não marca a busca CARRO de outra ficha');
  inserted.length = 0;
  assert.equal((await call({ action: 'mark', journeyId: uuid(10), kind: 'SENT', mode: 'CARRO' })).code, 201);
  assert.deepEqual(inserted.map((row) => [row.payload.journey_id, row.payload.kind, row.payload.logical_mode]), [[uuid(10), 'SENT', 'CARRO']]);
  assert.equal((await call({ action: 'mark', journeyId: uuid(10), kind: 'SAVED' })).code, 400, 'com dois modos, o modo é obrigatório');
  assert.equal((await call({ action: 'undo', journeyId: uuid(10), kind: 'SENT', mode: 'CARRO' })).code, 200);
  assert.equal(patched.at(-1).filters.logical_mode, 'eq.CARRO');
});

test('contexto de cliente consulta somente as fichas e Refs pedidas, inclusive buscas salvas', async () => {
  const target = { id: uuid(70), reference_code: 'SCOPE1', source: 'CALCULATOR', status: 'ATIVO', criteria_json: { logical_modes: ['VALOR'], wishlists: [{ make: 'BMW', model: 'X5' }] }, budget_cents: 5000000, created_at: iso(1), updated_at: iso(1) };
  const calls = [];
  const server = { allRows: async (_ctx, table, query = {}) => {
    calls.push({ table, query });
    if (table === 'journeys' && query.id) return [target];
    if (table === 'journeys' && query.reference_code) return [{ id: target.id, reference_code: 'SCOPE1' }];
    if (table === 'calc_runs' && query['dados->>ref']) return [valorRow('SCOPE1')];
    return [];
  } };
  const stage = loadWith('panel-search-stage.js', { './panel-server': server, './panel-manheim-state': { undoSupported: async () => true } });
  const result = await stage.loadSearchStageIndex(ctx, { journeyIds: [target.id] });
  assert.equal(result.get(target.id)?.modes?.VALOR?.stage, 'MISSING');
  assert.ok(calls.some((call) => call.table === 'journeys' && call.query.id?.startsWith('in.(')));
  assert.ok(calls.some((call) => call.table === 'calc_runs' && call.query['dados->>ref']?.startsWith('in.(')));
  assert.ok(calls.some((call) => call.table === 'manheim_saved_searches' && call.query.search_key?.includes('bmw|x5|valor')));
  for (const table of ['journeys', 'journey_refs', 'calc_runs', 'calculator_request_links', 'panel_search_marks', 'lead_events', 'units', 'sms_print_reads', 'journey_toggle_states']) {
    assert.ok(calls.filter((call) => call.table === table).every((call) => Object.keys(call.query).some((key) => ['id', 'journey_id', 'reference_code', 'ref_code', 'dados->>ref', 'calc_ref', 'confirmed_journey_id'].includes(key))), `${table} não pode ser lida inteira para um resumo de ficha`);
  }
});

test('Ref compartilhada por fichas diferentes fica em revisão e não gera busca duplicada; dois modos da mesma ficha continuam separados', () => {
  const first = { id: uuid(31), reference_code: 'SHARE', status: 'ATIVO', source: 'CALCULATOR', criteria_json: {}, created_at: iso(1) };
  const second = { id: uuid(32), reference_code: null, status: 'ATIVO', source: 'CALCULATOR', criteria_json: {}, created_at: iso(1) };
  const rows = [valorRow('SHARE'), carroRow('SHARE')];
  const collision = domain.buildSearchDemands({ journeys: [first, second], refs: [{ journey_id: second.id, ref_code: 'SHARE' }], modeItems: domain.consolidateCalcRuns(rows), externalOwners: [] });
  const noOrderHistory = domain.buildSearchDemands({ journeys: [first, second], refs: [{ journey_id: second.id, ref_code: 'SHARE' }], modeItems: [] });
  assert.equal(noOrderHistory.byJourney.get(first.id).some((item) => item.issues.some((issue) => issue.code === 'REF_AMBIGUOUS')), true, 'a colisão também aparece sem eventos da calculadora');
  const scopedCollision = domain.buildSearchDemands({ journeys: [first], refs: [], modeItems: domain.consolidateCalcRuns(rows), externalOwners: [{ id: second.id, ref_code: 'SHARE' }] });
  assert.equal(scopedCollision.byJourney.get(first.id).filter((item) => item.active).length, 0, 'um resumo por vez também detecta a outra ficha');
  for (const journey of [first, second]) {
    const demands = collision.byJourney.get(journey.id);
    assert.equal(demands.filter((item) => item.active).length, 0);
    assert.equal(demands.filter((item) => item.issues.some((issue) => issue.code === 'REF_AMBIGUOUS')).length, 2);
    assert.match(demands[0].issues[0].text, /Ref SHARE ligada a mais de uma ficha/);
  }
  assert.equal(collision.orders.length, 0, 'Ref ambígua não vira pedido sem ficha por fallback');
  assert.equal(collision.owner.has('SHARE'), true, 'Ref ambígua não reaparece como pedido independente');
  const ambiguousCard = buscas.reviewItem({ journeyById: new Map(), groupedByRef: new Map(), refsOf: () => [], primaryPhone: () => null }, collision.byJourney.get(first.id)[0]);
  assert.equal(ambiguousCard.canDefineMode, false, 'escolher CARRO/VALOR não resolve qual ficha é dona da Ref');
  const oneOwner = domain.buildSearchDemands({ journeys: [first], refs: [], modeItems: domain.consolidateCalcRuns(rows) });
  assert.deepEqual(oneOwner.byJourney.get(first.id).filter((item) => item.active).map((item) => item.mode).sort(), ['CARRO', 'VALOR']);
});

// ------------------------------------------------------------------ 9-17 regras
test('9 · critérios CARRO não entram em VALOR e 10 · lance e MMR não entram em CARRO', () => {
  const journey = { id: uuid(20), reference_code: 'DCCC4', status: 'ATIVO', criteria_json: {}, budget_cents: 5000000 };
  const items = domain.consolidateCalcRuns([valorRow('DCCC4'), carroRow('DCCC4')]);
  const [valor, carro] = ['VALOR', 'CARRO'].map((mode) => domain.journeyDemands(journey, items).find((demand) => demand.mode === mode));
  assert.deepEqual([valor.wishes[0].yearMin, valor.wishes[0].yearMax, valor.wishes[0].minMiles, valor.wishes[0].maxMiles], [null, null, null, null]);
  assert.equal(carro.bidCents, null);
  // A 1998 with 300k miles is still a VALOR option (year and mileage are not VALOR criteria).
  assert.equal(domain.matchManheimDemand(car({ year: 1998, miles: 300000 }), valor), null);
  // CARRO ignores money: MMR far outside any band, bid given anyway.
  assert.equal(vehicleMatch.matchDemand(car({ mmrCents: 99900000 }), { ...carro, wishes: carro.activeWishes, bidCents: 100 }), null);
  // MMR is mandatory in CARRO too: without it the car is never an option (its amount still decides nothing).
  assert.equal(vehicleMatch.matchDemand(car({ mmrCents: null }), { ...carro, wishes: carro.activeWishes }), null);
});

test('11 · lance de US$ 50.000: faixa US$ 35.000 a US$ 57.500; MMR 15.000 e 70.000 ficam fora', () => {
  const band = vehicleMatch.valueBand(5000000);
  assert.deepEqual([band.minCents, band.maxCents], [3500000, 5750000]);
  const valor = { mode: 'VALOR', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 5000000 };
  assert.equal(vehicleMatch.matchDemand(car({ mmrCents: 4500000 }), valor).kind, 'POR_VALOR');
  assert.equal(vehicleMatch.matchDemand(car({ mmrCents: 1500000 }), valor), null);
  assert.equal(vehicleMatch.matchDemand(car({ mmrCents: 7000000 }), valor), null);
  assert.equal(vehicleMatch.matchDemand(car({ mmrCents: 3500000 }), valor).kind, 'POR_VALOR');
  assert.equal(vehicleMatch.matchDemand(car({ mmrCents: 5750000 }), valor).kind, 'POR_VALOR');
  // Above US$ 60.000: 75% to 110%.
  assert.deepEqual([vehicleMatch.valueBand(8000000).minCents, vehicleMatch.valueBand(8000000).maxCents], [6000000, 8800000]);
});

test('12 · ano fora não entra, 13 · milhagem fora não entra, 14 · milhas_de é preservada e 15 · sem odômetro não entra (CARRO)', () => {
  const [item] = domain.consolidateCalcRuns([carroRow('CBBB3')]);
  const demand = domain.orderDemand(item);
  assert.deepEqual(demand.activeWishes[0], { make: 'BMW', model: 'X5', yearMin: 2020, yearMax: 2025, minMiles: 50000, maxMiles: 90000, trim: '' });
  const match = (vehicle) => vehicleMatch.matchDemand(vehicle, { ...demand, wishes: demand.activeWishes });
  assert.equal(match(car({ year: 2022, miles: 70000 })).kind, 'BATE');
  assert.equal(match(car({ year: 2015, miles: 70000 })), null);
  assert.equal(match(car({ year: 2022, miles: 120000 })), null);
  assert.equal(match(car({ year: 2015, miles: 150000 })), null);
  // The minimum mileage is a real limit (a 10.000 mile car is below 50.000).
  assert.equal(match(car({ year: 2022, miles: 10000 })), null);
  for (const miles of [null, undefined, '', 'TMU']) assert.equal(match(car({ miles })), null);
  // Limits are inclusive; no tolerance of one year or 10% of mileage.
  assert.equal(match(car({ year: 2020, miles: 50000 })).kind, 'BATE');
  assert.equal(match(car({ year: 2025, miles: 90000 })).kind, 'BATE');
  assert.equal(match(car({ year: 2026, miles: 90000 })), null);
  assert.equal(match(car({ year: 2025, miles: 90001 })), null);
  // A historical CARRO with an inverted or incomplete range is never searched and goes to review.
  const inverted = domain.orderDemand(domain.consolidateCalcRuns([carroRow('EDDD5', { milhas_de: 90000, milhas_ate: 50000 })])[0]);
  assert.deepEqual([inverted.active, inverted.issues[0].code], [false, 'MILES_INVERTED']);
  assert.deepEqual(inverted.wishes[0].minMiles, 90000, 'os valores originais não são trocados');
  const incomplete = domain.orderDemand(domain.consolidateCalcRuns([carroRow('FEEE6', { ano_ate: null })])[0]);
  assert.deepEqual([incomplete.active, incomplete.issues.length, incomplete.wishes[0].yearMax], [true, 0, null]);
});

test('16 · a faixa agregada do grupo não decide o resultado individual e 17 · o mesmo carro gera um match por modo', () => {
  const rows = [carroRow('AAAA2', { ano_de: 2015, ano_ate: 2017, milhas_de: 1000, milhas_ate: 30000 }), carroRow('BBBB3', { ano_de: 2022, ano_ate: 2024, milhas_de: 1000, milhas_ate: 30000 }), valorRow('BBBB3')];
  const built = domain.buildSearchDemands({ journeys: [], refs: [], modeItems: domain.consolidateCalcRuns(rows) });
  const targets = targetsOf(built);
  // The Manheim search would cover 2015 a 2024; a 2019 fits nobody individually in CARRO.
  const middle = withCsv(car({ year: 2019, miles: 20000, mmrCents: 4500000, vin: 'VINMID' }));
  const matches = upload.buildMatches([middle], targets, manheim);
  assert.deepEqual(matches.map((match) => [match.calcRef, match.mode]), [['BBBB3', 'VALOR']]);
  const newer = withCsv(car({ year: 2023, miles: 20000, mmrCents: 4500000, vin: 'VINNEW' }));
  const both = upload.buildMatches([newer], targets, manheim);
  assert.deepEqual(both.map((match) => [match.calcRef, match.mode, match.kind]).sort(), [['BBBB3', 'CARRO', 'BATE'], ['BBBB3', 'VALOR', 'POR_VALOR']]);
  assert.equal(new Set(both.map((match) => match.fingerprint)).size, 1, 'o mesmo carro');
});

// ------------------------------------------------------------------ 21-23 revisar tipo
test('21 · Revisar tipo define CARRO, 22 · define VALOR e 23 · definir um modo não altera a outra demanda', async () => {
  const journeys = new Map([[uuid(30), { id: uuid(30), contact_id: uuid(31), status: 'ATIVO', criteria_json: { wishlists: [{ make: 'BMW', model: 'X5' }] } }]]);
  const writes = [], audits = [];
  const handler = loadWith('api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: panelCtx, jsonBody: async (req) => req.body,
      rows: async (_ctx, table, params) => table === 'journeys' ? [journeys.get(String(params.id).replace('eq.', ''))].filter(Boolean) : [],
      patchRows: async (_ctx, table, filters, payload) => { writes.push({ table, payload }); const id = String(filters.id).replace('eq.', ''); journeys.set(id, { ...journeys.get(id), ...payload }); return []; },
      recordMutation: async (_ctx, input) => { audits.push(input); } },
    '../../panel-read-model': { ...require('../panel-read-model'), journeyExists: async (_ctx, id) => journeys.get(id) || null }
  });
  const call = async (mode) => { const res = response(); await handler({ method: 'POST', headers: {}, body: { action: 'set_search_mode', journeyId: uuid(30), mode } }, res); return res; };
  const before = domain.journeyDemands(journeys.get(uuid(30)), []);
  assert.deepEqual(before.map((demand) => demand.mode), ['REVIEW']);
  assert.deepEqual((await call('CARRO')).payload.modes, ['CARRO']);
  assert.deepEqual((await call('VALOR')).payload.modes, ['VALOR', 'CARRO'], 'CARRO continua');
  assert.equal((await call('MIXED')).code, 400);
  assert.equal((await call('VALOR')).payload.unchanged, true);
  assert.deepEqual(journeys.get(uuid(30)).criteria_json.wishlists, [{ make: 'BMW', model: 'X5' }], 'os desejos da ficha não mudam');
  // The first mode defined owns the ficha's manual criteria; VALOR, added later, inherits nothing.
  assert.deepEqual(journeys.get(uuid(30)).criteria_json.mode_overrides, { CARRO: { wishlists: [{ make: 'BMW', model: 'X5', yearMin: null, yearMax: null, minMiles: null, maxMiles: null, trim: '' }], wishlistOverride: false } });
  assert.deepEqual(audits.map((entry) => [entry.action, entry.before.logical_modes, entry.after.logical_modes]), [['SET_SEARCH_MODE', [], ['CARRO']], ['SET_SEARCH_MODE', ['CARRO'], ['VALOR', 'CARRO']]]);
  assert.ok(audits.every((entry) => entry.activityType === 'SEARCH_MODE_DEFINED'));
  const after = domain.journeyDemands(journeys.get(uuid(30)), []);
  assert.deepEqual(after.map((demand) => demand.mode), ['VALOR', 'CARRO']);
  assert.deepEqual(after.map((demand) => [demand.mode, demand.wishes.map((wish) => wish.model), demand.issues.map((issue) => issue.code)]), [['VALOR', [], ['MODEL_MISSING']], ['CARRO', ['X5'], ['YEAR_MISSING']]]);
});

// ------------------------------------------------------------------ 25-32 lotes desfeitos
test('25 · lote desfeito sai do uso: o último upload é o último ATIVO; sem lote ativo, estado vazio', async () => {
  const undone = { id: uuid(40), source_file_count: 1, vehicle_count: 5, matched_vehicle_count: 2, lead_count: 1, uploaded_at: iso(1), undone_at: iso(0.5) };
  const older = { id: uuid(41), source_file_count: 3, vehicle_count: 7, matched_vehicle_count: 0, lead_count: 0, uploaded_at: iso(2), undone_at: null };
  const data = await buscasView({ manheim_uploads: [undone, older], manheim_matches: [] });
  assert.equal(data.upload.id, uuid(41));
  assert.deepEqual(data.uploads.map((batch) => [batch.status, batch.current]), [['UNDONE', false], ['ACTIVE', true]]);
  const none = await buscasView({ manheim_uploads: [undone], manheim_matches: [] });
  assert.equal(none.upload, null);
  const state = require('../panel-manheim-state');
  assert.equal(typeof state.latestActiveUpload, 'function');
});

test('30 · score, 31 · HOJE e 32 · relatório só leem lotes ativos (e nunca o inventário inteiro)', async () => {
  const seen = [];
  // Score: one reference MMR per person answered by the database over the live batches only.
  const ready = read('panel-ready.js');
  assert.match(ready, /panel_manheim_score_mmr/);
  assert.doesNotMatch(ready, /allRows\(ctx, 'manheim_(vehicles|matches)'/);
  assert.match(read('supabase/migrations/20261005010000_panel_manheim_lote_unico.sql'), /u\.undone_at is null and u\.activated_at is not null and u\.uploaded_at >= p_since/);
  // HOJE, CLIENTES and the report never read cars or matches.
  for (const file of ['api/panel/today.js', 'api/panel/records.js', 'api/panel/report.js']) assert.doesNotMatch(read(file), /allRows\(ctx, 'manheim_(vehicles|matches)'/, file);
  assert.match(read('api/panel/report.js'), /manheim_uploads'[^\n]*\.\.\.liveBatch/);
  // The ficha reads only the makes the person asked for, in live batches.
  assert.match(read('panel-lead.js'), /make_key: 'in\.\(/);
  assert.match(read('panel-lead.js'), /liveUploadIds\(ctx/);
  // New V1, new V2 and "apresentei" refuse a match of an undone (or unfinished) batch.
  assert.match(read('api/panel/vitrines.js'), /VITRINE_SOURCE_UNDONE/);
  assert.match(read('api/panel/actions.js'), /A match of an undone import batch is never presented/);
  assert.match(read('api/panel/actions.js'), /matchIsLive\(ctx, match/);
  const vitrines = loadWith('api/panel/vitrines.js', { '../../panel-manheim-state': { activeFilter: async () => ({ undone_at: 'is.null' }) } });
  const services = { activeFilter: async () => ({ undone_at: 'is.null' }), liveUploadFilter: async () => ({ undone_at: 'is.null', activated_at: 'not.is.null' }), rows: async (_ctx, table, params) => { seen.push({ table, params }); return table === 'journeys' ? [{ id: uuid(50), contact_id: uuid(51), reference_code: 'AAAA2' }] : []; }, insert: async () => [{}] };
  assert.equal(await vitrines.create(ctx, { journeyId: uuid(50), matchIds: [uuid(52)] }, services), null, 'match de lote desfeito não vira V1');
  assert.equal(seen.find((call) => call.table === 'manheim_matches').params.undone_at, 'is.null');
  // A match whose batch is not live (undone or still being assembled) is refused too.
  const live = { ...services, rows: async (_ctx, table) => table === 'journeys' ? [{ id: uuid(50), contact_id: uuid(51), reference_code: 'AAAA2' }] : table === 'manheim_matches' ? [{ id: uuid(52), upload_id: uuid(53), vehicle_json: { parsed: car({}) } }] : [] };
  assert.equal(await vitrines.create(ctx, { journeyId: uuid(50), matchIds: [uuid(52)] }, live), null, 'lote em montagem não vira V1');
});

test('27 · desfazer duas vezes é idempotente no servidor e sem migração responde pendente', async () => {
  const calls = [];
  const make = (supported, result) => loadWith('api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: panelCtx, jsonBody: async (req) => req.body, supabase: async (_u, _k, requestPath, options) => { calls.push({ requestPath, body: JSON.parse(options.body) }); return result; } },
    '../../panel-manheim-state': { activeFilter: async () => ({}), undoSupported: async () => supported }
  });
  const res = response();
  await make(true, { uploadId: uuid(60), alreadyUndone: true, summary: { matchesWithdrawn: 3 } })({ method: 'POST', headers: {}, body: { action: 'manheim_undo', uploadId: uuid(60) } }, res);
  assert.deepEqual([res.code, res.payload.alreadyUndone], [200, true]);
  assert.deepEqual(calls[0], { requestPath: '/rest/v1/rpc/panel_undo_manheim_upload', body: { p_environment: 'preview', p_actor_id: ACTOR, p_upload_id: uuid(60) } });
  const pending = response();
  await make(false, null)({ method: 'POST', headers: {}, body: { action: 'manheim_undo', uploadId: uuid(60) } }, pending);
  assert.deepEqual([pending.code, pending.payload.error], [503, 'MANHEIM_MIGRATION_PENDING']);
  const invalid = response();
  await make(true, null)({ method: 'POST', headers: {}, body: { action: 'manheim_undo', uploadId: 'x' } }, invalid);
  assert.equal(invalid.code, 400);
  // 26, 28, 29: other batches unchanged, units and vitrines preserved (tests/sql/teste-buscas-split-desfazer-lote.sql).
  const scenario = read('tests/sql/teste-buscas-split-desfazer-lote.sql');
  for (const check of ['o outro lote foi alterado', 'unidade ou vitrine perdida', 'desfazer duas vezes não é idempotente', 'match apagado fisicamente']) assert.match(scenario, new RegExp(check));
  const migration = read('supabase/migrations/20261001010000_panel_buscas_split_desfazer_lote.sql');
  assert.doesNotMatch(migration, /delete from public\.(manheim_(uploads|matches|vehicles)|units|vitrine|journeys|contacts|messages)/i);
  assert.doesNotMatch(migration, /create table/i);
});

// ------------------------------------------------------------------ 33 Arquivo do Manheim primeiro
test('33 · IMPORTAÇÕES tem o arquivo e os lotes; ENVIAR OPÇÕES e BUSCAR CARROS têm VALOR antes de CARRO, sem upload', () => {
  const html = read('painel/index.html');
  const imports = html.slice(html.indexOf('<section id="imports-panel"'), html.indexOf('<section id="searches-panel"'));
  const panel = html.slice(html.indexOf('<section id="searches-panel"'), html.indexOf('<section id="manheim-panel"'));
  const search = html.slice(html.indexOf('<section id="requests-panel"'), html.indexOf('<section id="imports-panel"'));
  assert.ok(imports.indexOf('id="manheim-files"') >= 0 && imports.indexOf('id="manheim-files"') < imports.indexOf('id="manheim-batches"'));
  const order = ['id="buscas-valor"', 'id="buscas-carro"'].map((marker) => panel.indexOf(marker));
  assert.ok(order.every((position) => position >= 0), JSON.stringify(order));
  assert.deepEqual(order.slice().sort((a, b) => a - b), order);
  const searchOrder = ['id="search-col-valor"', 'id="buscas-valor-saved"', 'id="search-col-carro"', 'id="buscas-carro-saved"', 'id="buscas-review"'].map((marker) => search.indexOf(marker));
  assert.ok(searchOrder.every((position) => position >= 0), JSON.stringify(searchOrder));
  assert.deepEqual(searchOrder.slice().sort((a, b) => a - b), searchOrder);
  assert.doesNotMatch(panel + search, /manheim-files|manheim-batches/);
  assert.match(panel, /Calculate My Cost/);
  assert.match(panel, /Find One For Me/);
  assert.match(search, /Calculate My Cost/);
  assert.match(search, /Find One For Me/);
});

// ------------------------------------------------------------------ 35-44 OpenAI
test('35 · linha válida não usa OpenAI e 36 · linha ambígua pode usar', async () => {
  const parsed = manheim.parseCsv('Year,Make,Model,Odometer Value,MMR\n2022,BMW,X5,70000,45000\n2022,BMW,X5,70k mi,45000');
  const classified = manheim.classifyRows(parsed, manheim.mapHeaders(parsed.headers));
  assert.equal(classified.vehicles.length, 1);
  assert.deepEqual(classified.ambiguous.map((row) => row.ambiguous), [['miles']]);
  let sent = null;
  const env = { MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'sk-test', MANHEIM_OPENAI_MODEL: 'gpt-5.4-nano' };
  const fetchImpl = async (url, options) => { sent = { url, body: JSON.parse(options.body), headers: options.headers }; return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ rows: [{ id: '0', year: 2022, make: 'BMW', model: 'X5', trim: null, miles: 70000, mmr: 45000, confident: true }] }) } }], usage: { prompt_tokens: 300, completion_tokens: 60 } }) }; };
  const rows = manheimAi.sanitizeRows([{ id: '0', cells: classified.ambiguous[0].cells, ambiguous: classified.ambiguous[0].ambiguous }]);
  const answer = await manheimAi.suggestRows(rows, { env, fetchImpl });
  assert.equal(sent.url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(sent.body.model, 'gpt-5.4-nano');
  assert.equal(sent.body.response_format.type, 'json_schema');
  assert.equal(answer.suggestions[0].miles, 70000);
  assert.deepEqual(answer.usage, { inputTokens: 300, outputTokens: 60 });
  // 43 · estimated cost: 300 x 0.20 + 60 x 1.25 per million.
  assert.equal(answer.costUsd, 0.000135);
  await assert.rejects(() => manheimAi.suggestRows(rows, { env: {}, fetchImpl }), (failure) => failure.code === 'OPENAI_NOT_ENABLED');
});

test('37 · a resposta passa pela validação determinística e 38 · resposta inválida vai para revisão', () => {
  const parsed = manheim.parseCsv('Year,Make,Model,Odometer Value,MMR\n2022,BMW,X5,70k mi,45000\n2019 model,BMW,X5,30000,40000');
  const mapping = manheim.mapHeaders(parsed.headers);
  const [milesRow, yearRow] = manheim.classifyRows(parsed, mapping).ambiguous;
  const ok = manheim.applySuggestion(milesRow, { year: 2022, make: 'BMW', model: 'X5', miles: 70000, mmr: 45000, confident: true }, mapping, 'gpt-5.4-nano');
  assert.equal(ok.vehicle.miles, 70000);
  assert.deepEqual([ok.vehicle.ai.provider, ok.vehicle.ai.model, ok.vehicle.ai.result], ['openai', 'gpt-5.4-nano', 'VALIDATED']);
  // A mileage that is not written in the cell is refused.
  assert.equal(manheim.applySuggestion(milesRow, { miles: 17000, confident: true }, mapping).review, 'milhagem não confirmado');
  assert.equal(manheim.applySuggestion(milesRow, { miles: 70000, confident: false }, mapping).review, 'OpenAI não teve certeza');
  assert.equal(manheim.applySuggestion(yearRow, { year: 2021, confident: true }, mapping).review, 'ano não confirmado');
  assert.equal(manheim.applySuggestion(yearRow, { year: 2019, confident: true }, mapping).vehicle.year, 2019);
  assert.equal(manheim.applySuggestion(milesRow, null, mapping).review, 'OpenAI não teve certeza');
});

test('39 · falha da OpenAI não bloqueia as linhas válidas; 40 · nenhuma informação pessoal é enviada', async () => {
  const handler = loadWith('api/panel/actions.js', { '../../panel-server': { ...realServer, requirePanel: panelCtx, jsonBody: async (req) => req.body } });
  const res = response();
  // Off by default (no MANHEIM_OPENAI_ENABLED): answers "unavailable" instead of failing the import.
  const saved = process.env.MANHEIM_OPENAI_ENABLED; delete process.env.MANHEIM_OPENAI_ENABLED;
  await handler({ method: 'POST', headers: {}, body: { action: 'manheim_ai_rows', rows: [{ id: '0', cells: { year: '2022', miles: '70k mi' }, ambiguous: ['miles'] }] } }, res);
  if (saved !== undefined) process.env.MANHEIM_OPENAI_ENABLED = saved;
  assert.deepEqual([res.code, res.payload.available, res.payload.reason], [200, false, 'OPENAI_NOT_ENABLED']);
  const failing = await manheimAi.suggestRows(manheimAi.sanitizeRows([{ id: '0', cells: { year: '2022', model: 'X5', miles: '7k' }, ambiguous: ['miles'] }]), { env: { MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k', MANHEIM_OPENAI_MODEL: 'gpt-6-luna' }, fetchImpl: async () => ({ ok: false, status: 500 }) }).catch((failure) => failure.code);
  assert.equal(failing, 'OPENAI_FAILED');
  // Only the six parser cells leave the server; no name, phone, Ref, VIN, seller or location.
  const row = manheimAi.sanitizeRow({ id: '1', cells: { year: '2022', model: 'X5', miles: '7k', phone: '+13055550000', ref: 'ABC23', name: 'Ana', vin: 'WBA123', location: 'FL' }, ambiguous: ['miles'], phone: '+1305', ref: 'ABC23' });
  assert.deepEqual(Object.keys(row.cells).sort(), ['make', 'miles', 'mmr', 'model', 'trim', 'year']);
  assert.deepEqual(Object.keys(row).sort(), ['ambiguous', 'cells', 'id']);
  let body = '';
  await manheimAi.suggestRows([row], { env: { MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k', MANHEIM_OPENAI_MODEL: 'gpt-6-luna' }, fetchImpl: async (_url, options) => { body = options.body; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"rows":[]}' } }], usage: {} }) }; } });
  for (const secret of ['+1305', 'ABC23', 'Ana', 'WBA123', 'FL']) assert.ok(!body.includes(secret), secret);
  // The key only exists on the server: the browser never references it.
  for (const file of ['painel/painel.js', 'painel/manheim.js', 'painel/manheim-upload.js', 'painel/index.html']) assert.doesNotMatch(read(file), /OPENAI_API_KEY|api\.openai\.com/, file);
  // No Anthropic fallback for this job.
  assert.doesNotMatch(read('panel-manheim-ai.js'), /api\.anthropic\.com|ANTHROPIC_/);
});

test('41 · o resumo registra provider openai e modelo, 42 · quantas linhas usaram IA e 43 · o custo estimado', async () => {
  const summary = manheimAi.sanitizeSummary({ model: 'gpt-5.4-nano', rowsTotal: 1842, rowsDeterministic: 1819, rowsSentToAi: 23, rowsAccepted: 19, rowsReview: 4, inputTokens: 5000, outputTokens: 1200, costUsd: 0.0025, ms: 3100, review: [{ row: 12, file: 'a.csv', reason: 'ano não confirmado', phone: '+1305' }], prompt: 'nunca guardado' });
  assert.deepEqual([summary.provider, summary.model, summary.rowsSentToAi, summary.rowsAccepted, summary.rowsReview, summary.costUsd], ['openai', 'gpt-5.4-nano', 23, 19, 4, 0.0025]);
  assert.equal(summary.prompt, undefined);
  assert.deepEqual(Object.keys(summary.review[0]), ['row', 'file', 'reason']);
  const patched = [], audited = [];
  const handler = loadWith('api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: panelCtx, jsonBody: async (req) => req.body, rows: async () => [{ id: uuid(70), ai_summary_json: null }], patchRows: async (_ctx, table, _filters, payload) => { patched.push({ table, payload }); return []; }, insert: async (_ctx, table, payload) => { audited.push({ table, payload }); return []; } },
    '../../panel-manheim-state': { activeFilter: async () => ({}), undoSupported: async () => true }
  });
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { action: 'manheim_ai_summary', uploadId: uuid(70), summary } }, res);
  assert.equal(res.code, 200);
  assert.equal(patched[0].table, 'manheim_uploads');
  assert.equal(patched[0].payload.ai_summary_json.provider, 'openai');
  assert.deepEqual([audited[0].table, audited[0].payload.action], ['audit_log', 'AI_SUMMARY']);
  const client = read('painel/painel.js');
  // Rows of the CSV and cars are named apart: never "linhas importadas" for cars.
  assert.doesNotMatch(client, /linhas importadas/);
  for (const line of ['linhas lidas do CSV', 'veículos únicos importados', 'linhas duplicadas ou inválidas ignoradas', 'linhas em revisão', 'analisadas pela OpenAI', 'confirmadas', 'Modelo: ', 'Custo estimado: US$', 'Tempo com IA']) assert.match(client, new RegExp(line.replace('$', '\\$')));
  // Without any row sent to the AI, the summary never mentions OpenAI.
  assert.match(client, /if \(usedAi\) \{\s*line\(`\$\{ai\.rowsSentToAi\} analisadas pela OpenAI`\);/);
});

test('44 · nenhum match é criado só pela decisão da IA', async () => {
  const parsed = manheim.parseCsv('Vin,Year,Make,Model,Odometer Value,MMR\nWBAAI1,2022,BMW,X5,120k mi,45000');
  const mapping = manheim.mapHeaders(parsed.headers);
  const [row] = manheim.classifyRows(parsed, mapping).ambiguous;
  const accepted = manheim.applySuggestion(row, { year: 2022, make: 'BMW', model: 'X5', miles: 120000, mmr: 45000, confident: true }, mapping, 'gpt-5.4-nano').vehicle;
  assert.equal(accepted.miles, 120000);
  const [item] = domain.consolidateCalcRuns([carroRow('CBBB3')]);
  const demand = domain.orderDemand(item);
  // The AI normalized the row; the deterministic CARRO rule still says 120.000 > 90.000.
  assert.deepEqual(upload.buildMatches([accepted], targetsOf({ byJourney: new Map(), orders: [demand] }), manheim), []);
  // And the server makes every match itself, with the same rule, from the parsed car (never from a
  // decision sent by the browser or by the AI).
  assert.match(read('api/panel/manheim-batch.js'), /const matches = batch\.matchChunk\(valid, targets, index, \{ staging: true \}\)/);
  assert.match(read('panel-manheim-batch.js'), /vehicleMatch\.matchDemand\(vehicle, \{ \.\.\.target/);
});

test('34 · D1 a D4 do Lote 4 e 45 · os testes anteriores continuam no pacote', () => {
  for (const file of ['tests/lote4.test.js', 'tests/lote4.spec.js', 'tests/lote3.test.js', 'tests/manheim-chunked-upload.test.js']) assert.ok(fs.existsSync(path.join(root, file)), file);
  // groupCalculatorByRef (ENTRADA, CLIENTES, HOJE) keeps its shape; BUSCAS uses per-mode demands.
  assert.doesNotMatch(read('panel-domain.js'), /'MIXED'/);
  assert.match(read('panel-domain.js'), /logicalMode: modes\.length === 1 \? modes\[0\] : null/);
  assert.doesNotMatch(read('panel-buscas.js'), /groupCalculatorByRef\([^)]*\)\.map\(orderDemand/);
  assert.ok(buscas.buildBuscasBase);
});

// ------------------------------------------------------------------ achados da revisão independente
test('revisão 1 · a milhagem da OpenAI tem de ser o número inteiro escrito na célula; km nunca vira milha', () => {
  assert.equal(manheim.supportedNumber(12000, '12k mi'), true);
  assert.equal(manheim.supportedNumber(12, '12k mi'), false);
  assert.equal(manheim.supportedNumber(103500, '103,500 mi (TMU)'), true);
  assert.equal(manheim.supportedNumber(3500, '103,500 mi (TMU)'), false);
  assert.equal(manheim.supportedNumber(45000, '45,000 km'), false);
  assert.equal(manheim.supportedNumber(21500, '$21.5k'), true);
  assert.equal(manheim.supportedNumber(70000, '70000 or 80000'), false, 'dois números: ambíguo');
});

test('revisão 2 · o cabeçalho sugerido nunca reaproveita uma coluna já usada', () => {
  const headers = ['Year', 'Make', 'Model', 'Trim', 'Odo Reading', 'MMR'];
  assert.equal(manheim.mapHeadersWith(headers, { miles: 'MMR' }).fields.miles, undefined);
  assert.deepEqual(manheim.mapHeadersWith(headers, { miles: 'MMR' }).missing, ['miles']);
  assert.equal(manheim.mapHeadersWith(headers, { miles: 'Odo Reading' }).fields.miles, 'Odo Reading');
  assert.equal(manheim.mapHeadersWith(headers, { miles: 'Nope' }).fields.miles, undefined);
});

test('revisão 3 · ficha encerrada não conta como busca ativa nem vai para revisão', async () => {
  const closed = { id: uuid(80), contact_id: uuid(81), reference_code: 'DCCC4', status: 'ENCERRADO', criteria_json: {}, created_at: iso(9), updated_at: iso(9) };
  const review = { id: uuid(82), contact_id: uuid(83), reference_code: null, status: 'ENCERRADO', criteria_json: { wishlists: [{ make: 'BMW', model: 'X5' }] }, created_at: iso(9), updated_at: iso(9) };
  const data = await buscasView({ journeys: [closed, review], contacts: [{ id: uuid(81), display_name: 'Fechada', is_lead: true }, { id: uuid(83), display_name: 'Fechada 2', is_lead: true }],
    calc_runs: [valorRow('DCCC4'), clickRow('DCCC4')], message_journeys: [{ journey_id: uuid(82), message_id: 'm1' }], messages: [{ id: 'm1', direction: 'CUSTOMER', occurred_at_utc: iso(1), source_kind: 'WHATSAPP_WEBHOOK' }], manheim_uploads: [], manheim_matches: [] });
  assert.deepEqual([data.counts.VALOR.demands, data.counts.total.people, data.review.length, data.demands.length], [0, 0, 0, 0]);
});

test('revisão 4 · apresentar um carro pela ficha marca como enviado só o modo da oferta', async () => {
  const journey = { id: uuid(84), reference_code: 'DCCC4', status: 'ATIVO', source: 'CALCULATOR', criteria_json: {}, created_at: iso(10) };
  const tables = { journeys: [journey], calc_runs: [valorRow('DCCC4'), carroRow('DCCC4')], lead_events: [{ journey_id: uuid(84), event_type: 'CAR_PRESENTED', occurred_at: iso(1), detail_json: { logical_mode: 'VALOR' } }],
    units: [{ id: uuid(85), journey_id: uuid(84), status: 'PRESENTED', presented_at: iso(1), details_json: { logical_mode: 'VALOR' } }] };
  const server = { ...realServer, allRows: async (_ctx, table) => tables[table] || [] };
  const stage = loadWith('panel-search-stage.js', { './panel-server': server, './panel-manheim-state': { undoSupported: async () => true } });
  const modes = (await stage.loadSearchStageIndex(ctx)).get(uuid(84)).modes;
  assert.deepEqual([modes.VALOR.stage, modes.CARRO.stage], ['SENT', 'MISSING']);
  assert.match(read('api/panel/lead.js'), /detail_json: \{ vehicle: unit\.vehicle_text, \.\.\.\(presentedMode \? \{ logical_mode: presentedMode \} : \{\}\) \}/);
  // ccb4bfc: a ficha não registra mais à mão ("Registrar que apresentei" saiu); o envio confirmado da V1
  // registra sozinho e marca como enviado só o modo da oferta (origem da V1 ou modo dos carros).
  assert.doesNotMatch(read('painel/lead.js'), /api\('present',/);
  const presentation = read('panel-presentation.js');
  assert.match(presentation, /const modes = origin \? \[origin\] : \[\.\.\.new Set\(matches\.map\(\(match\) => match\.logical_mode\)\.filter\(Boolean\)\)\]/);
  assert.match(presentation, /kind: 'SENT', \.\.\.\(supported && mode \? \{ logical_mode: mode \} : \{\}\)/);
});

test('revisão 5 · o score da ficha usa as demandas da Ref ligada (QUALIFICAÇÃO e HOJE passam as entradas por modo)', () => {
  const { score } = require('../panel-ready');
  const journey = { id: uuid(86), reference_code: 'VAAA2', status: 'ATIVO', criteria_json: { wishlists: [{ make: 'BMW', model: 'X5' }] }, budget_cents: 5000000, phones: [] };
  const simulations = domain.consolidateCalcRuns([valorRow('VAAA2')]);
  const cars = [car({ mmrCents: 4500000 })];
  assert.equal(score({ simulations }, journey, {}, cars).mmr, 4500000);
  assert.equal(score({}, journey, {}, cars).mmr, null, 'sem modo conhecido não há comparação');
  assert.match(read('api/panel/qualification.js'), /simulations:modeItems\.filter\(\(item\)=>ownRefs\.includes\(item\.ref\)\)/);
  assert.match(read('api/panel/today.js'), /score\(\{ \.\.\.item, simulations \}, journey/);
});

test('revisão 6 e 7 · contadores sem duplicar e leitura falha fechada quando o banco responde erro', async () => {
  assert.match(read('painel/painel.js'), /count\('searches', options, \(data\) => optionsPeopleOf\(data\)\)/);
  // One count per person answered by the database (distinct cars, MMR mandatory).
  assert.match(read('api/panel/records.js'), /manheimMatchCount: manheim\.byJourney\.get\(item\.id\) \|\| 0/);
  assert.match(read('supabase/migrations/20261005010000_panel_manheim_lote_unico.sql'), /count\(distinct m\.row_fingerprint\)::integer/);
  const state = loadWith('panel-manheim-state.js', { './panel-server': { rows: async () => { throw Object.assign(new Error('x'), { status: 503 }); } } });
  await assert.rejects(() => state.activeFilter(ctx), (failure) => failure.status === 503);
  const missing = loadWith('panel-manheim-state.js', { './panel-server': { rows: async () => { throw Object.assign(new Error('x'), { status: 400 }); } } });
  assert.deepEqual(await missing.activeFilter(ctx), {});
  const ready = loadWith('panel-manheim-state.js', { './panel-server': { rows: async () => [] } });
  assert.deepEqual(await ready.activeFilter(ctx), { undone_at: 'is.null' });
  assert.match(read('painel/painel.js'), /AI_MAX_ROWS_PER_BATCH = 1000/);
});

test('OpenAI do CSV · cada chamada é registrada no servidor com provedor, modelo, tokens e custo; linha clara não é enviada', async () => {
  const logged = [];
  const handler = loadWith('api/panel/actions.js', { '../../panel-server': { ...realServer, requirePanel: panelCtx, jsonBody: async (req) => req.body, insert: async (_ctx, table, payload) => { logged.push({ table, payload }); return []; } } });
  const saved = { ...process.env };
  Object.assign(process.env, { MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'chave-simulada', MANHEIM_OPENAI_MODEL: 'gpt-6-luna' });
  const realFetch = globalThis.fetch;
  const sent = [];
  const budgetCalls = [];
  // The US$ 50 reservation goes to the database first (panel_openai_budget_hold), then OpenAI.
  const answer = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(body), json: async () => body });
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/rest/v1/rpc/panel_openai_budget_')) { const body = JSON.parse(options.body); budgetCalls.push([String(url).split('/').pop(), body]); return answer(String(url).endsWith('_hold') ? { held: true, id: '6c900000-0000-4000-8000-000000000001' } : { settled: true }); }
    sent.push(JSON.parse(options.body)); return answer({ usage: { prompt_tokens: 300, completion_tokens: 40 }, choices: [{ message: { content: JSON.stringify({ rows: [{ id: '1', year: 2022, make: 'BMW', model: 'X5', trim: null, miles: 45000, mmr: null, confident: true }] }) } }] });
  };
  try {
    const res = response();
    await handler({ method: 'POST', headers: {}, body: { action: 'manheim_ai_rows', rows: [
      { id: '0', cells: { year: '2022', make: 'BMW', model: 'X5', miles: '45000', mmr: '41500' }, ambiguous: ['miles'] },
      { id: '1', cells: { year: '2022', make: 'BMW', model: 'X5', miles: '45k mi', mmr: '41500' }, ambiguous: ['miles'] }
    ] } }, res);
    assert.equal(res.payload.available, true);
    assert.equal(res.payload.model, 'gpt-6-luna');
    // Only the unclear row left the server.
    assert.deepEqual(JSON.parse(sent[0].messages[1].content).rows.map((row) => row.id), ['1']);
    assert.equal(sent[0].response_format.json_schema.strict, true);
    // Reserved before the call (worst case, output capped), paid, then recorded.
    assert.equal(sent[0].max_completion_tokens, 8000);
    assert.deepEqual(budgetCalls.map(([name, body]) => [name, body.p_feature || body.p_status]), [['panel_openai_budget_hold', 'MANHEIM_CSV'], ['panel_openai_budget_settle', 'PAGA'], ['panel_openai_budget_settle', 'REGISTRADA']]);
    assert.ok(budgetCalls[0][1].p_amount > 0);
    const record = logged.find((item) => item.table === 'audit_log');
    assert.deepEqual([record.payload.entity_type, record.payload.action], ['manheim_openai', 'AI_ROWS']);
    assert.deepEqual([record.payload.after_json.provider, record.payload.after_json.model, record.payload.after_json.inputTokens, record.payload.after_json.outputTokens, record.payload.after_json.rowsSent], ['openai', 'gpt-6-luna', 300, 40, 1]);
    assert.ok(record.payload.after_json.costUsd > 0);
    assert.doesNotMatch(JSON.stringify(record.payload), /45k|X5|41500/, 'nenhuma célula no registro');
  } finally {
    globalThis.fetch = realFetch;
    for (const key of ['MANHEIM_OPENAI_ENABLED', 'OPENAI_API_KEY', 'MANHEIM_OPENAI_MODEL']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

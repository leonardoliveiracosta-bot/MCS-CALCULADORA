'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildReturns, buildTodayItems, consolidateCalcRuns, journeyEnabled, matchManheimDemand,
  mergeWishlist, mergeWishlists, reactivationEligible, wishlistForJourney, wishlistsForJourney
} = require('../panel-domain');
const manheim = require('../painel/manheim');
const catalog = require('../vehicle-catalog');
catalog.configureAliases([...JSON.parse(fs.readFileSync(require.resolve('../supabase/migrations/20261021010000_manheim_regras_v32.sql'),'utf8').split('$aliases$')[1]), {make:'BMW',client_model:'330i',target_make:'BMW',manheim_models:['3 Series'],kind:'EQUIVALENT'}, {make:'Lexus',client_model:'RX350',target_make:'Lexus',manheim_models:['RX'],kind:'EQUIVALENT'}],[], 'test-v32');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('supabase/migrations/20260925180602_panel_manheim_match.sql');
const client = read('painel/painel.js');
const server = read('api/panel/actions.js');

test('browser build always publishes the Manheim module on the page global', () => {
  const source = read('painel/manheim.js');
  assert.match(source, /if \(root\) root\.MCSManheim = api/);
});

test('journeys default to enabled and disabled journeys leave HOJE', () => {
  const active = { id: 'a', status: 'ATIVO', stage: 'RESPONDIDO', stage_frozen: false };
  const disabled = { ...active, id: 'b', enabled: false };
  assert.equal(journeyEnabled(active), true);
  assert.equal(journeyEnabled(disabled), false);
  const data = { journeys: [active, disabled], messages: [], checklist: [], promises: [], divergences: [
    { journey_id: 'a', status: 'OPEN', field: 'TETO', created_at: '2026-09-25T10:00:00Z' },
    { journey_id: 'b', status: 'OPEN', field: 'TETO', created_at: '2026-09-25T10:00:00Z' }
  ], units: [], suppressions: [] };
  assert.deepEqual(buildTodayItems(data, new Date('2026-09-25T12:00:00Z')).map((item) => item.id), ['a']);
});

test('toggle migration keeps an exact snapshot, optional reason, logs, and environment isolation', () => {
  assert.match(migration, /resume_snapshot jsonb not null/);
  for (const field of ['stage', 'status', 'stage_frozen', 'qualified_at', 'closed_at', 'closed_reason', 'next_action_at', 'next_action_text', 'next_action_missing_since']) {
    assert.match(migration, new RegExp(`'${field}'`));
    assert.match(migration, new RegExp(`${field} = .*resume_snapshot`, 's'));
  }
  assert.match(migration, /p_reason is not null and p_reason not in/);
  assert.match(migration, /where id = p_journey_id and environment = p_environment/i);
  assert.match(migration, /JOURNEY_DISABLED/);
  assert.match(migration, /insert into public\.activity_log/);
  assert.match(migration, /insert into public\.audit_log/);
});

test('only the requested disabled reasons and Parado are eligible for Reativar', () => {
  assert.equal(reactivationEligible({ enabled: false, offReason: 'GAVE_UP' }), true);
  assert.equal(reactivationEligible({ enabled: false, offReason: 'NO_RESPONSE' }), true);
  assert.equal(reactivationEligible({ enabled: false, offReason: 'MCS_PURCHASE' }), false);
  assert.equal(reactivationEligible({ enabled: false, offReason: null }), false);
  assert.equal(reactivationEligible({ enabled: true, status: 'PARADO' }), true);
});

test('calculator wishlist fills only empty fields', () => {
  const rows = [{ id: '1', created_at: '2026-09-25T10:00:00Z', dados: {
    sid: 'synthetic', ref: 'TST23', evento: 'busca', marca: 'Honda', modelo: 'Civic',
    ano_de: 2020, ano_ate: 2024, milhas_ate: 50000, lance: 20000
  } }, { id: '2', created_at: '2026-09-25T10:01:00Z', dados: {
    sid: 'synthetic', ref: 'TST23', evento: 'busca', marca: 'Toyota', modelo: 'Camry',
    ano_de: 2021, ano_ate: 2025, milhas_ate: 45000
  } }];
  const request = consolidateCalcRuns(rows)[0];
  // A6: inside a Ref the newest request comes first.
  assert.deepEqual(request.wishlist, { make: 'Toyota', model: 'Camry', yearMin: 2021, yearMax: 2025, minMiles: null, maxMiles: 45000, trim: '' });
  const incoming = request.wishlists.find((wish) => wish.model === 'Civic');
  assert.deepEqual(incoming, { make: 'Honda', model: 'Civic', yearMin: 2020, yearMax: 2024, minMiles: null, maxMiles: 50000, trim: '' });
  assert.equal(request.wishlists.length, 2);
  // A6: the year range is one unit. A ficha that already has a year never receives the other
  // year from another source (that mix produced impossible ranges such as 2023-2021).
  assert.deepEqual(mergeWishlist({ make: 'Toyota', yearMin: 2021 }, incoming), {
    make: 'Toyota', model: 'Civic', yearMin: 2021, minMiles: null, maxMiles: 50000
  });
  assert.deepEqual(mergeWishlists([{ make: 'Honda', model: 'Civic', yearMin: 2022 }], request.wishlists), [
    { make: 'Honda', model: 'Civic', yearMin: 2022, yearMax: null, minMiles: null, maxMiles: 50000, trim: '' },
    { make: 'Toyota', model: 'Camry', yearMin: 2021, yearMax: 2025, minMiles: null, maxMiles: 45000, trim: '' }
  ]);
  assert.deepEqual(wishlistForJourney({ criteria_json: { wishlist: incoming } }), incoming);
  assert.equal(wishlistsForJourney({ criteria_json: { wishlists: request.wishlists } }).length, 2);
  assert.equal(mergeWishlists([], [
    { model: 'Rogue' }, { model: 'Rogue Sport' }, { model: 'Civic' }, { model: 'Camry' }, { model: 'GLE' }, { model: 'X5' }
  ]).length, 5);
});

test('CSV mapping accepts the exact real Manheim header without Make and preserves extra fields', () => {
  const header = 'Year,Model,Trim,Odometer Value,Pickup Location,MMR,Exterior Color,Interior Color,Buy Now Price,Condition Report Grade';
  const parsed = manheim.parseCsv(`${header}\r\n2022,Civic,EX,25000,FL - FORT LAUDERDALE,"$18,500",Blue,Black,"$19,900",4.2`);
  const mapping = manheim.mapHeaders(parsed.headers);
  assert.deepEqual(mapping.missing, []);
  const row = manheim.normalizeRows(parsed, mapping)[0];
  assert.deepEqual({ year: row.year, make: row.make, model: row.model, miles: row.miles, mmrCents: row.mmrCents, locationDisplay: row.locationDisplay }, {
    year: 2022, make: 'Honda', model: 'Civic', miles: 25000, mmrCents: 1850000, locationDisplay: 'Fort Lauderdale, FL'
  });
  assert.equal(row.makeInferred, true);
  assert.deepEqual([row.exteriorColor, row.buyNowPrice, row.conditionGrade], ['Blue', '$19,900', '4.2']);
  assert.deepEqual(manheim.mapHeaders(['Year', 'Model']).missing, ['miles']);
  assert.deepEqual(manheim.mapHeaders(['Year', 'Model', 'Mileage Value', 'Location Name']).fields, {
    year: 'Year', model: 'Model', miles: 'Mileage Value', location: 'Location Name'
  });
});

test('unknown or ambiguous model stays comparable by model with a visible Make warning', () => {
  const parsed = manheim.parseCsv('Year,Model,Odometer Value,MMR\n2022,1500,25000,30000');
  const row = manheim.normalizeRows(parsed, manheim.mapHeaders(parsed.headers))[0];
  assert.equal(row.make, '');
  assert.equal(row.makeNotice, 'marca não informada no arquivo');
  assert.equal(catalog.inferMake('1500').ambiguous, true);
  assert.equal(matchManheimDemand({ ...row, lane: '1', run: '1' }, { mode: 'CARRO', wishes: [{ make: 'Ram', model: '1500', yearMin: 2020, yearMax: 2024, minMiles: 1, maxMiles: 50000 }] }).kind, 'BATE');
});

test('model matching is whole-word tolerant and ignores Make plus Class', () => {
  assert.equal(catalog.modelsMatch('GLE-Class', 'GLE', '', 'Mercedes-Benz'), false);
  assert.equal(catalog.modelsMatch('Ram 1500', '1500', '', 'Ram'), true);
  assert.equal(catalog.modelsMatch('3 Series', '3 Series', '', 'BMW'), true);
  assert.equal(catalog.modelsMatch('X50', 'X5', '', 'BMW'), false);
  assert.equal(manheim.matchDemand({ lane: '1', run: '1', year: 2022, make: 'Mercedes-Benz', model: 'GLE', miles: 20000, mmrCents: 5000000 }, { mode: 'CARRO', wishes: [
    { make: 'BMW', model: 'X5', yearMin: 2020, yearMax: 2024, minMiles: 1, maxMiles: 50000 }, { make: 'Mercedes-Benz', model: 'GLE', yearMin: 2020, yearMax: 2024, minMiles: 1, maxMiles: 50000 }
  ] }).matchedWishlistIndex, 1);
  assert.equal(manheim.matchDemand({ lane: '1', run: '1', year: 2022, make: 'BMW', model: 'X50', miles: 20000, mmrCents: 2000000 }, { mode: 'VALOR', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 2000000 }), null);
});

test('BATE (CARRO), POR VALOR and MMR are independent and deterministic', () => {
  const wishes = [{ make: 'Toyota', model: 'Camry', yearMin: 2020, yearMax: 2024, minMiles: 1, maxMiles: 50000 }, { make: 'Honda', model: 'Civic', yearMin: 2020, yearMax: 2024, minMiles: 1, maxMiles: 50000 }];
  const carro = { mode: 'CARRO', wishes, bidCents: 2000000 };
  // CARRO: complete criteria, no money. The bid given here is ignored.
  assert.deepEqual(matchManheimDemand({ lane: '1', run: '1', year: 2022, make: 'HONDA', model: 'Cívic', miles: 45000, mmrCents: 2100000 }, carro), {
    kind: 'BATE', reason: null, notice: null, gaps: [], dataGap: false, basis: 'CRITERIA', budgetFallback: false, bidCents: 2000000, mmrStatus: null, mode: 'CARRO', matchedWishlistIndex: 1, matchedWishlistLabel: 'Honda Civic', makeNotice: ''
  });
  // One year above is not a QUASE anymore: it is simply not a match.
  assert.equal(matchManheimDemand({ lane: '1', run: '1', year: 2025, make: 'Honda', model: 'Civic', miles: 45000, mmrCents: 1900000 }, carro), null);
  assert.equal(matchManheimDemand({ lane: '1', run: '1', year: 2025, make: 'Honda', model: 'Civic', miles: 56000 }, carro), null);
  assert.equal(matchManheimDemand({ lane: '1', run: '1', year: 2022, make: 'Honda', model: 'Accord', miles: 45000 }, carro), null);
  // VALOR: the MMR against the bid, year and mileage never used.
  const valor = { mode: 'VALOR', wishes: [{ make: 'Honda', model: 'Civic', yearMin: 2023, yearMax: 2023 }], bidCents: 2000000 };
  const result = matchManheimDemand({ lane: '1', run: '1', year: 2015, make: 'Honda', model: 'Civic', miles: 100000, mmrCents: 1900000 }, valor);
  assert.deepEqual([result.kind, result.mmrStatus, result.mode], ['POR_VALOR', 'MMR dentro do teto', 'VALOR']);
});

test('shortlist preserves CSV columns and escaping', () => {
  const headers = ['Year','Model','Trim','Odometer Value','Pickup Location','MMR','Exterior Color','Interior Color','Buy Now Price','Condition Report Grade'];
  const csv = manheim.toCsv(headers, [{ Year: '2022', Model: 'Civic, EX', 'Pickup Location': 'FL - FORT LAUDERDALE' }]);
  assert.equal(csv.split('\r\n')[0], '\uFEFF' + headers.join(','));
  assert.match(csv, /2022,"Civic, EX"/);
});

test('returns are unified and HOJE colors overdue and next-two-hour deadlines', () => {
  const now = new Date('2026-09-25T12:00:00Z');
  const journey = { id: 'j', status: 'ATIVO', stage: 'RESPONDIDO', next_action_text: 'Retornar', next_action_at: '2026-09-25T13:30:00Z' };
  const promises = [{ id: 'p', journey_id: 'j', status: 'OPEN', promise_text: 'Enviar opções', due_at: '2026-09-25T11:00:00Z' }];
  assert.deepEqual(buildReturns(journey, promises).map((item) => item.origin), ['Mensagem', 'Manual']);
  const item = buildTodayItems({ journeys: [journey], messages: [], checklist: [], promises, divergences: [], units: [], suppressions: [] }, now)[0];
  assert.deepEqual(item.reasons.map((reason) => [reason.kind, reason.urgency]), [['NEXT_ACTION', 'yellow'], ['PROMISE', 'red']]);
});

test('UI and server wire structured wishlist, grouping, presenting, Reativar, and no start-search button', () => {
  assert.match(client, /const wishlists = wishlistRows/);
  assert.match(client, /journey\.wishlists \|\| journey\.wishlist/);
  assert.match(read('painel/index.html'), /Compatíveis/);
  assert.match(client, /Reativar/);
  assert.match(client, /Apresentei ao cliente/);
  assert.match(client, /Baixar PDF/);
  assert.match(client, /const vehicle = match\.vehicle_json\.parsed/);
  assert.match(client, /Cor externa:/);
  assert.match(client, /Nota de condição:/);
  assert.match(client, /function showManheimFailure/);
  assert.match(client, /MANHEIM_FILE_READ_FAILED/);
  assert.match(client, /A comparação foi lida, mas não pôde ser gravada/);
  assert.doesNotMatch(client, /INICIAR BUSCA/);
  assert.match(server, /manheimMatchId/);
  assert.match(server, /JOURNEY_ALREADY_DISABLED/);
  assert.match(server, /environment: 'eq\.' \+ ctx\.environment/);
});

test('new Manheim tables force RLS and allow no direct writes from browser roles', () => {
  for (const table of ['journey_toggle_states', 'manheim_uploads', 'manheim_matches']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`, 'i'));
  }
  assert.match(migration, /revoke all on table[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant select on table[\s\S]*to authenticated/i);
  for (const line of migration.split(/\r?\n/)) assert.doesNotMatch(line, /grant (?:insert|update|delete|all).*to (?:anon|authenticated)/i);
});

test('saved searches reuse the contact index and expose cumulative versus individual explanations', () => {
  const searches=read('api/panel/manheim-searches.js');
  assert.match(read('panel-buscas.js'),/const \{ contactIndex \} = require/);
  assert.match(searches,/!base\.journeyEntered\(journey\)/);
  assert.match(searches,/!base\.orderEntered\(demand\.ref\)/);
  assert.match(searches,/individualPercent/);
  assert.match(searches,/clients: \[\.\.\.group\.leads\.values\(\)\]/);
  assert.match(client,/Conta só quem entrou em contato/);
  assert.match(client,/Salvando da #1 até esta/);
  assert.match(client,/Esta busca sozinha atende/);
  assert.match(client,/group\.leads===1\?'cliente quer':'clientes querem'/);
});

test('saved search actions are optimistic, sortable, and let the owner open each client lead', () => {
  const searches=read('api/panel/manheim-searches.js');
  assert.match(client,/mode==='vehicle'/);
  assert.match(client,/mode==='recent'/);
  assert.match(client,/group\.created=!before/);
  assert.match(client,/group\.created=before/);
  assert.match(client,/openDetail\('ficha',client\.journeyId\)/);
  assert.match(read('panel-buscas.js'),/phone: journey \? base\.primaryPhone\(journey\.contact_id\)/);
});

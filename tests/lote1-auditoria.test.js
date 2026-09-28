'use strict';

// Lote 1 da auditoria (AUDITORIA-PAINEL-MCS.md): R1, R2, R3, C1-C5, A1, A3-A6, A14, A19, A20.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vehicleMatch = require('../vehicle-match');
const money = require('../money-text');
const manheim = require('../painel/manheim');
const upload = require('../painel/manheim-upload');
const parser = require('../painel/parser');
const domain = require('../panel-domain');
const realServer = require('../panel-server');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ACTOR = '50000000-0000-4000-8000-000000000001';
const uuid = (n) => `51000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function loadWith(relative, mocks) {
  const file = path.join(root, relative), mod = { exports: {} };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  return mod.exports;
}
const response = () => ({ code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.payload = value; return value; } });
const panelCtx = async () => ({ config: { url: 'https://example.test', secretKey: 'test' }, panel: { id: ACTOR }, environment: 'preview' });
const car = (overrides) => ({ year: 2020, make: 'BMW', model: 'X5', miles: 40000, mmrCents: null, ...overrides });

// ---------------------------------------------------------------- R3: faixa de MMR
test('R3b: faixa de MMR do lance (US$ 20.000, 60.000 e 80.000), bordas inclusivas', () => {
  const wish = [{ make: 'BMW', model: 'X5' }];
  const kind = (bidUsd, mmrUsd) => vehicleMatch.matchVehicle(car({ mmrCents: mmrUsd * 100 }), wish, bidUsd * 100)?.kind || null;
  assert.equal(kind(20000, 14000), 'BATE');
  assert.equal(kind(20000, 23000), 'BATE');
  assert.equal(kind(20000, 13999), null);
  assert.equal(kind(20000, 23001), null);
  assert.equal(kind(60000, 42000), 'BATE');
  assert.equal(kind(60000, 69000), 'BATE');
  assert.equal(kind(60000, 41999), null);
  assert.equal(kind(60000, 69001), null);
  assert.equal(kind(80000, 60000), 'BATE');
  assert.equal(kind(80000, 88000), 'BATE');
  assert.equal(kind(80000, 59999), null);
  assert.equal(kind(80000, 88001), null);
  const byValue = vehicleMatch.matchVehicle(car({ mmrCents: 2000000 }), wish, 2000000);
  assert.equal(byValue.reason, 'por valor: MMR US$ 20,000 na faixa do lance US$ 20,000');
  assert.equal(byValue.basis, 'VALUE');
  assert.equal(byValue.dataGap, false);
});

test('R3c/d: sem MMR → QUASE "sem MMR para comparar"; sem lance → QUASE "precisa qualificar"', () => {
  const wish = [{ make: 'BMW', model: 'X5' }];
  const noMmr = vehicleMatch.matchVehicle(car({ mmrCents: null }), wish, 2000000);
  assert.deepEqual([noMmr.kind, noMmr.notice, noMmr.dataGap], ['QUASE', 'sem MMR para comparar', true]);
  const noBid = vehicleMatch.matchVehicle(car({ mmrCents: 2000000 }), wish, null);
  assert.deepEqual([noBid.kind, noBid.notice, noBid.dataGap], ['QUASE', 'precisa qualificar: ano/milhagem não informados', true]);
  // Nothing informed never becomes BATE, whatever the car (the old rule said BATE for a 2004 with 240k).
  assert.notEqual(vehicleMatch.matchVehicle(car({ year: 2004, miles: 240000, mmrCents: 500000 }), wish, null)?.kind, 'BATE');
  // Total ceiling is never turned into a bid (R3d): only budget/bid enters the rule.
  assert.equal(vehicleMatch.matchVehicle(car({ mmrCents: 2000000 }), wish, 0).notice, 'precisa qualificar: ano/milhagem não informados');
});

test('R3a: critérios informados são usados; ano informado sem milhagem usa ano + faixa de MMR', () => {
  const full = [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2021, maxMiles: 50000 }];
  assert.equal(vehicleMatch.matchVehicle(car({ year: 2020, miles: 40000 }), full, null).kind, 'BATE');
  assert.equal(vehicleMatch.matchVehicle(car({ year: 2015, miles: 40000 }), full, null), null);
  const yearOnly = [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2021 }];
  assert.equal(vehicleMatch.matchVehicle(car({ year: 2020, mmrCents: 3000000 }), yearOnly, 3000000).kind, 'BATE');
  assert.equal(vehicleMatch.matchVehicle(car({ year: 2020, mmrCents: 9000000 }), yearOnly, 3000000), null);
  assert.equal(vehicleMatch.matchVehicle(car({ year: 2010, mmrCents: 3000000 }), yearOnly, 3000000), null);
});

// ---------------------------------------------------------------- R3e: odômetro
test('R3e: odômetro vazio, "TMU" ou "Exempt" é desconhecido, nunca 0, e nunca BATE por milhagem', () => {
  const csv = 'Year,Make,Model,Odometer Value,MMR\n2020,BMW,X5,,40000\n2020,BMW,X5,TMU,40000\n2020,BMW,X5,Exempt,40000\n2020,BMW,X5,30000,40000';
  const parsed = manheim.parseCsv(csv);
  const rows = manheim.normalizeRows(parsed, manheim.mapHeaders(parsed.headers));
  assert.deepEqual(rows.map((row) => row.miles), [null, null, null, 30000]);
  const wish = [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2021, maxMiles: 50000 }];
  for (const row of rows.slice(0, 3)) {
    const result = manheim.matchVehicle(row, wish, 4000000);
    assert.equal(result.kind, 'QUASE');
    assert.equal(result.notice, 'milhagem não informada no leilão');
    assert.equal(result.dataGap, true);
  }
  assert.equal(manheim.matchVehicle(rows[3], wish, 4000000).kind, 'BATE');
});

// ---------------------------------------------------------------- A6: busca + simulação na mesma Ref
test('A6: Ref com busca e simulação combina ano/milhagem da busca com o lance da simulação', () => {
  const rows = [
    { id: '1', created_at: '2026-09-20T10:00:00Z', dados: { sid: 's1', ref: 'ABC23', evento: 'simulacao', marca: 'BMW', modelo: 'X5', lance: 30000 } },
    { id: '2', created_at: '2026-09-21T10:00:00Z', dados: { sid: 's2-find-x', ref: 'ABC23', evento: 'busca', marca: 'BMW', modelo: 'X5', ano_de: 2021, ano_ate: 2023, milhas_de: 5000, milhas_ate: 40000 } }
  ];
  const order = domain.groupCalculatorByRef(domain.consolidateCalcRuns(rows), [])[0];
  assert.equal(order.budgetCents, 3000000);
  assert.deepEqual(order.wishlists, [{ make: 'BMW', model: 'X5', yearMin: 2021, yearMax: 2023, maxMiles: 40000 }]);
  // The old per-simulation rule let the simulation (no years) accept this 2008 with 240k miles.
  assert.equal(domain.matchManheimOrder(car({ year: 2008, miles: 240000, mmrCents: 2500000 }), order), null);
  assert.equal(domain.matchManheimOrder(car({ year: 2022, miles: 30000, mmrCents: 2500000 }), order).kind, 'BATE');
  // The newest value of each field wins and a year range never mixes two sources.
  const newer = [...rows, { id: '3', created_at: '2026-09-22T10:00:00Z', dados: { sid: 's2-find-x', ref: 'ABC23', evento: 'busca', marca: 'BMW', modelo: 'X5', ano_de: 2017, ano_ate: 2019, milhas_de: 5000, milhas_ate: 80000 } }];
  const latest = domain.groupCalculatorByRef(domain.consolidateCalcRuns(newer), [])[0];
  assert.deepEqual(latest.wishlists[0], { make: 'BMW', model: 'X5', yearMin: 2017, yearMax: 2019, maxMiles: 80000 });
  assert.equal(latest.yearsText, '2017–2019');
});

// ---------------------------------------------------------------- R1 / R2
test('R1: a ficha vence a calculadora; diferença aparece como "nova informação", sem alterar a ficha', () => {
  const journey = { id: uuid(1), budget_cents: 3000000, payment_text: 'cash', vehicle_text: 'BMW X5', criteria_json: { wishlists: [{ make: 'Audi', model: 'Q5', yearMin: 2020, yearMax: 2022, maxMiles: 40000 }], wishlistOverride: true } };
  const order = { budgetCents: 5000000, paymentText: 'fin', vehicleText: 'BMW X5', contactName: 'Outro Nome', wishlists: [{ make: 'BMW', model: 'X5' }] };
  const before = JSON.stringify(journey);
  const criteria = domain.effectiveCriteria(journey, order);
  assert.equal(criteria.bidCents, 3000000);
  assert.equal(criteria.bidSource, 'FICHA');
  assert.deepEqual(criteria.wishes.map((wish) => wish.model), ['Q5']);
  const news = domain.calculatorNews(journey, 'Cliente Real', order);
  assert.deepEqual(news.map((item) => item.field), ['LANCE', 'PAGAMENTO', 'NOME']);
  assert.equal(JSON.stringify(journey), before, 'a ficha não é alterada');
  // Without data in the ficha the calculator fills the gap (evidence), still without writing.
  assert.equal(domain.effectiveCriteria({ id: uuid(2), criteria_json: {} }, order).bidCents, 5000000);
  const lead = read('panel-lead.js');
  assert.match(lead, /const maxBidCents = criteria\.bidCents;/);
  assert.doesNotMatch(lead, /order && order\.budgetCents \|\| record && record\.budget_cents/);
});

test('R2: teto total nunca vira lance nem o contrário em nenhuma tela', () => {
  const actions = read('api/panel/actions.js');
  const panel = read('painel/painel.js');
  const lead = read('panel-lead.js');
  const sql = read('supabase/migrations/20260929033000_panel_mark_message_ceiling.sql');
  // Teto marked on a message goes only to confirmed_total_ceiling_cents.
  assert.doesNotMatch(actions, /patch\.budget_cents = Math\.round\(amount \* 100\)/);
  assert.doesNotMatch(actions, /valueJson\.cents = /);
  assert.match(sql, /confirmed_total_ceiling_cents = case/);
  assert.doesNotMatch(sql, /budget_cents = case/);
  // The calculator bid is not recorded as a TETO declaration.
  assert.doesNotMatch(actions, /field: 'TETO', value: String\(request\.budgetCents\)/);
  // Labels: budget_cents is shown as bid, never as "teto".
  assert.doesNotMatch(panel, /· teto \$\{formatMoney\(budgetCents\)\}/);
  assert.doesNotMatch(panel, /'Teto único'/);
  // Offers use the maximum bid, not the bid derived from the total ceiling.
  assert.match(lead, /vehicleMatch\.matchVehicle\(vehicle, wishes, maxBidCents\)/);
  // Sorting by value uses the bid only.
  assert.doesNotMatch(read('panel-sort.js'), /confirmed_total_ceiling_cents\|\|/);
  assert.equal(vehicleMatch.mmrStatusLabel('MMR acima do teto'), 'MMR acima do lance');
});

// ---------------------------------------------------------------- C3: Teto
test('C3: parser do teto entende todos os formatos e ignora texto sem número', () => {
  const cases = { '35k': 3500000, '35,000': 3500000, 'US$ 35.000': 3500000, 'R$ 35.000,00': 3500000, '25,000 to 30,000': 3000000,
    'I can spend 35k total': 3500000, 'under 60,000 miles, budget 35k': 3500000, 'my budget is 20000 total, 2019 or newer': 2000000,
    ok: null, 'sem número': null, 'teto 2020': null, '': null };
  for (const [text, cents] of Object.entries(cases)) assert.equal(money.parseMoneyCents(text), cents, text);
  assert.equal(money.formatUsd(3500000), 'US$ 35.000');
});

test('C3: marcar Teto grava só confirmed_total_ceiling_cents, recusa texto sem número e lead encerrado', async () => {
  let rpcBody = null;
  const message = { id: uuid(9), chat_id: uuid(8), body_text: 'my budget is 40k', direction: 'CUSTOMER' };
  const makeHandler = (status) => loadWith('api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: panelCtx,
      rows: async (_ctx, table) => table === 'messages' || table === 'message_journeys' ? [{ ...message, message_id: message.id, journey_id: uuid(1) }] : [],
      supabase: async (_u, _k, requestPath, options) => { if (requestPath.includes('panel_mark_message_fact')) rpcBody = JSON.parse(options.body); return { marked: true }; },
      insert: async () => [{ id: uuid(7) }], patchRows: async () => [] },
    '../../panel-read-model': { ...require('../panel-read-model'), journeyExists: async () => ({ id: uuid(1), contact_id: uuid(2), status, stage: 'NOVO' }), messageForJourney: async () => message }
  });
  const call = async (status, value) => { const res = response(); await makeHandler(status)({ method: 'POST', headers: {}, body: { action: 'mark_message', journeyId: uuid(1), messageId: message.id, kind: 'BUDGET', value } }, res); return res; };
  const ok = await call('ATIVO', 'I can spend 35k total');
  assert.equal(ok.code, 200, JSON.stringify(ok.payload));
  assert.deepEqual(rpcBody.p_value_json, { ceilingCents: 3500000 });
  assert.equal(ok.payload.ceilingCents, 3500000);
  rpcBody = null;
  const empty = await call('ATIVO', 'ok');
  assert.deepEqual([empty.code, empty.payload.error, rpcBody], [400, 'CEILING_VALUE_INVALID', null]);
  rpcBody = null;
  const noValue = await call('ATIVO', undefined);
  assert.deepEqual([noValue.code, noValue.payload.error, rpcBody], [400, 'CEILING_VALUE_INVALID', null], 'sem valor digitado não usa o texto da mensagem');
  const closed = await call('ENCERRADO', '35k');
  assert.deepEqual([closed.code, closed.payload.error, rpcBody], [409, 'JOURNEY_CLOSED', null]);
  // The field opens empty and asks for confirmation before saving.
  const panel = read('painel/painel.js');
  assert.match(panel, /Confirmar teto total: \$\{MCSMoneyText\.formatUsd\(ceilingCents\)\}\?/);
  assert.doesNotMatch(panel, /\['BUDGET', 'Teto', true\]/);
});

// ---------------------------------------------------------------- C4: ZIP de iPhone
test('C4: dois _chat.txt de clientes diferentes nunca se juntam automaticamente', () => {
  const first = parser.parseWhatsApp('[25/09/2026, 14:30] Operador MCS: Olá\n[25/09/2026, 14:31] Ana: Oi', '_chat.txt', {});
  const second = parser.parseWhatsApp('[26/09/2026, 10:00] Operador MCS: Olá\n[26/09/2026, 10:01] Bruno: Oi', '_chat.txt', {});
  const aliases = [{ chat_id: 'chat-ana', alias_text: '_chat' }];
  const chats = [{ id: 'chat-ana', contact_id: 'contact-ana', is_group: false }];
  const senders = [{ chat_id: 'chat-ana', sender_text: 'Operador MCS', direction: 'MCS' }, { chat_id: 'chat-ana', sender_text: 'Ana', direction: 'CUSTOMER' }];
  assert.equal(parser.automaticImportMatch(second, aliases, chats, senders), null);
  assert.equal(parser.automaticImportMatch(first, aliases, chats, senders), null, 'nem o próprio cliente entra só pelo nome genérico');
  for (const title of ['_chat', '_chat.txt', 'WhatsApp Chat', 'chat', 'Conversa do WhatsApp']) assert.equal(parser.isGenericTitle(title), true, title);
  assert.equal(parser.isGenericTitle('WhatsApp Chat with Ana'), false);
  assert.equal(parser.contactNameFromTitle('_chat'), '');
  // A strong identifier (specific title + known customer participant) still imports automatically.
  const named = parser.parseWhatsApp('[25/09/2026, 14:30] Operador MCS: Olá\n[25/09/2026, 14:31] Ana: Oi', 'WhatsApp Chat with Ana.txt', {});
  assert.equal(parser.automaticImportMatch(named, [{ chat_id: 'chat-ana', alias_text: 'WhatsApp Chat with Ana' }], chats, senders).chat.id, 'chat-ana');
  const migration = read('supabase/migrations/20260929031000_chat_alias_generic_cleanup.sql');
  assert.match(migration, /delete from public\.chat_aliases/);
  assert.match(read('api/panel/entry.js'), /if \(!alias \|\| isGenericTitle\(alias\)\) return;/);
});

// ---------------------------------------------------------------- A5
test('A5: ficha encerrada continua encerrada com o interruptor ligado; desligar não reescreve o motivo', async () => {
  assert.equal(domain.journeyEnabled({ status: 'ENCERRADO', enabled: true }), false);
  assert.equal(domain.toggleEnabled('ENCERRADO', { enabled: true }), false);
  assert.equal(domain.toggleEnabled('ATIVO', { enabled: false }), false);
  assert.equal(domain.toggleEnabled('ATIVO', null), true);
  let rpcCalled = false;
  const handler = loadWith('api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: panelCtx, supabase: async () => { rpcCalled = true; return {}; } },
    '../../panel-read-model': { ...require('../panel-read-model'), journeyExists: async () => ({ id: uuid(1), status: 'ENCERRADO', enabled: domain.toggleEnabled('ENCERRADO', { enabled: true }), closed_reason: 'CLIENT_OK' }) }
  });
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { action: 'toggle_journey', journeyId: uuid(1), enabled: false, reason: 'GAVE_UP' } }, res);
  assert.deepEqual([res.code, res.payload.error, rpcCalled], [409, 'JOURNEY_ALREADY_DISABLED', false]);
  const sql = read('supabase/migrations/20260929032000_panel_manheim_closed_and_gap_count.sql');
  assert.equal((sql.match(/\(j\.status <> 'ENCERRADO' and coalesce\(ts\.enabled, true\)\)/g) || []).length, 2);
});

// ---------------------------------------------------------------- A4 no CSV
test('A4: Ref ligada a uma ficha casa só pela ficha (uma pessoa, um alvo)', () => {
  const journey = { id: uuid(1), enabled: true, status: 'ATIVO', matchWishes: [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2022, maxMiles: 60000 }], matchBidCents: 3000000 };
  const linkedOrder = { ref: 'ABC23', journeyId: uuid(1), matchTarget: false, wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2022, maxMiles: 60000 }], budgetCents: 3000000 };
  const freeOrder = { ref: 'XYZ23', matchTarget: true, wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2022, maxMiles: 60000 }], budgetCents: 3000000 };
  const vehicles = [{ ...car({ year: 2020, miles: 30000, mmrCents: 3000000 }), headers: ['Year'], raw: { Year: '2020' }, vin: 'VIN1' }];
  const matches = upload.buildMatches(vehicles, [journey], [linkedOrder, freeOrder], manheim);
  assert.deepEqual(matches.map((match) => match.journeyId || match.calcRef), [uuid(1), 'XYZ23']);
});

// ---------------------------------------------------------------- A19 no servidor
test('A19: combinação que deixou de valer é descartada e contada, sem derrubar o envio', async () => {
  const stored = [];
  const journeys = [
    { id: uuid(1), status: 'ATIVO', stage: 'NOVO', reference_code: null, criteria_json: { wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2022, maxMiles: 60000 }] }, budget_cents: null },
    // Criteria changed after the browser loaded them: now wants an Audi.
    { id: uuid(2), status: 'ATIVO', stage: 'NOVO', reference_code: null, criteria_json: { wishlists: [{ make: 'Audi', model: 'Q5', yearMin: 2019, yearMax: 2022, maxMiles: 60000 }] }, budget_cents: null },
    { id: uuid(3), status: 'ENCERRADO', stage: 'NOVO', reference_code: null, criteria_json: { wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2022, maxMiles: 60000 }] }, budget_cents: null }
  ];
  const handler = loadWith('api/panel/actions.js', { '../../panel-server': { ...realServer, requirePanel: panelCtx,
    allRows: async (_ctx, table) => table === 'journeys' ? journeys : [],
    supabase: async (_u, _k, _p, options) => { stored.push(...JSON.parse(options.body).p_matches); return { uploadId: uuid(99), matchedVehicleCount: stored.length, leadCount: 1 }; } } });
  const vehicle = { headers: ['Year', 'Model'], raw: { Year: '2020', Model: 'X5' }, parsed: { year: 2020, make: 'BMW', model: 'X5', miles: 30000, vin: 'VIN1' } };
  const body = { action: 'manheim_upload_part', uploadId: null, partIndex: 1, partCount: 1, sourceFileCount: 1, vehicleCount: 1, headers: [['Year', 'Model']], headerMap: {},
    matches: [1, 2, 3].map((n) => ({ journeyId: uuid(n), kind: 'BATE', fingerprint: 'vin:VIN1', vehicle })) };
  const res = response();
  await handler({ method: 'POST', headers: {}, body }, res);
  assert.equal(res.code, 201, JSON.stringify(res.payload));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].journeyId, uuid(1));
  assert.deepEqual(res.payload.discarded, { total: 2, reasons: { CRITERIA_CHANGED: 1, JOURNEY_DISABLED: 1 } });
  // The browser always reads fresh criteria at the start of each import.
  assert.match(read('painel/painel.js'), /const fresh = await request\('\/api\/panel\/records\?view=manheim'\);/);
});

// ---------------------------------------------------------------- C2: Quais buscas salvar
test('C2: "Quais buscas salvar" não inventa faixa e deixa "precisa qualificar" fora do %', async () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
  const busca = (id, ref, extra) => ({ id, created_at: iso(10), dados: { sid: ref + '-find-x', ref, evento: 'busca', canal: 'sms', marca: 'BMW', modelo: 'X5', milhas_de: 1000, ...extra } });
  const calcRuns = [
    busca('1', 'AAAA2', { ano_de: 2019, ano_ate: 2022, milhas_ate: 60000 }),
    busca('2', 'CCCC4', { ano_ate: 2015, milhas_ate: 90000 }),
    busca('3', 'DDDD5', { ano_de: 2020, milhas_ate: 50000 }),
    { id: '4', created_at: iso(9), dados: { sid: 's-b', ref: 'BBBB3', evento: 'simulacao', marca: 'BMW', modelo: 'X5', lance: 40000 } },
    { id: '5', created_at: iso(8), dados: { sid: 's-b', ref: 'BBBB3', evento: 'sms' } },
    busca('6', 'EEEE6', { ano_de: 2019, ano_ate: 2022, milhas_ate: 60000 })
  ];
  const journeys = [
    // No year, no mileage, no bid: needs qualifying.
    { id: uuid(1), contact_id: uuid(11), reference_code: null, status: 'ATIVO', criteria_json: { wishlists: [{ make: 'BMW', model: 'X5' }] }, budget_cents: null, created_at: iso(5), updated_at: iso(5) },
    // Linked to EEEE6 (a BMW X5 search) but the confirmed wish is now an Audi Q5 (A3 + A4).
    { id: uuid(2), contact_id: uuid(12), reference_code: null, status: 'ATIVO', criteria_json: { wishlists: [{ make: 'Audi', model: 'Q5', yearMin: 2020, yearMax: 2023, maxMiles: 40000 }], wishlistOverride: true }, budget_cents: null, created_at: iso(5), updated_at: iso(5) }
  ];
  const messages = [{ id: 'm1', direction: 'CUSTOMER', occurred_at_utc: iso(2), source_kind: 'WHATSAPP_WEBHOOK' }, { id: 'm2', direction: 'CUSTOMER', occurred_at_utc: iso(2), source_kind: 'WHATSAPP_WEBHOOK' }];
  const tables = { journeys, contacts: [{ id: uuid(11), display_name: 'Qualificar', is_lead: true }, { id: uuid(12), display_name: 'Troca', is_lead: true }], contact_phones: [], journey_toggle_states: [],
    manheim_saved_searches: [], journey_refs: [{ journey_id: uuid(2), ref_code: 'EEEE6' }], calc_runs: calcRuns,
    message_journeys: [{ journey_id: uuid(1), message_id: 'm1' }, { journey_id: uuid(2), message_id: 'm2' }], messages };
  const handler = loadWith('api/panel/manheim-searches.js', {
    '../../panel-server': { ...realServer, requirePanel: panelCtx, allRows: async (_ctx, table) => tables[table] || [] },
    '../../panel-lead': { orders: async () => domain.groupCalculatorByRef(domain.consolidateCalcRuns(calcRuns), []) }
  });
  const res = response();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  const groups = res.payload.groups;
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));
  assert.ok(groups.every((group) => group.milesMax !== 100000), 'nenhuma milhagem inventada');
  const criteria = byKey['bmw|x5'];
  assert.deepEqual(criteria.clients.map((client) => client.ref).sort(), ['AAAA2', 'CCCC4', 'DDDD5']);
  // "<=2015" and ">=2020" keep the range open on both sides: it covers every customer.
  assert.deepEqual([criteria.yearFrom, criteria.yearTo, criteria.milesMax], [null, null, 90000]);
  const value = byKey['bmw|x5|valor'];
  assert.deepEqual([value.leads, value.mmrMinCents, value.mmrMaxCents], [1, 2800000, 4600000]);
  const qualify = byKey['bmw|x5|qualificar'];
  assert.deepEqual([qualify.leads, qualify.percent, qualify.needsQualify], [1, null, true]);
  // % counts only criteria + value customers: AAAA2, CCCC4, DDDD5, BBBB3 and the Q5 ficha.
  assert.equal(res.payload.activeLeads, 5);
  assert.equal(res.payload.needsQualifyLeads, 1);
  const q5 = byKey['audi|q5'];
  assert.equal(q5.leads, 1);
  assert.ok(!criteria.clients.some((client) => client.journeyId === uuid(2)), 'a ficha que trocou para Q5 não conta como X5');
  const total = groups.filter((group) => !group.needsQualify).at(-1);
  assert.equal(total.percent, 100);
});

// ---------------------------------------------------------------- C5 / A24 / A14 / A20 (estáticos; Playwright cobre o fluxo)
test('C5/A24/A14/A20: sessão, atualização automática, await e responder pelo painel', () => {
  const panel = read('painel/painel.js');
  const routeSession = panel.slice(panel.indexOf('async function routeSession()'), panel.indexOf('function bootWarning()'));
  assert.match(panel, /Promise\.allSettled\(\[/);
  assert.match(panel, /const setCountUnknown = /);
  assert.equal((routeSession.match(/clearSession\(\)/g) || []).length, 1, 'só a checagem de sessão pode deslogar');
  assert.match(routeSession, /\['AUTHENTICATION_REQUIRED', 'PANEL_ACCESS_DENIED'\]\.includes/);
  assert.doesNotMatch(panel, /catch \(_\) \{ clearInterval\(refreshTimer\); \}/);
  assert.match(panel, /if \(operatorIsTyping\(\)\) return;/);
  const actions = read('api/panel/actions.js');
  assert.doesNotMatch(actions.slice(actions.indexOf('module.exports = async')), /return action[A-Za-z]+\(/);
  const entry = read('api/panel/entry.js');
  assert.doesNotMatch(entry.slice(entry.indexOf("if (req.method === 'GET') return")), /return (queue|createJob|createReview|receiveBatch|finishJob|resolveChat|applyReviewAction|undoReviewAction)\(/);
  assert.match(read('painel/lead.js'), /if\(journeyId&&replyComposer\)replyComposer\(conversation,journeyId,reload\);/);
  assert.match(panel, /if \(!state \|\| !state\.allowed \|\| !\(Date\.parse\(state\.openUntil\) > Date\.now\(\)\)\) \{/);
});

test('migração de limites da calculadora é restritiva, aditiva e aceita o formato do site', () => {
  const sql = read('supabase/migrations/20260929030000_calc_runs_insert_limits.sql');
  assert.match(sql, /as restrictive/);
  assert.match(sql, /for insert/);
  assert.match(sql, /\^\[A-HJ-NP-Z2-9\]\{5\}\$/);
  assert.doesNotMatch(sql, /drop policy|alter policy/i);
  // The Ref alphabet of msc-calculadora.html is the one the policy accepts.
  const site = read('msc-calculadora.html');
  assert.match(site, /var A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"/);
  for (const event of ['simulacao', 'busca']) assert.match(sql, new RegExp(`'${event}'`));
});

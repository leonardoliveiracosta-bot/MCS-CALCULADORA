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
const panelCtx = async () => ({ modelAliasesLoaded: true, config: { url: 'https://example.test', secretKey: 'test' }, panel: { id: ACTOR }, environment: 'preview' });
const car = (overrides) => ({ lane: '1', run: '1', year: 2020, make: 'BMW', model: 'X5', miles: 40000, mmrCents: 3000000, ...overrides });

// ---------------------------------------------------------------- R3: faixa de MMR (modo VALOR)
// buscas-split: VALOR (Calculate My Cost) usa só marca, modelo e lance; CARRO (Find One For Me)
// só marca, modelo, anos e milhagens. As regras antigas que misturavam os dois foram trocadas.
const valor = (vehicle, bidCents) => vehicleMatch.matchDemand(vehicle, { mode: 'VALOR', wishes: [{ make: 'BMW', model: 'X5' }], bidCents });
const carro = (vehicle, wish) => vehicleMatch.matchDemand(vehicle, { mode: 'CARRO', wishes: [{ make: 'BMW', model: 'X5', ...wish }] });
test('R3b: faixa de MMR do lance (US$ 20.000, 60.000 e 80.000), bordas inclusivas', () => {
  const kind = (bidUsd, mmrUsd) => valor(car({ mmrCents: mmrUsd * 100 }), bidUsd * 100)?.kind || null;
  assert.equal(kind(20000, 14000), 'POR_VALOR');
  assert.equal(kind(20000, 23000), 'POR_VALOR');
  assert.equal(kind(20000, 13999), null);
  assert.equal(kind(20000, 23001), null);
  assert.equal(kind(60000, 42000), 'POR_VALOR');
  assert.equal(kind(60000, 69000), 'POR_VALOR');
  assert.equal(kind(60000, 41999), null);
  assert.equal(kind(60000, 69001), null);
  assert.equal(kind(80000, 60000), 'POR_VALOR');
  assert.equal(kind(80000, 88000), 'POR_VALOR');
  assert.equal(kind(80000, 59999), null);
  assert.equal(kind(80000, 88001), null);
  const byValue = valor(car({ mmrCents: 2000000 }), 2000000);
  assert.equal(byValue.reason, 'por valor: MMR US$ 20,000 na faixa do lance US$ 20,000');
  assert.equal(byValue.basis, 'VALUE');
  assert.equal(byValue.kind, 'POR_VALOR');
  assert.equal(vehicleMatch.kindLabel('POR_VALOR'), 'POR VALOR · ligar');
  assert.equal(vehicleMatch.countsAsServed('POR_VALOR'), true);
  assert.equal(vehicleMatch.countsAsServed('QUASE'), false);
  assert.equal(byValue.dataGap, false);
});

test('R3c/d: VALOR sem MMR válido nunca é opção; VALOR sem lance não é buscável', () => {
  for (const mmrCents of [null, undefined, '', 0, -100, 'N/A', 'desconhecido', 'abc']) assert.equal(valor(car({ mmrCents }), 2000000), null, String(mmrCents));
  assert.equal(valor(car({ mmrCents: 2000000 }), null), null);
  assert.equal(valor(car({ mmrCents: 2000000 }), 0), null);
  assert.equal(vehicleMatch.valorWishIssue({ make: 'BMW', model: 'X5' }, null), 'BID_MISSING');
  // Nothing informed never becomes BATE, whatever the car.
  assert.notEqual(valor(car({ year: 2004, miles: 240000, mmrCents: 500000 }), null)?.kind, 'BATE');
});

test('R3a: CARRO usa só os critérios informados, sem tolerância; MMR obrigatório sem definir faixa', () => {
  const full = { yearMin: 2019, yearMax: 2021, minMiles: 1000, maxMiles: 50000 };
  assert.equal(carro(car({ year: 2020, miles: 40000 }), full).kind, 'BATE');
  assert.equal(carro(car({ year: 2015, miles: 40000 }), full), null);
  assert.equal(carro(car({ year: 2022, miles: 40000 }), full), null, 'um ano acima não é tolerado');
  assert.equal(carro(car({ year: 2020, miles: 51000 }), full), null, '2% acima da milhagem não é tolerado');
  // MMR is mandatory in CARRO; its amount never decides.
  for (const mmrCents of [null, undefined, '', 0, -100, 'N/A', 'desconhecido', 'abc']) assert.equal(carro(car({ year: 2020, miles: 40000, mmrCents }), full), null, String(mmrCents));
  assert.equal(carro(car({ year: 2020, miles: 40000, mmrCents: 99000000 }), full).kind, 'BATE', 'MMR não inclui nem exclui em CARRO');
  // Incomplete criteria are never searched: no year range, no mileage range.
  assert.equal(carro(car({ year: 2020, mmrCents: 3000000 }), { yearMin: 2019, yearMax: 2021 }).kind, 'BATE');
  assert.equal(vehicleMatch.carroWishIssue({ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2021 }), null);
});

// ---------------------------------------------------------------- R3e: odômetro
test('R3e: odômetro vazio, "TMU" ou "Exempt" é desconhecido, nunca 0, e nunca entra em CARRO', () => {
  const csv = 'Year,Make,Model,Odometer Value,MMR\n2020,BMW,X5,,40000\n2020,BMW,X5,TMU,40000\n2020,BMW,X5,Exempt,40000\n2020,BMW,X5,30000,40000';
  const parsed = manheim.parseCsv(csv);
  const rows = manheim.normalizeRows(parsed, manheim.mapHeaders(parsed.headers));
  assert.deepEqual(rows.map((row) => row.miles), [null, null, null, 30000]);
  const demand = { mode: 'CARRO', wishes: [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2021, minMiles: 1, maxMiles: 50000 }] };
  for (const row of rows.slice(0, 3)) assert.equal(manheim.matchDemand(row, demand), null);
  assert.equal(manheim.matchDemand({ ...rows[3], lane: '1', run: '1' }, demand).kind, 'BATE');
});

// ---------------------------------------------------------------- A6: busca + simulação na mesma Ref
test('A6: Ref com busca e simulação vira duas demandas; nenhuma empresta critério da outra', () => {
  const rows = [
    { id: '1', created_at: '2026-09-20T10:00:00Z', dados: { sid: 's1', ref: 'ABC23', evento: 'simulacao', marca: 'BMW', modelo: 'X5', lance: 30000 } },
    { id: '2', created_at: '2026-09-21T10:00:00Z', dados: { sid: 's2-find-x', ref: 'ABC23', evento: 'busca', marca: 'BMW', modelo: 'X5', ano_de: 2021, ano_ate: 2023, milhas_de: 5000, milhas_ate: 40000 } }
  ];
  const demands = domain.consolidateCalcRuns(rows).map(domain.orderDemand);
  const byMode = Object.fromEntries(demands.map((demand) => [demand.mode, demand]));
  assert.deepEqual(Object.keys(byMode).sort(), ['CARRO', 'VALOR']);
  assert.equal(byMode.VALOR.bidCents, 3000000);
  assert.deepEqual([byMode.VALOR.wishes[0].yearMin, byMode.VALOR.wishes[0].maxMiles], [null, null]);
  assert.equal(byMode.CARRO.bidCents, null);
  assert.deepEqual(byMode.CARRO.wishes[0], { make: 'BMW', model: 'X5', yearMin: 2021, yearMax: 2023, minMiles: 5000, maxMiles: 40000, trim: '' });
  const old = car({ year: 2008, miles: 240000, mmrCents: 2500000 });
  assert.equal(domain.matchManheimDemand(old, byMode.CARRO), null);
  assert.equal(domain.matchManheimDemand(old, byMode.VALOR), null, 'VALOR aplica o teto de milhagem da faixa');
  assert.equal(domain.matchManheimDemand(car({ year: 2022, miles: 30000, mmrCents: 9000000 }), byMode.CARRO).kind, 'BATE');
  // The newest value of each field wins and a range never mixes two sources.
  const newer = [...rows, { id: '3', created_at: '2026-09-22T10:00:00Z', dados: { sid: 's2-find-x', ref: 'ABC23', evento: 'busca', marca: 'BMW', modelo: 'X5', ano_de: 2017, ano_ate: 2019, milhas_de: 5000, milhas_ate: 80000 } }];
  const latest = domain.consolidateCalcRuns(newer).find((item) => item.logicalMode === 'CARRO');
  assert.deepEqual([latest.wishlists[0].yearMin, latest.wishlists[0].yearMax, latest.wishlists[0].maxMiles], [2017, 2019, 80000]);
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
  // Offers use each demand's own rule; VALOR uses the maximum bid, never the total ceiling.
  assert.match(lead, /vehicleMatch\.matchDemand\(car, \{ \.\.\.demand, wishes: demand\.activeWishes \}\)/);
  assert.doesNotMatch(read('panel-domain.js'), /bidCents: mode === 'VALOR' \? criteria\.ceilingCents/);
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
  const sql = read('supabase/migrations/20260929032000_panel_manheim_closed_gap_por_valor.sql');
  assert.equal((sql.match(/\(j\.status <> 'ENCERRADO' and coalesce\(ts\.enabled, true\)\)/g) || []).length, 2);
});

// ---------------------------------------------------------------- A4 no CSV
test('A4: Ref ligada a uma ficha casa só pela ficha (uma pessoa, um alvo)', () => {
  const rows = [
    { id: '1', created_at: '2026-09-20T10:00:00Z', dados: { sid: 'a-find-1', ref: 'ABC23', evento: 'busca', marca: 'BMW', modelo: 'X5', ano_de: 2019, ano_ate: 2022, milhas_de: 1, milhas_ate: 60000 } },
    { id: '2', created_at: '2026-09-20T10:00:00Z', dados: { sid: 'b-find-1', ref: 'XYZ23', evento: 'busca', marca: 'BMW', modelo: 'X5', ano_de: 2019, ano_ate: 2022, milhas_de: 1, milhas_ate: 60000 } }
  ];
  const journey = { id: uuid(1), reference_code: 'ABC23', status: 'ATIVO', criteria_json: {} };
  const built = domain.buildSearchDemands({ journeys: [journey], refs: [], modeItems: domain.consolidateCalcRuns(rows) });
  const targets = [...built.byJourney.get(uuid(1)), ...built.orders].map((demand) => ({ key: demand.key, mode: demand.mode, targetType: demand.targetType, journeyId: demand.journeyId, ref: demand.ref, wishes: demand.activeWishes }));
  const vehicles = [{ ...car({ year: 2020, miles: 30000, mmrCents: 3000000 }), headers: ['Year'], raw: { Year: '2020' }, vin: 'VIN1' }];
  const matches = upload.buildMatches(vehicles, targets, manheim);
  assert.deepEqual(matches.map((match) => [match.journeyId || match.calcRef, match.mode]), [[uuid(1), 'CARRO'], ['XYZ23', 'CARRO']]);
});

// ---------------------------------------------------------------- A19 no servidor
test('A19: combinação que deixou de valer é descartada e contada, sem derrubar o envio', async () => {
  // The single batch compares every block on the server with the demands of TODAY (the snapshot
  // taken when the batch starts), never with criteria cached in the browser.
  const wish = { make: 'BMW', model: 'X5', yearMin: 2019, yearMax: 2022, minMiles: 1, maxMiles: 60000 };
  const journeys = [
    { id: uuid(1), status: 'ATIVO', stage: 'NOVO', reference_code: null, criteria_json: { wishlists: [wish], logical_modes: ['CARRO'] }, budget_cents: null },
    // Criteria changed after the page was opened: now wants an Audi.
    { id: uuid(2), status: 'ATIVO', stage: 'NOVO', reference_code: null, criteria_json: { wishlists: [{ ...wish, make: 'Audi', model: 'Q5' }], logical_modes: ['CARRO'] }, budget_cents: null },
    { id: uuid(3), status: 'ENCERRADO', stage: 'NOVO', reference_code: null, criteria_json: { wishlists: [wish], logical_modes: ['CARRO'] }, budget_cents: null }
  ];
  const base = require('../panel-buscas').buildBuscasBase({ journeys, messages: [], messageLinks: [] });
  // Every ficha "entered" (the rule of who is shown is tested elsewhere).
  base.contact.facts = () => ({ entered: true });
  const batch = require('../panel-manheim-batch');
  const targets = batch.snapshotTargets(require('../panel-buscas-view').demandContext(base).targets);
  assert.deepEqual(targets.map((target) => target.key), [`journey:${uuid(1)}:CARRO`, `journey:${uuid(2)}:CARRO`]);
  const entry = batch.sanitizeVehicle({ fingerprint: 'vin:VIN1', vehicle: { lane: '1', run: '1', year: 2020, make: 'BMW', model: 'X5', miles: 30000, mmrCents: 3500000, vin: 'VIN1' } });
  const matches = batch.matchChunk([entry], targets);
  assert.deepEqual(matches.map((match) => [match.journeyId, match.mode, match.kind]), [[uuid(1), 'CARRO', 'BATE']]);
  // A ficha closed or switched off while the blocks are being sent is discarded and counted by the
  // database, without failing the block.
  const sql = read('supabase/migrations/20261005010000_panel_manheim_lote_unico.sql');
  assert.match(sql, /'discarded', v_requested - v_valid/);
  assert.match(sql, /j\.status <> 'ENCERRADO'/);
  // The browser never compares cars itself anymore: it starts the batch and sends the blocks.
  assert.match(read('painel/painel.js'), /await request\('\/api\/panel\/manheim-batch'\)/);
  assert.doesNotMatch(read('painel/painel.js'), /MCSManheimUpload\.buildMatches\(/);
});

// ---------------------------------------------------------------- C2: Quais buscas salvar
test('C2: "Quais buscas salvar" separa VALOR e CARRO, não inventa faixa e deixa revisão fora do %', async () => {
  const now = Date.now();
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600000).toISOString();
  const busca = (id, ref, extra) => ({ id, created_at: iso(10), dados: { sid: ref + '-find-x', ref, evento: 'busca', canal: 'sms', marca: 'BMW', modelo: 'X5', milhas_de: 1000, ...extra } });
  const calcRuns = [
    busca('1', 'AAAA2', { ano_de: 2019, ano_ate: 2022, milhas_ate: 60000 }),
    busca('2', 'CCCC4', { ano_de: 2010, ano_ate: 2015, milhas_de: 5000, milhas_ate: 90000 }),
    // Incomplete: no maximum year. Never searched, goes to review.
    busca('3', 'DDDD5', { ano_de: 2020, milhas_ate: 50000 }),
    { id: '4', created_at: iso(9), dados: { sid: 's-b', ref: 'BBBB3', evento: 'simulacao', marca: 'BMW', modelo: 'X5', lance: 40000 } },
    { id: '5', created_at: iso(8), dados: { sid: 's-b', ref: 'BBBB3', evento: 'sms' } },
    busca('6', 'EEEE6', { ano_de: 2019, ano_ate: 2022, milhas_ate: 60000 })
  ];
  const journeys = [
    // Mode never confirmed: review, never guessed.
    { id: uuid(1), contact_id: uuid(11), reference_code: null, status: 'ATIVO', criteria_json: { wishlists: [{ make: 'BMW', model: 'X5' }] }, budget_cents: null, created_at: iso(5), updated_at: iso(5) },
    // Linked to EEEE6 (a BMW X5 search) but the confirmed wish is now an Audi Q5 (A3 + A4).
    { id: uuid(2), contact_id: uuid(12), reference_code: null, status: 'ATIVO', criteria_json: { wishlists: [{ make: 'Audi', model: 'Q5', yearMin: 2020, yearMax: 2023, minMiles: 1000, maxMiles: 40000 }], wishlistOverride: true }, budget_cents: null, created_at: iso(5), updated_at: iso(5) }
  ];
  const messages = [{ id: 'm1', direction: 'CUSTOMER', occurred_at_utc: iso(2), source_kind: 'WHATSAPP_WEBHOOK' }, { id: 'm2', direction: 'CUSTOMER', occurred_at_utc: iso(2), source_kind: 'WHATSAPP_WEBHOOK' }];
  // A calculator click is not contact: each order here has a ficha whose client really wrote (SMS print).
  const writers = ['AAAA2', 'CCCC4', 'DDDD5', 'BBBB3'];
  writers.forEach((ref, index) => {
    journeys.push({ id: uuid(30 + index), contact_id: uuid(40 + index), reference_code: ref, status: 'ATIVO', criteria_json: {}, budget_cents: null, created_at: iso(5), updated_at: iso(5) });
    messages.push({ id: 'w' + index, direction: 'CUSTOMER', occurred_at_utc: iso(3), source_kind: 'SMS_PRINT' });
  });
  const tables = { journeys, contacts: [{ id: uuid(11), display_name: 'Qualificar', is_lead: true }, { id: uuid(12), display_name: 'Troca', is_lead: true }, ...writers.map((ref, index) => ({ id: uuid(40 + index), display_name: 'Cliente ' + ref, is_lead: true }))], contact_phones: [], journey_toggle_states: [],
    manheim_saved_searches: [], journey_refs: [{ journey_id: uuid(2), ref_code: 'EEEE6' }], calc_runs: calcRuns,
    message_journeys: [{ journey_id: uuid(1), message_id: 'm1' }, { journey_id: uuid(2), message_id: 'm2' }, ...writers.map((ref, index) => ({ journey_id: uuid(30 + index), message_id: 'w' + index }))], messages };
  const server = { ...realServer, requirePanel: panelCtx, allRows: async (_ctx, table) => tables[table] || [] };
  const handler = loadWith('api/panel/manheim-searches.js', {
    '../../panel-server': server,
    '../../panel-buscas': loadWith('panel-buscas.js', { './panel-server': server })
  });
  const res = response();
  await handler({ method: 'GET', headers: {}, query: {} }, res);
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  const groups = res.payload.groups;
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));
  const criteria = byKey['bmw|x5'];
  assert.equal(criteria.mode, 'CARRO');
  assert.deepEqual(criteria.clients.map((client) => client.ref).sort(), ['AAAA2', 'CCCC4', 'DDDD5']);
  // The Manheim search covers every customer of the group; each car is checked again per customer.
  assert.deepEqual([criteria.yearFrom, criteria.yearTo, criteria.milesFrom, criteria.milesTo], [2010, new Date().getUTCFullYear()+1, 1000, 90000]);
  const value = byKey['bmw|x5|valor'];
  assert.deepEqual([value.mode, value.leads, value.mmrMinCents, value.mmrMaxCents], ['VALOR', 1, 2800000, 4600000]);
  assert.equal(byKey['bmw|x5|qualificar'], undefined);
  assert.equal(res.payload.activeLeads, 5);
  assert.deepEqual([res.payload.activeLeadsCriteria, res.payload.activeLeadsValue], [4, 1]);
  assert.equal(value.percent, 100, 'o % do grupo por valor usa só os clientes por valor');
  assert.equal(res.payload.needsQualifyLeads, 1);
  assert.deepEqual(res.payload.review.map((item) => [item.mode, item.issues[0].code]).sort(), [['REVIEW', 'MODE_UNKNOWN']]);
  assert.equal(byKey['audi|q5'].leads, 1);
  assert.ok(!criteria.clients.some((client) => client.journeyId === uuid(2)), 'a ficha que trocou para Q5 não conta como X5');
  assert.deepEqual([...new Set(groups.map((group) => group.mode))], ['VALOR', 'CARRO']);
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
  // One refresh at a time (the scheduler), never while the operator is typing.
  // Typing still pauses the refresh; work open in ENVIAR OPÇÕES pauses it too (refreshBusy).
  assert.match(panel, /isBusy: refreshBusy/);
  assert.match(panel, /const refreshBusy = \(\) => \{\n\s+if \(operatorIsTyping\(\)\) return true;/);
  assert.match(panel, /MCSRefresh\.createScheduler\(/);
  const actions = read('api/panel/actions.js');
  assert.doesNotMatch(actions.slice(actions.indexOf('module.exports = async')), /return action[A-Za-z]+\(/);
  const entry = read('api/panel/entry.js');
  assert.doesNotMatch(entry.slice(entry.indexOf("if (req.method === 'GET') return")), /return (queue|createJob|createReview|receiveBatch|finishJob|resolveChat|applyReviewAction|undoReviewAction)\(/);
  assert.match(read('painel/lead.js'), /if\(journeyId&&replyComposer\)replyComposer\(conversation,journeyId,reload\);/);
  // The composer sends through the one path (sendControls): panel inside the window, phone outside it.
  assert.match(panel, /MCSSuggest\.sendControls\(sendBox, \{/);
  assert.match(panel, /canSend: \(\) => Boolean\(en\.value\) && translatedFor === pt\.value\.trim\(\)/);
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

// ---------------------------------------------------------------- Bloco 1 (revisão do PR #64)
test('Bloco 1 · R1: ficha parcial é completada pela Ref do mesmo modelo, sem acrescentar modelos', () => {
  const ref = { wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2021, yearMax: 2023, maxMiles: 40000 }], budgetCents: 3000000 };
  assert.deepEqual(domain.effectiveCriteria({ criteria_json: { wishlists: [{ make: 'BMW', model: 'X5' }] } }, ref).wishes,
    [{ make: 'BMW', model: 'X5', yearMin: 2021, yearMax: 2023, minMiles: null, maxMiles: 40000, trim: '' }]);
  assert.deepEqual(domain.effectiveCriteria({ criteria_json: { wishlists: [{ make: 'Audi', model: 'Q5', yearMin: 2020, yearMax: 2022, maxMiles: 30000 }], wishlistOverride: true } }, ref).wishes.map((wish) => wish.model), ['Q5']);
  // A value the ficha has is never overwritten, and the year range is not mixed across sources.
  assert.deepEqual(domain.effectiveCriteria({ criteria_json: { wishlists: [{ make: 'BMW', model: 'X5', yearMin: 2019, maxMiles: 90000 }] } }, ref).wishes,
    [{ make: 'BMW', model: 'X5', yearMin: 2019, yearMax: null, minMiles: null, maxMiles: 90000, trim: '' }]);
});

test('Bloco 1 · aliases: só nomes genéricos conhecidos; nome real com "_" é preservado', () => {
  for (const title of ['_chat', '_chat.txt', 'WhatsApp Chat', 'chat', 'conversa', 'Conversa do WhatsApp', 'mensagens', 'messages', 'export']) assert.equal(parser.isGenericTitle(title), true, title);
  for (const title of ['_Maria', '_loja_do_ze', 'Maria', 'WhatsApp Chat with Ana']) assert.equal(parser.isGenericTitle(title), false, title);
  const migration = read('supabase/migrations/20260929031000_chat_alias_generic_cleanup.sql');
  assert.doesNotMatch(migration, /~ '\^_'/);
  assert.match(migration, /'_chat', 'whatsapp chat', 'chat', 'conversa', 'conversa do whatsapp', 'mensagens', 'messages', 'export'/);
});

test('Bloco 1 · banco real: V2 grava só o teto total; função antiga intacta; POR_VALOR aceito e contado', async () => {
  const { migratedDatabase } = require('./sql/run');
  const { db } = await migratedDatabase();
  try {
    const ids = { actor: uuid(900), contact: uuid(901), open: uuid(902), closed: uuid(903), chat: uuid(904) };
    await db.query(`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values($1,'preview',$2,'teto@example.test','admin',true,false)`, [ids.actor, uuid(905)]);
    await db.query(`insert into public.contacts(id,environment,display_name,created_at,updated_at) values($1,'preview','Cliente Teste',now(),now())`, [ids.contact]);
    await db.query(`insert into public.journeys(id,environment,contact_id,source,status,stage,budget_cents,created_at,updated_at) values($1,'preview',$2,'MANUAL','ATIVO','NOVO',2000000,now(),now())`, [ids.open, ids.contact]);
    await db.query(`insert into public.journeys(id,environment,contact_id,source,status,stage,budget_cents,closed_at,closed_reason,created_at,updated_at) values($1,'preview',$2,'MANUAL','ENCERRADO','NOVO',2000000,now(),'TESTE',now(),now())`, [ids.closed, ids.contact]);
    await db.query(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at) values($1,'preview','WHATSAPP',$2,'teto-teste','RESOLVED',now(),now())`, [ids.chat, ids.contact]);
    let n = 0;
    const message = async (journey) => {
      n += 1;
      const id = uuid(950 + n);
      await db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values($1,'preview',$2,'WHATSAPP','CUSTOMER','my budget is 40k','my budget is 40k',now(),$3,0,'WHATSAPP_WEBHOOK',now())`, [id, ids.chat, 'sig-' + n]);
      await db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'TEST',now())`, [id, journey]);
      return id;
    };
    for (const journey of [ids.open, ids.closed]) for (let point = 1; point <= 6; point += 1) await db.query(`insert into public.journey_checklist(environment,journey_id,point_number,point_label,created_at,updated_at) values('preview',$1,$2,'p',now(),now())`, [journey, point]);
    const call = (fn, journey, messageId, json) => db.query(`select public.${fn}(p_environment => 'preview', p_journey_id => $1, p_message_id => $2, p_kind => 'BUDGET', p_actor_id => $3, p_value => '40k', p_value_json => $4::jsonb) as r`, [journey, messageId, ids.actor, JSON.stringify(json)]);
    const journeyRow = async (id) => (await db.query(`select budget_cents::float8 as budget_cents, confirmed_total_ceiling_cents::float8 as confirmed_total_ceiling_cents from public.journeys where id=$1`, [id])).rows[0];
    // New panel → V2: only the total ceiling changes.
    await call('panel_mark_message_fact_v2', ids.open, await message(ids.open), { ceilingCents: 4000000 });
    assert.deepEqual(await journeyRow(ids.open), { budget_cents: 2000000, confirmed_total_ceiling_cents: 4000000 });
    // V2 ignores the legacy "cents" field and refuses a closed ficha.
    await call('panel_mark_message_fact_v2', ids.open, await message(ids.open), { cents: 3500 });
    assert.deepEqual(await journeyRow(ids.open), { budget_cents: 2000000, confirmed_total_ceiling_cents: 4000000 });
    await assert.rejects(() => call('panel_mark_message_fact_v2', ids.closed, uuid(999), { ceilingCents: 4000000 }), /JOURNEY_CLOSED/);
    // Old panel → original function is untouched (it still writes budget_cents; do not use it between steps).
    await call('panel_mark_message_fact', ids.open, await message(ids.open), { cents: 5500000 });
    assert.equal((await journeyRow(ids.open)).budget_cents, 5500000);
    // POR_VALOR is accepted by the table and by the upload RPC; lead_count counts BATE and POR_VALOR only.
    // buscas-split: every new match names its mode (VALOR here); a match without mode is refused.
    const vehicle = { headers: ['Year'], raw: { Year: '2022' }, parsed: { year: 2022, make: 'BMW', model: 'X5', miles: 30000 } };
    const upload = (await db.query(`select public.panel_store_manheim_upload(p_environment => 'preview', p_actor_id => $1, p_source_file_count => 1, p_vehicle_count => 1, p_headers => '[["Year"]]'::jsonb, p_header_map => '{}'::jsonb, p_matches => $2::jsonb) as r`,
      [ids.actor, JSON.stringify([{ journeyId: ids.open, kind: 'POR_VALOR', mode: 'VALOR', fingerprint: 'vin:A', vehicle }])])).rows[0].r;
    assert.equal(upload.leadCount, 1);
    const quase = (await db.query(`select public.panel_store_manheim_upload(p_environment => 'preview', p_actor_id => $1, p_source_file_count => 1, p_vehicle_count => 1, p_headers => '[["Year"]]'::jsonb, p_header_map => '{}'::jsonb, p_matches => $2::jsonb) as r`,
      [ids.actor, JSON.stringify([{ journeyId: ids.open, kind: 'QUASE', mode: 'VALOR', fingerprint: 'vin:B', vehicle }])])).rows[0].r;
    assert.equal(quase.leadCount, 0, 'QUASE nunca conta');
    assert.equal(quase.matchedVehicleCount, 1);
  } finally { await db.close(); }
});

test('Bloco 1 · painel mostra POR VALOR separado de BATE e QUASE', () => {
  const panel = read('painel/painel.js');
  assert.match(panel, /const kindClass = \(kind\) => kind === 'BATE' \? 'match' : kind === 'POR_VALOR' \? 'value' : 'near';/);
  assert.match(panel, /POR VALOR #\$\{group\.searches\}/);
  assert.match(read('painel/painel.css'), /\.manheim-row\.value/);
  const rows = [{ match_kind: 'QUASE', vehicle_json: { parsed: { miles: 1 } } }, { match_kind: 'POR_VALOR', vehicle_json: { parsed: { miles: 1 } } }, { match_kind: 'BATE', vehicle_json: { parsed: { miles: 9 } } }];
  assert.deepEqual(upload.sortForDisplay(rows).map((row) => row.match_kind), ['BATE', 'POR_VALOR', 'QUASE']);
  assert.match(read('api/panel/actions.js'), /rpc\/panel_mark_message_fact_v2/);
  const migration = read('supabase/migrations/20260929033000_panel_mark_message_ceiling.sql');
  assert.match(migration, /DEPLOY ORDER MATTERS/);
  assert.doesNotMatch(migration, /function public\.panel_mark_message_fact\(/);
});

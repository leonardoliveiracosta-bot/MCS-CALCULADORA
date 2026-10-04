'use strict';

// Comando corretivo do PR #69: isolamento real CARRO × VALOR, fim do MIXED, modo obrigatório nos
// novos matches e testes que não dependem de rede nem de Supabase. Numeração = "TESTES NOVOS".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const domain = require('../panel-domain');
const vehicleMatch = require('../vehicle-match');
const manheimAi = require('../panel-manheim-ai');
const realServer = require('../panel-server');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ACTOR = '66000000-0000-4000-8000-000000000001';
const JOURNEY = '66000000-0000-4000-8000-000000000010';
function loadWith(relative, mocks) {
  const file = path.join(root, relative), mod = { exports: {} };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  return mod.exports;
}
const response = () => ({ code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.payload = value; return value; } });
const ctx = { modelAliasesLoaded: true, config: { url: 'https://example.test', secretKey: 'test' }, panel: { id: ACTOR }, environment: 'preview' };

// Honda Civic searched by year and mileage (CARRO) and BMW X5 simulated by value (VALOR).
const civicCarro = { id: 'c1', created_at: '2026-09-28T10:00:00Z', dados: { sid: 's-find-1', ref: 'HCAR2', evento: 'busca', logical_mode: 'CARRO', marca: 'Honda', modelo: 'Civic', ano_de: 2020, ano_ate: 2025, milhas_de: 50000, milhas_ate: 90000 } };
const x5Valor = { id: 'v1', created_at: '2026-09-28T11:00:00Z', dados: { sid: 's-val-1', ref: 'BVAL3', evento: 'simulacao', logical_mode: 'VALOR', marca: 'BMW', modelo: 'X5', lance: 50000 } };
const items = domain.consolidateCalcRuns([civicCarro, x5Valor]);
const ficha = (criteria, extra = {}) => ({ id: JOURNEY, reference_code: 'HCAR2', status: 'ATIVO', criteria_json: criteria, budget_cents: null, ...extra });
const byMode = (demands) => Object.fromEntries(demands.map((demand) => [demand.mode === 'REVIEW' ? demand.key.split(':').pop() : demand.mode, demand]));
const models = (demand) => demand.wishes.map((wish) => `${wish.make} ${wish.model}`);

test('1 · ficha com CARRO Honda Civic e VALOR BMW X5: Honda só em CARRO, BMW só em VALOR (cenário da auditoria)', () => {
  const demands = byMode(domain.journeyDemands(ficha({ wishlists: [{ make: 'Honda', model: 'Civic' }] }), items));
  assert.deepEqual(models(demands.VALOR), ['BMW X5']);
  assert.equal(demands.VALOR.bidCents, 5000000);
  assert.deepEqual(models(demands.CARRO), ['Honda Civic']);
  assert.deepEqual([demands.CARRO.wishes[0].yearMin, demands.CARRO.wishes[0].yearMax, demands.CARRO.wishes[0].minMiles, demands.CARRO.wishes[0].maxMiles], [2020, 2025, 50000, 90000]);
  assert.equal(demands.CARRO.bidCents, null);
  // Before the fix the VALOR demand became "Honda Civic" with the BMW X5 bid.
  assert.ok(!models(demands.VALOR).includes('Honda Civic'));
  assert.equal(demands.REVIEW_MANUAL, undefined, 'a cópia da Ref não é critério manual');
});

test('2 · cenário inverso: critério vindo de VALOR na ficha não contamina CARRO', () => {
  const demands = byMode(domain.journeyDemands(ficha({ wishlists: [{ make: 'BMW', model: 'X5' }] }, { budget_cents: 5000000 }), items));
  assert.deepEqual(models(demands.CARRO), ['Honda Civic']);
  assert.deepEqual(models(demands.VALOR), ['BMW X5']);
  assert.ok(!demands.CARRO.wishes.some((wish) => wish.model === 'X5'));
});

test('3 · mesma Ref com dois modos: duas demandas, uma pessoa', () => {
  const both = [{ ...civicCarro, dados: { ...civicCarro.dados, ref: 'MXDD4' } }, { ...x5Valor, dados: { ...x5Valor.dados, ref: 'MXDD4' } }];
  const modeItems = domain.consolidateCalcRuns(both);
  const people = domain.groupCalculatorByRef(modeItems, []);
  assert.equal(people.length, 1);
  assert.deepEqual(people[0].logicalModes.sort(), ['CARRO', 'VALOR']);
  const built = domain.buildSearchDemands({ journeys: [], refs: [], modeItems });
  assert.deepEqual(built.orders.map((demand) => demand.key).sort(), ['ref:MXDD4:CARRO', 'ref:MXDD4:VALOR']);
});

test('4 · o lance de VALOR nunca entra em CARRO e 5 · ano e milhagem de CARRO nunca entram em VALOR', () => {
  const demands = byMode(domain.journeyDemands(ficha({ mode_overrides: { VALOR: { wishlists: [{ make: 'BMW', model: 'X5' }], bidCents: 7000000 } } }, { budget_cents: 5000000 }), items));
  assert.equal(demands.CARRO.bidCents, null);
  assert.equal(demands.VALOR.bidCents, 7000000, 'o lance salvo para VALOR vale só para VALOR');
  assert.ok(demands.VALOR.wishes.every((wish) => wish.yearMin === null && wish.yearMax === null && wish.minMiles === null && wish.maxMiles === null));
  // CARRO never compares money: the same car is BATE whatever the bid or the MMR.
  const civic = { lane: '1', run: '1', year: 2022, make: 'Honda', model: 'Civic', miles: 60000, mmrCents: 99900000 };
  assert.equal(vehicleMatch.matchDemand(civic, { ...demands.CARRO, wishes: demands.CARRO.activeWishes }).kind, 'BATE');
});

test('6 · critério manual explicitamente CARRO altera só CARRO e 7 · explicitamente VALOR altera só VALOR', () => {
  const carro = byMode(domain.journeyDemands(ficha({ mode_overrides: { CARRO: { wishlists: [{ make: 'Toyota', model: 'Corolla', yearMin: 2019, yearMax: 2021, minMiles: 1000, maxMiles: 40000 }] } } }), items));
  assert.deepEqual(models(carro.CARRO), ['Toyota Corolla']);
  assert.deepEqual(models(carro.VALOR), ['BMW X5']);
  const valor = byMode(domain.journeyDemands(ficha({ mode_overrides: { VALOR: { wishlists: [{ make: 'Audi', model: 'Q5' }] } } }), items));
  assert.deepEqual(models(valor.VALOR), ['Audi Q5']);
  assert.deepEqual(models(valor.CARRO), ['Honda Civic']);
  assert.equal(valor.VALOR.bidCents, 5000000, 'o lance continua o da demanda VALOR');
});

test('6/7 · "Carro ou faixa" com modo grava só aquele modo, atômico pela RPC', async () => {
  const rpc = [];
  const handler = loadWith('api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: async () => ctx, jsonBody: async (req) => req.body,
      rows: async (_ctx, table) => table === 'messages' || table === 'message_journeys' ? [{ id: '66000000-0000-4000-8000-000000000091', message_id: '66000000-0000-4000-8000-000000000091', chat_id: 'c1', journey_id: JOURNEY, body_text: 'quero Corolla', direction: 'CUSTOMER' }] : [],
      allRows: async (_ctx, table) => table === 'calc_runs' ? [civicCarro, x5Valor] : table === 'journey_refs' ? [{ journey_id: JOURNEY, ref_code: 'BVAL3' }] : [],
      insert: async () => [], patchRows: async () => [], recordMutation: async () => {},
      supabase: async (_u, _k, requestPath, options) => { rpc.push({ requestPath, body: JSON.parse(options.body) }); return { marked: true }; } },
    '../../panel-read-model': { ...require('../panel-read-model'), journeyExists: async () => ({ ...ficha({ wishlists: [] }), contact_id: 'x', stage: 'NOVO' }), messageForJourney: async () => ({ id: '66000000-0000-4000-8000-000000000091', chat_id: 'c1', body_text: 'quero Corolla', direction: 'CUSTOMER' }) },
    '../../panel-manheim-state': { undoSupported: async () => true, activeFilter: async () => ({}) }
  });
  const call = async (mode) => { const res = response(); await handler({ method: 'POST', headers: {}, body: { action: 'mark_message', journeyId: JOURNEY, messageId: '66000000-0000-4000-8000-000000000091', kind: 'VEHICLE', mode, wishlists: [{ make: 'Toyota', model: 'Corolla', yearMin: 2019, yearMax: 2021, minMiles: 1000, maxMiles: 40000 }] } }, res); return res; };
  const res = await call('CARRO');
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  const json = rpc.at(-1).body.p_value_json;
  assert.equal(json.mode, 'CARRO');
  assert.deepEqual(json.modeWishlists.map((wish) => wish.model), ['Corolla', 'Civic'], 'os outros carros de CARRO continuam');
  assert.equal(json.confirmedWishlists, undefined, 'a lista genérica não é tocada');
  // 8 · without mode, on a ficha with both searches, nothing is written.
  rpc.length = 0;
  const refused = await call(null);
  assert.deepEqual([refused.code, refused.payload.error, rpc.length], [400, 'SEARCH_MODE_REQUIRED', 0]);
  // Before the migration the RPC would ignore the mode: refused instead of lost.
  const early = loadWith('api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: async () => ctx, jsonBody: async (req) => req.body, rows: async () => [], allRows: async (_ctx, table) => table === 'calc_runs' ? [civicCarro, x5Valor] : [], supabase: async () => { throw new Error('não deveria chamar'); } },
    '../../panel-read-model': { ...require('../panel-read-model'), journeyExists: async () => ({ ...ficha({}), contact_id: 'x', stage: 'NOVO' }), messageForJourney: async () => ({ id: '66000000-0000-4000-8000-000000000091', chat_id: 'c1', body_text: 'x', direction: 'CUSTOMER' }) },
    '../../panel-manheim-state': { undoSupported: async () => false, activeFilter: async () => ({}) }
  });
  const pending = response();
  await early({ method: 'POST', headers: {}, body: { action: 'mark_message', journeyId: JOURNEY, messageId: '66000000-0000-4000-8000-000000000091', kind: 'VEHICLE', mode: 'VALOR', wishlists: [{ make: 'Audi', model: 'Q5' }] } }, pending);
  assert.deepEqual([pending.code, pending.payload.error], [503, 'MANHEIM_MIGRATION_PENDING']);
  assert.match(read('supabase/migrations/20261001010000_panel_buscas_split_desfazer_lote.sql'), /jsonb_build_object\('mode_overrides',/);
});

test('8 · critério manual antigo ambíguo, com dois modos, vai para REVIEW e não entra em nenhum', () => {
  const demands = byMode(domain.journeyDemands(ficha({ wishlists: [{ make: 'Honda', model: 'Civic', yearMin: 2015, yearMax: 2018, maxMiles: 120000 }], wishlistOverride: true }), items));
  assert.equal(demands.REVIEW_MANUAL.mode, 'REVIEW');
  assert.equal(demands.REVIEW_MANUAL.issues[0].code, 'MANUAL_MODE_UNKNOWN');
  assert.equal(demands.REVIEW_MANUAL.active, false);
  // The manual 2015 a 2018 range is applied to neither search.
  assert.deepEqual([demands.CARRO.wishes[0].yearMin, demands.CARRO.wishes[0].yearMax], [2020, 2025]);
  assert.deepEqual(models(demands.VALOR), ['BMW X5']);
  // With ONE mode the ficha stays the source of truth (rule kept).
  const single = domain.journeyDemands(ficha({ wishlists: [{ make: 'Honda', model: 'Civic', yearMin: 2015, yearMax: 2018, minMiles: 1000, maxMiles: 120000 }], wishlistOverride: true }), items.filter((item) => item.logicalMode === 'CARRO'));
  assert.deepEqual(single.map((demand) => [demand.mode, demand.wishes[0].yearMin]), [['CARRO', 2015]]);
  // The operator assigns it to one mode ("Aplicar a CARRO"), never to both.
  assert.match(read('api/panel/actions.js'), /case 'assign_manual_mode'/);
  assert.match(read('painel/painel.js'), /'Aplicar a CARRO'/);
});

test('9 · não existe MIXED operacional: o contêiner da pessoa não mistura critério, lance nem veículo', () => {
  const offenders = [];
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).forEach((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (!['node_modules', '.git', 'tests', 'test-results', 'img', 'data'].includes(entry.name)) walk(rel); return; }
    if (/\.(js|html|sql)$/.test(entry.name) && /MIXED/.test(fs.readFileSync(path.join(root, rel), 'utf8'))) offenders.push(rel);
  });
  walk('.');
  assert.deepEqual(offenders, []);
  const same = [civicCarro, x5Valor].map((row) => ({ ...row, dados: { ...row.dados, ref: 'MXDD4', marca: 'BMW', modelo: 'X5' } }));
  const [person] = domain.groupCalculatorByRef(domain.consolidateCalcRuns(same), []);
  assert.equal(person.logicalMode, null);
  assert.deepEqual(person.wishlists.map((wish) => [wish.mode, wish.yearMin]), [['VALOR', null], ['CARRO', 2020]], 'o mesmo modelo nos dois modos continua em duas entradas');
  assert.equal(person.budgetCents, 5000000);
  assert.equal(person.modeSummaries.CARRO.budgetCents, null);
  assert.match(person.vehicleText, /^Por valor: BMW X5 · Por ano e milhagem: 2020–2025 BMW X5$/);
  // A CARRO event that carries a bid never gives the person a bid.
  const onlyCarro = domain.groupCalculatorByRef(domain.consolidateCalcRuns([{ ...civicCarro, lance: 45000, dados: { ...civicCarro.dados, lance: 45000 } }]), [])[0];
  assert.equal(onlyCarro.budgetCents, null);
});

test('10 · ENTRADA, CLIENTES e HOJE mostram a pessoa uma vez', () => {
  const same = [civicCarro, x5Valor, { id: 'k', created_at: '2026-09-28T12:00:00Z', dados: { sid: 's-val-1', ref: 'BVAL3', evento: 'whatsapp', logical_mode: 'VALOR' } }].map((row) => ({ ...row, dados: { ...row.dados, ref: 'MXDD4' } }));
  const people = domain.groupCalculatorByRef(domain.consolidateCalcRuns(same), []);
  assert.equal(people.length, 1);
  assert.equal(domain.buildTodayOrderItems(people).length, 1);
  assert.equal(domain.buildTodayOrderItems(people)[0].checklistLabel, 'por valor e por ano e milhagem');
  // The ENTRADA order card is gone (a calculator order with no message is never listed), so no
  // panel card shows a combined badge; the BUSCAS badge counts people.
  const client = read('painel/painel.js');
  assert.doesNotMatch(client, /function orderCard\(/);
  assert.doesNotMatch(client, /makeBadge\([^)]*(MIXED|Misto)/i);
  // ENVIAR OPÇÕES counts people (a person with VALOR and CARRO cars is one), same rule as its list.
  assert.match(client, /count\('searches', options, \(data\) => optionsPeopleOf\(data\)\)/);
  assert.match(client, /const optionsPeopleOf = \(data\) => new Set\(/);
});

test('11 · novos matches sem logical_mode são recusados pelo banco e 12 · linhas históricas nulas ficam', () => {
  const migration = read('supabase/migrations/20261001010000_panel_buscas_split_desfazer_lote.sql');
  assert.equal((migration.match(/or v_mode is null or v_mode not in \('CARRO','VALOR'\)/g) || []).length, 2, 'as duas RPCs de upload');
  assert.doesNotMatch(migration, /v_mode is not null and v_mode not in/);
  assert.doesNotMatch(migration, /update public\.manheim_matches set logical_mode/i, 'nenhum backfill');
  const scenario = read('tests/sql/teste-buscas-split-desfazer-lote.sql');
  for (const check of ['match sem modo foi aceito', 'match sem modo foi aceito em partes', 'CARRO e VALOR válidos não gravaram', 'histórico nulo perdido', 'desfazer deixou de ser idempotente']) assert.match(scenario, new RegExp(check));
});

test('13 · os testes antigos passam sem rede e sem Supabase (fetch responde 403 como um proxy)', () => {
  const preload = path.join(__dirname, 'fixtures', 'sem-rede.js');
  const names = ['HOJE includes a wanted car after the order was treated', 'HOJE includes an old linked order when a disabled lead writes again', 'presenting a unit twice uses the existing VIN identity', 'archive skips invalid rows and reports ignored count', 'a calculator click without a message stays out of HOJE; a real message brings it in'];
  const env = { ...process.env, NODE_OPTIONS: `--require ${preload}` };
  delete env.SUPABASE_URL; delete env.SUPABASE_SECRET_KEY; delete env.SUPABASE_PUBLISHABLE_KEY; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...names.map((name) => `--test-name-pattern=${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), path.join(__dirname, 'fase2-corrections.test.js')], { env, encoding: 'utf8', timeout: 60000 });
  const output = run.stdout + run.stderr;
  assert.equal(run.status, 0, output.slice(-2000));
  assert.match(output, /# pass 5/);
  assert.match(output, /# fail 0/);
  // The state module only reads through the reader its caller passes (the mocked one in tests).
  assert.match(read('panel-manheim-state.js'), /function readerFor\(services\)/);
});

test('14 · lote desfeito some de todos os usos operacionais e 15 · o lote vizinho fica intacto', () => {
  // Undone (or unfinished) batches leave every operational read: score, HOJE, CLIENTES, the report
  // and the ficha read only live batches, and never the whole inventory.
  for (const [file, pattern] of [
    ['panel-ready.js', /panel_manheim_score_mmr/], ['supabase/migrations/20261005010000_panel_manheim_lote_unico.sql', /u\.undone_at is null and u\.activated_at is not null/],
    ['api/panel/report.js', /manheim_uploads'[^\n]*\.\.\.liveBatch/], ['api/panel/records.js', /latestActiveUpload\(ctx/],
    ['panel-lead.js', /liveUploadIds\(ctx/], ['panel-manheim-state.js', /activated_at: 'not\.is\.null'/], ['panel-buscas-view.js', /liveUploadFilter\(ctx/],
    ['api/panel/vitrines.js', /VITRINE_SOURCE_UNDONE/], ['api/panel/actions.js', /A match of an undone import batch is never presented/]
  ]) assert.match(read(file), pattern, file);
  for (const file of ['panel-ready.js', 'api/panel/today.js', 'api/panel/records.js', 'api/panel/report.js']) assert.doesNotMatch(read(file), /allRows\(ctx, 'manheim_(vehicles|matches)'/, file);
  const scenario = read('tests/sql/teste-buscas-split-desfazer-lote.sql');
  assert.match(scenario, /o outro lote foi alterado/);
  assert.match(scenario, /histórico do lote vizinho alterado/);
});

test('OpenAI · só modelos aprovados; nome desconhecido ou ausente desliga a IA sem trocar de modelo', async () => {
  assert.deepEqual(manheimAi.APPROVED_MODELS, ['gpt-6-luna', 'gpt-5.4-nano', 'gpt-5.6-luna']);
  assert.equal(manheimAi.model({}), null, 'sem modelo configurado não há escolha silenciosa');
  assert.equal(manheimAi.model({ MANHEIM_OPENAI_MODEL: 'gpt-6-luna' }), 'gpt-6-luna');
  assert.equal(manheimAi.model({ MANHEIM_OPENAI_MODEL: 'gpt-5.6-luna' }), 'gpt-5.6-luna');
  assert.equal(manheimAi.model({ MANHEIM_OPENAI_MODEL: 'gpt-6-astra' }), null);
  assert.equal(manheimAi.enabled({ MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k', MANHEIM_OPENAI_MODEL: 'gpt-6-astra' }), false);
  assert.equal(manheimAi.enabled({ MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k' }), false, 'modelo obrigatório');
  assert.equal(manheimAi.enabled({ MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k', MANHEIM_OPENAI_MODEL: 'gpt-6-luna' }), true);
  assert.equal(manheimAi.enabled({ OPENAI_API_KEY: 'k', MANHEIM_OPENAI_MODEL: 'gpt-6-luna' }), false, 'desligada por padrão');
  // Its own flag: the audit and triage flags never turn it on.
  assert.equal(manheimAi.enabled({ MANHEIM_MATCH_AUDIT_ENABLED: '1', ENTRADA_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k', MANHEIM_OPENAI_MODEL: 'gpt-6-luna' }), false);
  assert.ok(manheimAi.PRICES['gpt-6-luna']);
  let called = false;
  await assert.rejects(() => manheimAi.suggestRows([{ id: '0', cells: { year: '2022', model: 'X5', miles: '7k' }, ambiguous: ['miles'] }], { env: { MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'k', MANHEIM_OPENAI_MODEL: 'gpt-6-astra' }, fetchImpl: async () => { called = true; } }), (failure) => failure.code === 'OPENAI_NOT_ENABLED');
  assert.equal(called, false, 'nenhuma chamada');
});

test('OpenAI · o servidor decide o que é ambíguo: linha clara nunca é enviada', () => {
  // The browser claims these are ambiguous; the server reads them with the same parser rule.
  const clear = { id: '1', cells: { year: '2022', make: 'BMW', model: 'X5', miles: '45000', mmr: '$41,500' }, ambiguous: ['miles', 'mmr'] };
  const unclear = { id: '2', cells: { year: '2022', make: 'BMW', model: 'X5', miles: '45k mi', mmr: '$41,500' }, ambiguous: ['miles', 'mmr', 'year'] };
  assert.equal(manheimAi.sanitizeRow(clear), null);
  assert.deepEqual(manheimAi.sanitizeRow(unclear).ambiguous, ['miles'], 'só o campo realmente ambíguo');
  assert.deepEqual(manheimAi.sanitizeRows([clear, unclear]).map((row) => row.id), ['2']);
  assert.equal(manheimAi.sanitizeRows([clear]), null);
});

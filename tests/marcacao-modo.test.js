'use strict';

// Correção: "Carro ou faixa" marcado para UMA busca (CARRO ou VALOR) não altera os campos genéricos
// da ficha (criteria_json.wishlist/wishlists/wishlistOverride e vehicle_text). O payload que o
// painel monta vai direto para a RPC num banco PGlite com todas as migrações.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const domain = require('../panel-domain');
const realServer = require('../panel-server');
const { migratedDatabase } = require('./sql/run');
// RPC bodies produced by the panel at 671ce07 (before this change), recorded once with this same harness.
const PREVIOUS = require('./fixtures/marcacao-modo-payloads-671ce07.json');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ACTOR = '67000000-0000-4000-8000-000000000001';
const JOURNEY = '67000000-0000-4000-8000-000000000010';
const CONTACT = '67000000-0000-4000-8000-000000000011';
const MESSAGES = ['67000000-0000-4000-8000-000000000091', '67000000-0000-4000-8000-000000000092', '67000000-0000-4000-8000-000000000093'];
const ctx = { config: { url: 'https://example.test', secretKey: 'test' }, panel: { id: ACTOR }, environment: 'preview' };
const response = () => ({ code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.payload = value; return value; } });
const SCION = { make: 'Scion', model: 'tC', yearMin: 2012, yearMax: 2014, minMiles: 1000, maxMiles: 90000 };
const SAAB = { make: 'Saab', model: '9-3' };

function loadSource(source, relative, mocks) {
  const file = path.join(root, relative), mod = { exports: {} };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', source)(req, mod, mod.exports);
  return mod.exports;
}

// The panel handler with an in-memory ficha. Every RPC call is recorded, and every other write too.
function panel({ journey, calcRuns = [], refs = [], source = read('api/panel/actions.js') }) {
  const rpc = [], writes = [];
  const handler = loadSource(source, 'api/panel/actions.js', {
    '../../panel-server': { ...realServer, requirePanel: async () => ctx, jsonBody: async (req) => req.body,
      rows: async () => [], allRows: async (_ctx, table) => table === 'calc_runs' ? calcRuns : table === 'journey_refs' ? refs : [],
      insert: async (_ctx, table, row) => { writes.push({ table, row }); return [row]; },
      patchRows: async (_ctx, table, filter, patch) => { writes.push({ table, patch }); return []; },
      recordMutation: async (_ctx, value) => { writes.push({ table: 'mutation', value }); },
      supabase: async (_u, _k, requestPath, options) => { rpc.push({ requestPath, body: JSON.parse(options.body) }); return { status: 'COMPLETE' }; } },
    '../../panel-read-model': { ...require('../panel-read-model'), journeyExists: async () => journey(),
      messageForJourney: async (_ctx, _journeyId, messageId) => ({ id: messageId, chat_id: 'c1', body_text: 'x', direction: 'CUSTOMER' }) },
    '../../panel-manheim-state': { undoSupported: async () => true, activeFilter: async () => ({}) }
  });
  const call = async (body) => { const res = response(); await handler({ method: 'POST', headers: {}, body: { action: 'mark_message', journeyId: JOURNEY, kind: 'VEHICLE', ...body } }, res); return res; };
  return { rpc, writes, call };
}

async function database(before) {
  const { db } = await migratedDatabase({ before });
  await db.exec(`
    insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','67000000-0000-4000-8000-000000000002','m@example.com','admin',true,false);
    insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente','CALCULATOR',now(),now());
    insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,vehicle_text,created_at,updated_at)
      values('${JOURNEY}','preview','${CONTACT}','CALCULATOR','NOVO','ATIVO','{"logical_modes":["CARRO","VALOR"]}','Veículo original',now(),now());
    insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) values('preview','${JOURNEY}',1,'Carro','OPEN',now(),now());
    insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,created_at,updated_at) values('67000000-0000-4000-8000-000000000020','preview','WHATSAPP','${CONTACT}','k1','RESOLVED',now(),now());
    ${MESSAGES.map((id, index) => `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at)
      values('${id}','preview','67000000-0000-4000-8000-000000000020','WHATSAPP','CUSTOMER','m${index}','m${index}',now(),'sig${index}',1,'IMPORT',now());
    insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id}','${JOURNEY}','IMPORT',now());`).join('\n')}`);
  const state = async () => (await db.query(`select criteria_json, vehicle_text, status from public.journeys where id='${JOURNEY}'`)).rows[0];
  const apply = async (body) => (await db.query('select public.panel_mark_message_fact_v2($1::public.panel_environment,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) as result',
    [body.p_environment, body.p_journey_id, body.p_message_id, body.p_kind, body.p_actor_id, body.p_value, JSON.stringify(body.p_value_json), body.p_deadline_at, body.p_simulate_failure])).rows[0].result;
  const counts = async () => (await db.query(`select (select count(*) from public.journey_declarations)::int decl, (select count(*) from public.message_fact_marks)::int marks, (select count(*) from public.journey_checklist where status='COMPLETE')::int done`)).rows[0];
  return { db, state, apply, counts };
}
const GENERIC = ['wishlist', 'wishlists', 'wishlistOverride', 'confirmedWishlists'];
const generic = (criteria) => GENERIC.filter((key) => Object.hasOwn(criteria || {}, key));

test('1 e 2 · CARRO e VALOR na mesma ficha: cada marcação só no seu modo, resumo dos dois no vehicle_text', async () => {
  const bank = await database();
  const current = async () => ({ id: JOURNEY, contact_id: CONTACT, reference_code: null, status: 'ATIVO', stage: 'NOVO', budget_cents: null, ...(await bank.state()) });
  let snapshot = await current();
  const ui = panel({ journey: () => snapshot });

  // 1. CARRO: Scion tC
  const carro = await ui.call({ messageId: MESSAGES[0], mode: 'CARRO', wishlists: [SCION] });
  assert.equal(carro.code, 200, JSON.stringify(carro.payload));
  const first = ui.rpc.at(-1).body.p_value_json;
  assert.deepEqual(Object.keys(first).sort(), ['mode', 'modeWishlists', 'vehicleText']);
  assert.equal(first.vehicleText, 'Por ano e milhagem: 2012–2014 Scion tC');
  await bank.apply(ui.rpc.at(-1).body);
  let after = await bank.state();
  assert.equal(after.criteria_json.mode_overrides.CARRO.wishlists[0].model, 'tC');
  assert.equal(after.criteria_json.mode_overrides.VALOR, undefined);
  assert.deepEqual(generic(after.criteria_json), []);
  assert.equal(after.vehicle_text, 'Por ano e milhagem: 2012–2014 Scion tC');

  // 2. VALOR: Saab 9-3; CARRO continua Scion
  snapshot = await current();
  const valor = await ui.call({ messageId: MESSAGES[1], mode: 'VALOR', wishlists: [SAAB] });
  assert.equal(valor.code, 200);
  const second = ui.rpc.at(-1).body.p_value_json;
  assert.equal(second.wishlist, undefined, 'nenhuma wishlist genérica no payload');
  assert.equal(second.vehicleText, 'Por valor: Saab 9-3 · Por ano e milhagem: 2012–2014 Scion tC');
  await bank.apply(ui.rpc.at(-1).body);
  after = await bank.state();
  assert.deepEqual(after.criteria_json.mode_overrides.VALOR.wishlists.map((wish) => wish.model), ['9-3']);
  assert.deepEqual(after.criteria_json.mode_overrides.CARRO.wishlists.map((wish) => wish.model), ['tC']);
  assert.deepEqual(generic(after.criteria_json), []);
  assert.equal(after.vehicle_text, 'Por valor: Saab 9-3 · Por ano e milhagem: 2012–2014 Scion tC');
  // The declarations keep exactly what was marked, with the mode.
  const declarations = (await bank.db.query(`select value_text, value_json from public.journey_declarations order by created_at, value_text`)).rows;
  assert.deepEqual(declarations.map((row) => [row.value_text, row.value_json.mode]).sort(), [['2012–2014 Scion tC', 'CARRO'], ['Saab 9-3', 'VALOR']]);

  // 6. Sem modo numa ficha com os dois: recusado e nada gravado (nem RPC, nem outra escrita).
  snapshot = await current();
  const before = { rpc: ui.rpc.length, writes: ui.writes.length, counts: await bank.counts(), state: await bank.state() };
  const refused = await ui.call({ messageId: MESSAGES[2], mode: null, wishlists: [SAAB] });
  assert.deepEqual([refused.code, refused.payload.error], [400, 'SEARCH_MODE_REQUIRED']);
  assert.equal(ui.rpc.length, before.rpc);
  assert.equal(ui.writes.length, before.writes);
  assert.deepEqual(await bank.counts(), before.counts);
  assert.deepEqual(await bank.state(), before.state);
  await bank.db.close();
});

test('3 · tirar o Saab do VALOR não cria falso critério manual (e a poluição antiga criava)', () => {
  const clean = { id: JOURNEY, status: 'ATIVO', criteria_json: { logical_modes: ['CARRO', 'VALOR'], mode_overrides: { CARRO: { wishlists: [SCION], wishlistOverride: true }, VALOR: { wishlists: [{ make: 'Pontiac', model: 'G8' }], wishlistOverride: true } } } };
  const demands = domain.journeyDemands(clean, []);
  assert.deepEqual(demands.map((demand) => demand.key.split(':').pop()).sort(), ['CARRO', 'VALOR']);
  assert.deepEqual(demands.find((demand) => demand.mode === 'CARRO').wishes.map((wish) => wish.model), ['tC']);
  // The same ficha with the old leftover (criteria_json.wishlist = Saab 9-3) shows the false item.
  const polluted = { ...clean, criteria_json: { ...clean.criteria_json, wishlist: { wishlists: [SAAB] } } };
  const manual = domain.journeyDemands(polluted, []).find((demand) => demand.key.endsWith(':REVIEW_MANUAL'));
  assert.ok(manual, 'a sobra genérica antiga virava critério manual');
  assert.deepEqual(manual.wishes.map((wish) => wish.model), ['9-3']);
});

test('4 e 5 · sem modo (ficha com um modo ou sem modo): payload idêntico ao da versão anterior', async () => {
  const carroRun = { id: 'c1', created_at: '2026-09-28T10:00:00Z', dados: { sid: 's-find-1', ref: 'HCAR2', evento: 'busca', logical_mode: 'CARRO', marca: 'Honda', modelo: 'Civic', ano_de: 2020, ano_ate: 2025, milhas_de: 50000, milhas_ate: 90000 } };
  const cases = [
    { key: 'umModo', journey: { id: JOURNEY, contact_id: CONTACT, reference_code: 'HCAR2', status: 'ATIVO', stage: 'NOVO', criteria_json: {}, vehicle_text: 'Honda Civic' }, calcRuns: [carroRun] },
    { key: 'semModo', journey: { id: JOURNEY, contact_id: CONTACT, reference_code: null, status: 'ATIVO', stage: 'NOVO', criteria_json: { wishlists: [{ make: 'Kia', model: 'Soul' }] }, vehicle_text: 'Kia Soul' }, calcRuns: [] }
  ];
  for (const scenario of cases) {
    const ui = panel({ journey: () => scenario.journey, calcRuns: scenario.calcRuns });
    const res = await ui.call({ messageId: MESSAGES[0], wishlists: [{ make: 'Toyota', model: 'Corolla' }] });
    assert.equal(res.code, 200, scenario.key);
    assert.deepEqual(ui.rpc.at(-1).body, PREVIOUS[scenario.key], scenario.key);
    assert.ok(PREVIOUS[scenario.key].p_value_json.wishlist && PREVIOUS[scenario.key].p_value_json.confirmedWishlists && !PREVIOUS[scenario.key].p_value_json.mode);
  }
});

test('resumo usa o estado depois da marcação: ficha que passa de um modo para dois', async () => {
  // CARRO vem da Ref (Honda Civic 2020 a 2022) e a ficha tinha um critério genérico (Kia Soul).
  // Com um modo só o genérico era a fonte; ao marcar VALOR a ficha passa a ter dois modos e o
  // CARRO passa a vir da Ref. O resumo tem de mostrar o que BUSCAS mostra depois, não o de antes.
  const carroRun = { id: 'c1', created_at: '2026-09-28T10:00:00Z', dados: { sid: 's-find-9', ref: 'HCAR2', evento: 'busca', logical_mode: 'CARRO', marca: 'Honda', modelo: 'Civic', ano_de: 2020, ano_ate: 2022, milhas_de: 1000, milhas_ate: 60000 } };
  const journey = { id: JOURNEY, contact_id: CONTACT, reference_code: 'HCAR2', status: 'ATIVO', stage: 'NOVO', criteria_json: { wishlists: [{ make: 'Kia', model: 'Soul', yearMin: 2018, yearMax: 2019 }], wishlistOverride: true }, vehicle_text: 'Kia Soul' };
  const ui = panel({ journey: () => journey, calcRuns: [carroRun] });
  const res = await ui.call({ messageId: MESSAGES[0], mode: 'VALOR', wishlists: [SAAB] });
  assert.equal(res.code, 200, JSON.stringify(res.payload));
  const sent = ui.rpc.at(-1).body.p_value_json;
  assert.equal(sent.vehicleText, 'Por valor: Saab 9-3 · Por ano e milhagem: 2020–2022 Honda Civic');
  // What BUSCAS shows for the same state after the write.
  const after = { ...journey, criteria_json: { ...journey.criteria_json, mode_overrides: { VALOR: { wishlists: sent.modeWishlists, wishlistOverride: true } } } };
  const shown = domain.journeyDemands(after, domain.consolidateCalcRuns([carroRun]));
  assert.deepEqual(shown.find((demand) => demand.mode === 'CARRO').wishes.map((wish) => wish.model), ['Civic']);
  assert.ok(shown.some((demand) => demand.key.endsWith(':REVIEW_MANUAL')), 'o Kia Soul genérico vai para revisão, não para o resumo');
});

test('ficha com um modo só marcado com modo: resumo sem rótulo, só aquele modo', async () => {
  const carroRun = { id: 'c1', created_at: '2026-09-28T10:00:00Z', dados: { sid: 's-find-1', ref: 'HCAR2', evento: 'busca', logical_mode: 'CARRO', marca: 'Honda', modelo: 'Civic', ano_de: 2020, ano_ate: 2025, milhas_de: 50000, milhas_ate: 90000 } };
  const journey = { id: JOURNEY, contact_id: CONTACT, reference_code: 'HCAR2', status: 'ATIVO', stage: 'NOVO', criteria_json: {}, vehicle_text: 'Honda Civic' };
  const ui = panel({ journey: () => journey, calcRuns: [carroRun] });
  const res = await ui.call({ messageId: MESSAGES[0], mode: 'CARRO', wishlists: [SCION] });
  assert.equal(res.code, 200);
  const sent = ui.rpc.at(-1).body.p_value_json;
  assert.equal(sent.wishlist, undefined);
  assert.equal(sent.vehicleText, '2012–2014 Scion tC · 2020–2025 Honda Civic');
  assert.doesNotMatch(sent.vehicleText, /Por valor|Por ano e milhagem/);
});

test('8 · código novo com a RPC antiga: nada genérico, mas o vehicle_text ainda leva o carro (por isso a migração vai antes)', async () => {
  const bank = await database('20261002010000');
  const ui = panel({ journey: async () => ({ id: JOURNEY, contact_id: CONTACT, reference_code: null, status: 'ATIVO', stage: 'NOVO', ...(await bank.state()) }) });
  await ui.call({ messageId: MESSAGES[0], mode: 'CARRO', wishlists: [SCION] });
  await bank.apply(ui.rpc.at(-1).body);
  const after = await bank.state();
  assert.deepEqual(generic(after.criteria_json), [], 'sem value_json.wishlist o gatilho antigo não copia nada');
  assert.equal(after.criteria_json.mode_overrides.CARRO.wishlists[0].model, 'tC');
  assert.equal(after.vehicle_text, '2012–2014 Scion tC', 'a RPC antiga ainda grava p_value');
  await bank.db.close();
});

test('9 · RPC nova com o painel antigo: modo registrado, campos genéricos e vehicle_text intactos', async () => {
  const bank = await database();
  const body = PREVIOUS.painelAntigoComModo;
  assert.ok(body.p_value_json.wishlist && body.p_value_json.mode && !body.p_value_json.vehicleText, 'payload do painel antigo');
  await bank.apply(body);
  const after = await bank.state();
  assert.equal(after.criteria_json.mode_overrides.CARRO.wishlists[0].model, 'tC');
  assert.deepEqual(generic(after.criteria_json), []);
  assert.equal(after.vehicle_text, 'Veículo original');
  await bank.db.close();
});

test('migração: só o gatilho e a RPC, mesma assinatura, permissões e ordem de publicação no cabeçalho', () => {
  const sql = read('supabase/migrations/20261002010000_panel_marcacao_modo_campos_genericos.sql');
  assert.deepEqual([...sql.matchAll(/create or replace function ([a-z_.0-9]+)\(/g)].map((match) => match[1]), ['private.panel_sync_wishlist_declaration', 'public.panel_mark_message_fact_v2']);
  assert.match(sql, /upper\(coalesce\(new\.value_json ->> 'mode', ''\)\) not in \('CARRO', 'VALOR'\)/);
  assert.match(sql, /revoke all on function public\.panel_mark_message_fact_v2\([\s\S]*?\) from public, anon, authenticated;/);
  assert.match(sql, /grant execute on function public\.panel_mark_message_fact_v2\([\s\S]*?\) to service_role;/);
  assert.match(sql, /PUBLISH ORDER: this migration first/);
  const outside = sql.replace(/\$\$[\s\S]*?\$\$/g, '');
  assert.doesNotMatch(outside, /^\s*(update|delete|insert)\b/im, 'nenhuma linha reescrita fora das funções');
});

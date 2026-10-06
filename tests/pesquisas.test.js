'use strict';

// PESQUISAS com os handlers reais contra um banco PGlite com todas as migrações. Leitura das
// conversas pelo simulador local (fora de produção nunca há IA): nenhuma chamada paga e nenhuma
// mensagem enviada. Regra MCS: busca POR CARRO (veículo, ano e milhagem) ou POR VALOR (modelo e valor).
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');
const requests = require('../vehicle-requests');

const id = (n) => `6ca00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n, name, texts) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(10 + n)}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(30 + n)}','preview','WHATSAPP','${id(10 + n)}','wa:+1305555${String(n).padStart(4, '0')}','RESOLVED',false,now(),now(),now(),now());`,
  ...texts.map(([direction, text, auto], index) => `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at,is_automatic) values('${id(100 + n * 10 + index)}','preview','${id(30 + n)}','WHATSAPP','${direction}','${text}','x',now() - interval '${20 - index} days','p${n}${index}',1,'WHATSAPP_WEBHOOK',now(),${auto ? 'true' : 'false'});`)
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...person(1, 'Lucas', [['CUSTOMER', 'Hi, I am looking for a Honda CR-V 2019-2021 between 20,000 and 60,000 miles, up to $28,000'], ['MCS', 'Great, we will look'], ['CUSTOMER', 'No rush, I plan to buy in 4 months']]),
  ...person(2, 'Bia', [['CUSTOMER', 'Obrigado pelo retorno, até mais'], ['MCS', 'Hi, this is an automatic message from My Car Scout about a Toyota Camry', true]]),
  // Only a model: no search in either mode, visible with what is missing.
  ...person(3, 'Rafa', [['CUSTOMER', 'I want a Civic']]),
  ...person(4, 'Caio', [['CUSTOMER', 'Need a Ford F-150 2018-2020 with 30,000 to 90,000 miles, budget $30,000']]),
  // The first calculator flow, without "Ref:": vehicle, years and mileage (CARRO).
  ...person(5, 'Duda', [['CUSTOMER', 'Hello! I just sent a vehicle search request through My Car Scout\nYear range: 2018-2021\nVehicle: Toyota Camry\nMileage range: 25,000-80,000\nBudget: $25,000']]),
  ...person(6, 'Gabi', [['CUSTOMER', 'I need something with less than 60,000 miles']]),
  // Model and value, no mileage: VALOR (candidates, the value is never an MMR filter).
  ...person(7, 'Hugo', [['CUSTOMER', 'Looking for a Camry 2021 or newer, up to $20,000']]),
  ...person(8, 'Ivo', [['CUSTOMER', 'I need a car']]),
  ...person(9, 'Rui', [['CUSTOMER', 'I want a Civic, budget $18,000']]),
  ...person(10, 'Téo', [['CUSTOMER', 'Looking for a 2022 or 2023 Tahoe']]),
  ...person(11, 'Sil', [['CUSTOMER', 'Need an SUV under $25,000']]),
  // Model, years and mileage, no value: CARRO.
  ...person(12, 'Nina', [['CUSTOMER', 'Looking for a Toyota Camry 2019-2022 with under 50,000 miles']]),
  // Fichas with a search mode. CARRO by year and mileage without a bid (like the real Refs) is
  // ready; VALOR needs the official bid.
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(2)}','preview','Vera Valor','CALCULATOR',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,created_at,updated_at) values('${id(3)}','preview','${id(2)}','CALCULATOR','NOVO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Toyota', model: 'Camry' }], logical_modes: ['VALOR'] })}',2400000,now(),now());`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(4)}','preview','Caco Carro','CALCULATOR',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,reference_code,created_at,updated_at) values('${id(5)}','preview','${id(4)}','CALCULATOR','NOVO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Toyota', model: 'Camry', yearMin: 2018, yearMax: 2022, minMiles: 1000, maxMiles: 80000 }], logical_modes: ['CARRO'] })}','CARR2',now(),now());`,
  // Came in through WhatsApp (a linked customer message), so it is also a target of the batch.
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(60)}','preview','WHATSAPP','${id(4)}','wa:+13055560060','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(61)}','preview','${id(60)}','WHATSAPP','CUSTOMER','Ref CARR2','x',now(),'cc1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(61)}','${id(5)}','IMPORT',now());`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(6)}','preview','Vito Valor','CALCULATOR',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(7)}','preview','${id(6)}','CALCULATOR','NOVO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Toyota', model: 'Camry' }], logical_modes: ['VALOR'] })}',now(),now());`,
  // A CARRO ficha without mileage: needs the mileage, never a value.
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(9)}','preview','Eva Calculadora','CALCULATOR',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(8)}','preview','${id(9)}','CALCULATOR','NOVO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Toyota', model: 'Camry', yearMin: 2019 }], logical_modes: ['CARRO'] })}',now(),now());`,
  // Only a client who really wrote is a request (a calculator click is not contact): each of these
  // fichas has one customer message linked.
  ...[[2, 3, 70], [6, 7, 72], [9, 8, 74]].flatMap(([contact, journey, n]) => [
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(n)}','preview','WHATSAPP','${id(contact)}','wa:+130555700${n}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n + 1)}','preview','${id(n)}','WHATSAPP','CUSTOMER','Oi','x',now(),'w${n}',1,'WHATSAPP_WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(n + 1)}','${id(journey)}','IMPORT',now());`
  ])
].join('\n');

let backend;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const q = async (sql) => (await backend.db.query(sql)).rows;
const car = (vin, make, model, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make, model, trim: 'EX', miles: 30000, mmrCents: 2500000, lane: '2', run: vin.slice(-2), saleType: 'Simulcast', cleanTitle: true, odometerOk: true, ...extra } });
async function batch(cars, key, finalize = true) {
  const files = [{ name: key + '.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: key.repeat(32).slice(0, 32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: finalize ? 'finalize' : 'cancel', uploadId: started.payload.uploadId });
  return started.payload.uploadId;
}

test.before(async () => {
  backend = await createBackend({ seed });
  process.env.SUPABASE_URL = BASE;
  for (const key of ['OPENAI_API_KEY', 'SEARCH_EXTRACTION_AI_ENABLED', 'SEARCH_EXTRACTION_MODEL', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'D360_API_KEY', 'SEARCH_EXTRACTION_BUDGET_USD']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  // Active batch. The CR-V without MMR never counts; the F-150 only exists in a canceled batch.
  await batch([car('PESQ00000000000001', 'Honda', 'CR-V'), car('PESQ00000000000002', 'Honda', 'CR-V', { mmrCents: null }), car('PESQ00000000000003', 'Toyota', 'Camry'),
    car('PESQ00000000000004', 'Honda', 'Civic', { miles: 90000 }), car('PESQ00000000000005', 'Toyota', 'Camry', { year: 2022, miles: 70000 })], 'a');
  await batch([car('PESQ00000000000009', 'Ford', 'F-150')], 'c', false);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const read = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract', chatId: id(30 + n) });
    assert.equal(read.payload.provider, 'SIMULATED', JSON.stringify(read.payload));
  }
  const compared = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'compare' });
  assert.equal(compared.statusCode, 200, JSON.stringify(compared.payload));
});
test.after(async () => { if (backend) await backend.db.close(); });

const list = async () => (await call('pesquisas', '/api/panel/pesquisas')).payload;
const itemOf = (data, name) => data.items.filter((item) => item.person.name === name);

const detail = (item) => [item.state, item.completeness, item.searchMode, item.result, item.optionCount, item.lacksText];
const ready = (item) => [item.completeness, item.searchMode, item.result, item.optionCount];

test('1 · Ref CARRO por ano e milhagem, sem lance, fica pronta e com opções válidas', async () => {
  const [carro] = itemOf(await list(), 'Caco Carro');
  // Camry 2020 (30,000) and Camry 2022 (70,000) fit 2018-2022 and 1,000-80,000; both with valid MMR.
  assert.deepEqual(ready(carro), ['PRONTO', 'CARRO', 'COM_OPCOES', 2]);
  assert.equal(carro.stateLabel, 'PRONTO PARA BUSCAR · POR CARRO · COM OPÇÕES NO LOTE');
  assert.deepEqual(carro.lacks, {});
});

test('2 · a mesma Ref CARRO permite seleção, V1 e V2 pelo servidor', async () => {
  const key = `journey:${id(5)}:CARRO`;
  const matches = (await q(`select id from public.manheim_matches where journey_id = '${id(5)}' and logical_mode = 'CARRO' order by vin`)).map((row) => row.id);
  assert.equal(matches.length, 2, 'as duas opções do lote ativo');
  for (const matchId of matches) {
    const selected = await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'select', matchId });
    assert.equal(selected.statusCode, 200, JSON.stringify(selected.payload));
  }
  const v1 = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: id(5), matchIds: matches, demandKey: key });
  assert.equal(v1.statusCode, 201, JSON.stringify(v1.payload));
  const [shown] = (await q(`select c.id, c.vitrine_id from public.vitrine_cars c join public.vitrines v on v.id = c.vitrine_id where v.journey_id = '${id(5)}' order by c.created_at limit 1`));
  const [request] = await q(`insert into public.vitrine_requests(environment, vitrine_id, vitrine_car_id, request_kind) values ('preview', '${shown.vitrine_id}', '${shown.id}', 'BID') returning id`);
  const v2 = await call('vitrines', '/api/panel/vitrines', 'POST', { action: 'create_v2', requestId: request.id });
  assert.equal(v2.statusCode, 201, JSON.stringify(v2.payload));
  assert.deepEqual(backend.refused, [], 'nenhuma mensagem nem chamada externa');
});

test('3 · Ref VALOR sem lance continua PRECISA DETALHE · FALTA VALOR, sem comparação', async () => {
  const data = await list();
  const [vito] = itemOf(data, 'Vito Valor');
  assert.deepEqual(detail(vito), ['PRECISA_DETALHE', 'PRECISA_DETALHE', null, null, null, 'Falta valor']);
  assert.equal(vito.stateLabel, 'PRECISA DETALHE · FALTA VALOR');
  assert.deepEqual(await q(`select 1 from public.vehicle_request_checks where request_key like 'ficha:journey:${id(7)}%'`), []);
  // With the official bid, VALOR is ready and compared by the official calculation.
  const [vera] = itemOf(data, 'Vera Valor');
  assert.deepEqual(ready(vera), ['PRONTO', 'VALOR', 'COM_OPCOES', 2]);
});

test('4 · pedido sem Ref com modelo, ano e milhagem vira CARRO (valor não filtra MMR)', async () => {
  const data = await list();
  const [nina] = itemOf(data, 'Nina');
  assert.equal(nina.criteriaText, 'Toyota Camry · 2019 a 2022 · até 50,000 milhas');
  assert.deepEqual(ready(nina), ['PRONTO', 'CARRO', 'COM_OPCOES', 1], 'só o Camry 2020 com 30,000 milhas');
  // Calculator text without Ref and a conversation with a value too: still CARRO, the value is
  // recorded but never filters the MMR (the CR-V without MMR never counts).
  // Duda (2018-2021): the Camry 2020 and the Camry 2022 (one year out, widened search), one list.
  assert.deepEqual(ready(itemOf(data, 'Duda')[0]), ['PRONTO', 'CARRO', 'COM_OPCOES', 2]);
  assert.deepEqual(ready(itemOf(data, 'Lucas')[0]), ['PRONTO', 'CARRO', 'COM_OPCOES', 1]);
  assert.deepEqual(ready(itemOf(data, 'Caio')[0]), ['PRONTO', 'CARRO', 'SEM_OPCAO', 0], 'o F-150 do lote cancelado não conta');
});

test('5 · pedido sem Ref com modelo e orçamento vira VALOR (candidatos, valor a conferir)', async () => {
  const data = await list();
  const [rui] = itemOf(data, 'Rui');
  assert.equal(rui.criteriaText, 'Honda Civic (marca pelo modelo) · até US$ 18,000');
  assert.deepEqual(ready(rui), ['PRONTO', 'VALOR', 'SEM_OPCAO', 0]);
  assert.equal(rui.optionCount, 0, 'orçamento é aplicado pela faixa de MMR');
  // Camry 2022 with MMR US$ 25,000 above the US$ 20,000: the value is not an MMR ceiling.
  // 2021 or newer, widened by one year: the Camry 2020 joins the same list.
  assert.deepEqual(ready(itemOf(data, 'Hugo')[0]), ['PRONTO', 'CARRO', 'COM_OPCOES', 2]);
});

test('6 · nenhum pedido por ano e milhagem fica parado por falta de valor', async () => {
  const data = await list();
  const carro = data.items.filter((item) => item.mode === 'CARRO' || item.searchMode === 'CARRO' || (item.lacks && item.lacks.CARRO));
  assert.ok(carro.length >= 7);
  assert.deepEqual(carro.filter((item) => /valor/i.test(item.lacksText || '') && !(item.lacks && item.lacks.VALOR)), [], 'CARRO nunca pede valor');
  // A CARRO ficha without mileage needs the mileage, not a value.
  assert.deepEqual(itemOf(data, 'Eva Calculadora').map((item) => [item.state, item.lacksText]), [['COM_OPCOES', undefined]]);
});

test('7 · critérios insuficientes para os dois modos ficam PRECISA DETALHE, visíveis e sem comparação', async () => {
  const data = await list();
  const lacking = (name) => itemOf(data, name).map((item) => [item.state, item.searchMode, item.optionCount, item.lacksText]);
  assert.deepEqual(lacking('Rafa'), [['PRECISA_DETALHE', null, null, 'Para buscar por carro falta ano ou milhagem; para buscar por valor falta valor']]);
  assert.deepEqual(lacking('Téo'), [['SEM_OPCAO', 'CARRO', 0, null]]);
  assert.deepEqual(lacking('Sil'), [['PRECISA_DETALHE', null, null, 'Para buscar por carro falta modelo e ano ou milhagem; para buscar por valor falta modelo']]);
  assert.deepEqual(lacking('Gabi'), [['PRECISA_DETALHE', null, null, 'Para buscar por carro falta modelo; para buscar por valor falta modelo e valor']]);
  assert.deepEqual(itemOf(data, 'Ivo').map((item) => [item.criteriaText, item.state]), [['Veículo não informado', 'PRECISA_DETALHE']]);
  assert.deepEqual(itemOf(data, 'Rafa')[0].evidence.map((item) => item.text), ['I want a Civic']);
  assert.deepEqual(itemOf(data, 'Bia'), [], 'conversa sem pedido não vira busca');
  const compared = await q(`select r.chat_id from public.vehicle_request_checks c join public.vehicle_requests r on 'conversa:' || r.id = c.request_key`);
  const detailChats = [3, 6, 8, 11].map((n) => id(30 + n));
  assert.deepEqual(compared.filter((row) => detailChats.includes(row.chat_id)), []);
  const report = (await call('pesquisas', '/api/panel/pesquisas?view=audit')).payload;
  assert.deepEqual([report.ready, report.readyWithOptions, report.readyWithCandidates, report.readyWithoutOptions, report.needsDetail, report.review, report.conversationsWithoutRequest],
    [10, 7, 0, 3, 5, 0, 1]);
  assert.equal(report.allServed, false, 'não declara cobertura com pedido que precisa detalhe');
});

// ------------------------------------------------------------------ auditoria histórica (OpenAI)
// Production mode with a fake OpenAI: the provider is answered here, never on the network. Every
// other URL still goes to the simulated database (anything else is refused and recorded).
const openAiCalls = [];
async function asProduction(answer, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.openai.com/')) { const body = JSON.parse(init.body); openAiCalls.push(body); const [status, payload] = answer(body); return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } }); }
    return original(url, init);
  };
  Object.assign(process.env, { VERCEL_ENV: 'production', SEARCH_EXTRACTION_AI_ENABLED: '1', OPENAI_API_KEY: 'chave-de-teste', SEARCH_EXTRACTION_MODEL: 'gpt-6-luna' });
  try { return await fn(); } finally {
    globalThis.fetch = original;
    Object.assign(process.env, { VERCEL_ENV: 'preview' });
    for (const key of ['SEARCH_EXTRACTION_AI_ENABLED', 'OPENAI_API_KEY', 'SEARCH_EXTRACTION_MODEL']) delete process.env[key];
  }
}
const history = (action) => call('pesquisas', '/api/panel/pesquisas', 'POST', { action });
const usage = { prompt_tokens: 1000, completion_tokens: 100 };
const reply = (content) => [200, { choices: [{ message: { content } }], usage }];
const isTest = (body) => !body.response_format;
// New customer messages in the 12 conversations (the 13th, of a ficha, was never read by the audit).
const newMessages = async (tag) => { for (let n = 1; n <= 12; n += 1) await backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values(gen_random_uuid(),'preview','${id(30 + n)}','WHATSAPP','CUSTOMER','still looking ${tag}','x',now(),'${tag}${n}',1,'WHATSAPP_WEBHOOK',clock_timestamp());`); };
const outgoing = async () => (await q(`select (select count(*)::int from public.messages where direction <> 'CUSTOMER') mcs, (select count(*)::int from public.v1_sends) v1, (select count(*)::int from public.vitrines) vitrines`))[0];

test('8 · modelo indisponível: para antes de ler qualquer conversa e não tenta outro modelo', async () => {
  await newMessages('a');
  openAiCalls.length = 0;
  await asProduction(() => [404, { error: { code: 'model_not_found', message: 'The model does not exist' } }], async () => {
    const status = (await history('history_status')).payload;
    assert.deepEqual([status.provider, status.model, status.modelChecked, status.remaining > 0], ['OPENAI', 'gpt-6-luna', false, true]);
    const check = (await history('model_check')).payload;
    assert.deepEqual([check.ok, check.error], [false, 'OPENAI_MODEL_UNAVAILABLE']);
    const refused = await history('extract_history');
    assert.deepEqual([refused.statusCode, refused.payload.error], [409, 'MODEL_NOT_CHECKED']);
  });
  // One minimal call, no customer data, the same model; no conversation was sent or read.
  assert.equal(openAiCalls.length, 1);
  assert.deepEqual([openAiCalls[0].model, openAiCalls[0].messages.length, /Teste de disponibilidade/.test(openAiCalls[0].messages[0].content)], ['gpt-6-luna', 1, true]);
  assert.doesNotMatch(JSON.stringify(openAiCalls[0]), /still looking|Civic|Camry/);
  assert.deepEqual(await q(`select stopped_reason, conversations from public.vehicle_request_batches where provider = 'OPENAI'`), [{ stopped_reason: 'MODEL_UNAVAILABLE', conversations: 0 }]);
  assert.deepEqual(await q(`select 1 from public.vehicle_request_runs where provider = 'OPENAI'`), []);
});

test('9 · teste do modelo aprovado, lotes de 10 e retomada sem ler duas vezes', async () => {
  openAiCalls.length = 0;
  await asProduction((body) => isTest(body) ? reply('ok') : reply(JSON.stringify({ hasRequest: false, requests: [] })), async () => {
    const check = (await history('model_check')).payload;
    assert.deepEqual([check.ok, check.model, check.usage], [true, 'gpt-6-luna', { input: 1000, output: 100 }]);
    assert.equal(check.costUsd, 0.00015, '1.000 × US$ 0,10/M + 100 × US$ 0,50/M');
    const first = (await history('extract_history')).payload;
    assert.deepEqual([first.read, first.remaining, first.processed, first.total, first.stoppedReason], [10, 6, 10, 16, null]);
    // The tab closes here; the next click continues from the recorded point.
    const second = (await history('extract_history')).payload;
    assert.deepEqual([second.read, second.remaining, second.processed], [6, 0, 16]);
    const third = (await history('extract_history')).payload;
    assert.deepEqual([third.read, third.remaining], [0, 0]);
    assert.equal(third.spentUsd, 0.00255, 'teste + 16 leituras de US$ 0,00015');
  });
  assert.equal(openAiCalls.filter(isTest).length, 1, 'uma única chamada de teste');
  assert.equal(openAiCalls.filter((body) => !isTest(body)).length, 16, 'cada conversa lida uma vez');
  assert.deepEqual(await q(`select count(distinct chat_id)::int chats, count(*)::int runs from public.vehicle_request_runs where provider = 'OPENAI'`), [{ chats: 16, runs: 16 }]);
});

test('10 · saldo pré-pago: sem teto próprio (US$ 50 gastos não param), mas para antes de uma chamada que passe do saldo informado', async () => {
  await newMessages('b');
  // US$ 49.995 already spent by PESQUISAS: no ceiling of its own any more.
  await backend.db.exec(`insert into public.vehicle_request_runs(environment,chat_id,provider,model,rule_version,input_hash,status,cost_usd) values('preview','${id(31)}','OPENAI','gpt-6-luna','manual','${'f'.repeat(64)}','DONE',49.995)`);
  // The owner informed US$ 0.00 left in the OpenAI console.
  await backend.db.query("select public.panel_ai_set_balance('preview','OPENAI',0,null)");
  openAiCalls.length = 0;
  await asProduction(() => reply(JSON.stringify({ hasRequest: false, requests: [] })), async () => {
    const stopped = (await history('extract_history')).payload;
    assert.deepEqual([stopped.stoppedReason, stopped.read, stopped.remaining > 0], ['PROVIDER_LIMIT', 0, true]);
  });
  assert.equal(openAiCalls.length, 0, 'nenhuma chamada sem saldo');
  await backend.db.query("select public.panel_ai_set_balance('preview','OPENAI',100,null)");
});

test('11 · zero mensagens: nada enviado, nenhuma V1 e nada fora do banco e da OpenAI simulada', async () => {
  const before = await outgoing();
  assert.deepEqual([before.v1, before.vitrines], [0, 2], 'só as V1/V2 criadas no teste 2');
  assert.equal(before.mcs, 2, 'só as mensagens da MCS da semeadura');
  assert.deepEqual(backend.refused, [], 'nenhuma chamada ao 360dialog nem a outro endereço');
});

test('12 · rotina sem limite de quantidade: lê todas as pendentes no ciclo, quem escreveu por último primeiro, em paralelo', async () => {
  await backend.db.exec(`delete from public.vehicle_request_runs where cost_usd = 49.995`);
  // Chat 1 wrote last, chat 12 first: the reading starts with chat 1.
  for (let n = 12; n >= 1; n -= 1) await backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values(gen_random_uuid(),'preview','${id(30 + n)}','WHATSAPP','CUSTOMER','still looking c${n}','x',now(),'c${n}',1,'WHATSAPP_WEBHOOK',clock_timestamp());`);
  openAiCalls.length = 0;
  const pesquisas = require('../api/panel/pesquisas');
  const ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: null } };
  let running = 0, peak = 0;
  const out = await asProduction((body) => [200, { choices: [{ message: { content: JSON.stringify({ hasRequest: false, requests: [] }) } }], usage }], async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('https://api.openai.com/')) return original(url, init);
      running += 1; peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { return await original(url, init); } finally { running -= 1; }
    };
    try { return await pesquisas.extractHistory(ctx, Infinity, { deadlineAt: Date.now() + 30000, concurrency: 4 }); } finally { globalThis.fetch = original; }
  });
  assert.equal(out.read, 12, 'as 12 pendentes num ciclo só (antes eram 5)');
  assert.equal(out.remaining, 0);
  assert.ok(peak > 1 && peak <= 4, 'em paralelo, no máximo 4 ao mesmo tempo: ' + peak);
  // Four run at once, so the newest is among the first four started (never left for last).
  const firstWave = openAiCalls.filter((body) => body.response_format).slice(0, 4).map((body) => JSON.stringify(body));
  assert.ok(firstWave.some((body) => /still looking c1\b/.test(body)), 'quem escreveu por último entra na primeira leva');
  assert.ok(!firstWave.some((body) => /still looking c12\b/.test(body)), 'a mais antiga não entra na primeira leva');
  assert.deepEqual(backend.refused, []);
});

test('13 · só entra quem mandou mensagem e ainda é trabalhado: ficha sem mensagem e "não é lead" ficam fora', async () => {
  const criteria = JSON.stringify({ wishlists: [{ make: 'Toyota', model: 'Camry', yearMin: 2018, yearMax: 2022, minMiles: 1000, maxMiles: 80000 }], logical_modes: ['CARRO'] });
  for (const sql of [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(90)}','preview','Silvio Sem Mensagem','CALCULATOR',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(91)}','preview','${id(90)}','CALCULATOR','NOVO','ATIVO','${criteria}',now(),now());`,
    `insert into public.contacts(id,environment,display_name,source,is_lead,created_at,updated_at) values('${id(92)}','preview','Nina Nao Lead','CALCULATOR',false,now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(93)}','preview','${id(92)}','CALCULATOR','NOVO','ATIVO','${criteria}',now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(94)}','preview','WHATSAPP','${id(92)}','wa:+13055700094','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(95)}','preview','${id(94)}','WHATSAPP','CUSTOMER','Oi','x',now(),'w95',1,'WHATSAPP_WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(95)}','${id(93)}','IMPORT',now());`
  ]) await q(sql);
  const data = await list();
  assert.deepEqual(itemOf(data, 'Silvio Sem Mensagem'), [], 'clique na calculadora não é contato');
  assert.deepEqual(itemOf(data, 'Nina Nao Lead'), [], 'marcado como "não é lead"');
  assert.equal(itemOf(data, 'Caco Carro').length, 1, 'quem escreveu continua');
});

test('14 · leitura que falhou (tempo esgotado) é tentada de novo, até 3 vezes; depois espera mensagem nova', async () => {
  const pesquisas = require('../api/panel/pesquisas');
  const ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: null } };
  const write = (text) => backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values(gen_random_uuid(),'preview','${id(31)}','WHATSAPP','CUSTOMER','${text}','x',now(),'r${text.length}${Date.now()}',1,'WHATSAPP_WEBHOOK',clock_timestamp());`);
  const ok = () => [200, { choices: [{ message: { content: JSON.stringify({ hasRequest: false, requests: [] }) } }], usage }];
  const fail = () => [500, { error: { message: 'upstream timeout' } }];
  const run = (reply) => asProduction(reply, () => pesquisas.extractHistory(ctx, Infinity, { deadlineAt: Date.now() + 30000, concurrency: 1 }));
  const calls = () => openAiCalls.filter((body) => body.response_format).length;
  await write('still need it');
  // Each attempt is one or more provider calls (the reader may retry inside one attempt).
  const attempt = async (reply) => { const before = calls(); const out = await run(reply); return { called: calls() - before, out }; };
  let step = await attempt(fail);
  assert.ok(step.called > 0);
  assert.ok(step.out.remaining >= 1, 'a falha continua pendente');
  step = await attempt(fail);
  assert.ok(step.called > 0, 'antes da correção: nenhuma nova tentativa e "Faltam 1" para sempre');
  step = await attempt(fail);
  assert.ok(step.called > 0);
  assert.equal(step.out.remaining, 0, 'depois de 3 falhas sai da conta de pendentes');
  step = await attempt(ok);
  assert.equal(step.called, 0, 'não paga uma 4ª tentativa do mesmo conteúdo');
  // A new customer message is new content: read again normally.
  await write('any update on the car');
  step = await attempt(ok);
  assert.equal(step.called, 1);
  assert.equal(step.out.remaining, 0);
  assert.deepEqual(backend.refused, []);
});

test('15 · leitura só começa com tempo para terminar dentro do limite da função', async () => {
  const pesquisas = require('../api/panel/pesquisas');
  const ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: null } };
  await backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values(gen_random_uuid(),'preview','${id(32)}','WHATSAPP','CUSTOMER','still there?','x',now(),'t15',1,'WHATSAPP_WEBHOOK',clock_timestamp());`);
  const ok = () => [200, { choices: [{ message: { content: JSON.stringify({ hasRequest: false, requests: [] }) } }], usage }];
  const before = openAiCalls.length;
  // 5 s to the deadline = 13 s until the hard stop: less than a reading needs, nothing starts.
  const tight = await asProduction(ok, () => pesquisas.extractHistory(ctx, Infinity, { deadlineAt: Date.now() + 5000, concurrency: 1 }));
  assert.equal(openAiCalls.length, before, 'sem tempo, não começa (nem paga) uma leitura');
  assert.ok(tight.remaining >= 1);
  const roomy = await asProduction(ok, () => pesquisas.extractHistory(ctx, Infinity, { deadlineAt: Date.now() + 30000, concurrency: 1 }));
  assert.ok(openAiCalls.length > before);
  assert.equal(roomy.remaining, 0);
});

test('16 · Comparar leva o pedido da conversa para a ficha sem carro e os carros aparecem em OPÇÕES', async () => {
  // Ficha de WhatsApp sem carro; o cliente pediu o carro na conversa ligada a ela.
  for (const sql of [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(200)}','preview','Olga Conversa','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(201)}','preview','${id(200)}','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());`,
    `insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at) select 'preview','${id(201)}',k,'ponto '||k,'OPEN'::public.panel_checklist_status,now(),now() from generate_series(1,6) k;`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(202)}','preview','WHATSAPP','${id(200)}','wa:+13055700202','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(203)}','preview','${id(202)}','WHATSAPP','CUSTOMER','Looking for a Toyota Camry 2019 or newer with under 50,000 miles','x',now(),'olga1',1,'WHATSAPP_WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(203)}','${id(201)}','IMPORT',now());`
  ]) await q(sql);
  const read = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract', chatId: id(202) });
  assert.equal(read.statusCode, 200, JSON.stringify(read.payload));
  const before = itemOf(await list(), 'Olga Conversa');
  assert.ok(before.length >= 1);
  assert.equal(before[0].person.journeyId, id(201), 'o pedido da conversa conhece a ficha');
  let round = (await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'compare' })).payload;
  for (let n = 0; n < 5 && round.remaining; n += 1) round = (await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'compare' })).payload;
  assert.equal(round.carried, 0, 'pedido versionado já participa da demanda sem copiar para a ficha');
  // The versioned request reaches the live demand without duplicating its criteria in the ficha.
  const [ficha] = await q(`select criteria_json from public.journeys where id = '${id(201)}'`);
  assert.deepEqual(ficha.criteria_json, {});
  // OPÇÕES: o Camry 2020 com 30,000 mi entra; o 2022 com 70,000 mi não.
  const matches = await q(`select vin from public.manheim_matches where demand_key = 'journey:${id(201)}:CARRO' and undone_at is null order by vin`);
  assert.deepEqual(matches.map((row) => row.vin), ['PESQ00000000000003']);
  assert.equal((await q(`select count(*)::int n from public.manheim_demand_syncs where demand_key = 'journey:${id(201)}:CARRO'`))[0].n, 1);
  // Clicar de novo não grava nem compara de novo o mesmo critério.
  const again = (await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'compare' })).payload;
  assert.equal(again.carried, 0);
  assert.equal(again.options && again.options.stale, 0, JSON.stringify(again.options));
  assert.deepEqual(backend.refused, [], 'nada enviado nem chamado fora');
});

test('17 · A10: a ficha oferece só carros do lote ativo, os mesmos de OPÇÕES (lote antigo fica fora)', async () => {
  // A newer batch becomes the active one; the first batch is still "live" (60 days) but older.
  await batch([car('PESQ00000000000010', 'Toyota', 'Camry', { year: 2021, miles: 40000 })], 'd');
  const res = await call('lead', '/api/panel/lead?id=' + id(5));
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload).slice(0, 300));
  const vins = (res.payload.offers || []).map((offer) => offer.vin);
  assert.ok(vins.includes('PESQ00000000000010'), 'o carro do lote ativo aparece: ' + JSON.stringify(vins));
  assert.ok(!vins.includes('PESQ00000000000003'), 'o carro do lote anterior não aparece');
});

test('17b · AUD-001 #46: a ficha não oferece nem conta carro com a venda já encerrada', async () => {
  const ended = new Date(Date.now() - 86400000).toISOString(), open = new Date(Date.now() + 3 * 86400000).toISOString();
  await batch([
    car('PESQ00000000000020', 'Toyota', 'Camry', { year: 2021, miles: 35000, endsAt: open }),
    car('PESQ00000000000021', 'Toyota', 'Camry', { year: 2021, miles: 36000, endsAt: ended })
  ], 'e');
  const res = await call('lead', '/api/panel/lead?id=' + id(5));
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload).slice(0, 300));
  const vins = (res.payload.offers || []).map((offer) => offer.vin);
  assert.ok(vins.includes('PESQ00000000000020'), 'a venda ainda aberta aparece: ' + JSON.stringify(vins));
  assert.ok(!vins.includes('PESQ00000000000021'), 'a venda encerrada não aparece: ' + JSON.stringify(vins));
  const realityVins = JSON.stringify(res.payload.reality || {});
  assert.ok(!realityVins.includes('PESQ00000000000021'), 'nem no cartão Realidade');
});

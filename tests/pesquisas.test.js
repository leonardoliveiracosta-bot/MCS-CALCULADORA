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
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(8)}','preview','${id(9)}','CALCULATOR','NOVO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Toyota', model: 'Camry', yearMin: 2019 }], logical_modes: ['CARRO'] })}',now(),now());`
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
  assert.deepEqual(ready(itemOf(data, 'Duda')[0]), ['PRONTO', 'CARRO', 'COM_OPCOES', 1]);
  assert.deepEqual(ready(itemOf(data, 'Lucas')[0]), ['PRONTO', 'CARRO', 'COM_OPCOES', 1]);
  assert.deepEqual(ready(itemOf(data, 'Caio')[0]), ['PRONTO', 'CARRO', 'SEM_OPCAO', 0], 'o F-150 do lote cancelado não conta');
});

test('5 · pedido sem Ref com modelo e orçamento vira VALOR (candidatos, valor a conferir)', async () => {
  const data = await list();
  const [rui] = itemOf(data, 'Rui');
  assert.equal(rui.criteriaText, 'Honda Civic (marca pelo modelo) · até US$ 18,000');
  assert.deepEqual(ready(rui), ['PRONTO', 'VALOR', 'COM_CANDIDATOS', 1]);
  assert.equal(rui.stateLabel, 'PRONTO PARA BUSCAR · POR VALOR · CANDIDATOS NO LOTE · VALOR A CONFERIR');
  // Camry 2022 with MMR US$ 25,000 above the US$ 20,000: the value is not an MMR ceiling.
  assert.deepEqual(ready(itemOf(data, 'Hugo')[0]), ['PRONTO', 'VALOR', 'COM_CANDIDATOS', 1]);
});

test('6 · nenhum pedido por ano e milhagem fica parado por falta de valor', async () => {
  const data = await list();
  const carro = data.items.filter((item) => item.mode === 'CARRO' || item.searchMode === 'CARRO' || (item.lacks && item.lacks.CARRO));
  assert.ok(carro.length >= 7);
  assert.deepEqual(carro.filter((item) => /valor/i.test(item.lacksText || '') && !(item.lacks && item.lacks.VALOR)), [], 'CARRO nunca pede valor');
  // A CARRO ficha without mileage needs the mileage, not a value.
  assert.deepEqual(itemOf(data, 'Eva Calculadora').map((item) => [item.state, item.lacksText]), [['PRECISA_DETALHE', 'Falta milhagem']]);
});

test('7 · critérios insuficientes para os dois modos ficam PRECISA DETALHE, visíveis e sem comparação', async () => {
  const data = await list();
  const lacking = (name) => itemOf(data, name).map((item) => [item.state, item.searchMode, item.optionCount, item.lacksText]);
  assert.deepEqual(lacking('Rafa'), [['PRECISA_DETALHE', null, null, 'Para buscar por carro falta ano e milhagem; para buscar por valor falta valor']]);
  assert.deepEqual(lacking('Téo'), [['PRECISA_DETALHE', null, null, 'Para buscar por carro falta milhagem; para buscar por valor falta valor']]);
  assert.deepEqual(lacking('Sil'), [['PRECISA_DETALHE', null, null, 'Para buscar por carro falta modelo, ano e milhagem; para buscar por valor falta modelo']]);
  assert.deepEqual(lacking('Gabi'), [['PRECISA_DETALHE', null, null, 'Para buscar por carro falta modelo e ano; para buscar por valor falta modelo e valor']]);
  assert.deepEqual(itemOf(data, 'Ivo').map((item) => [item.criteriaText, item.state]), [['Veículo não informado', 'PRECISA_DETALHE']]);
  assert.deepEqual(itemOf(data, 'Rafa')[0].evidence.map((item) => item.text), ['I want a Civic']);
  assert.deepEqual(itemOf(data, 'Bia'), [], 'conversa sem pedido não vira busca');
  const compared = await q(`select r.chat_id from public.vehicle_request_checks c join public.vehicle_requests r on 'conversa:' || r.id = c.request_key`);
  const detailChats = [3, 6, 8, 10, 11].map((n) => id(30 + n));
  assert.deepEqual(compared.filter((row) => detailChats.includes(row.chat_id)), []);
  const report = (await call('pesquisas', '/api/panel/pesquisas?view=audit')).payload;
  assert.deepEqual([report.ready, report.readyWithOptions, report.readyWithCandidates, report.readyWithoutOptions, report.needsDetail, report.review, report.conversationsWithoutRequest],
    [8, 5, 2, 1, 7, 0, 1]);
  assert.equal(report.allServed, false, 'não declara cobertura com pedido que precisa detalhe');
});

test('8 · orçamento da leitura: até US$ 50 por provedor, não US$ 2', async () => {
  const search = require('../panel-search-requests');
  assert.equal(search.PROVIDER_LIMIT_USD.OPENAI, 50);
  // A conversation with a new customer message is pending again.
  await backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(990)}','preview','${id(32)}','WHATSAPP','CUSTOMER','Also a Corolla','x',now(),'nova',1,'WHATSAPP_WEBHOOK',now() + interval '1 minute');`);
  const spent = (usd) => backend.db.exec(`insert into public.vehicle_request_runs(environment,chat_id,provider,model,rule_version,input_hash,status,cost_usd) values('preview','${id(31)}','OPENAI','gpt-6-luna','manual','${String(usd).padStart(64, 'a')}','DONE',${usd})`);
  Object.assign(process.env, { VERCEL_ENV: 'production', SEARCH_EXTRACTION_AI_ENABLED: '1', OPENAI_API_KEY: 'chave-de-teste', SEARCH_EXTRACTION_MODEL: 'gpt-6-luna' });
  try {
    // US$ 3 already spent (above the old US$ 2): the batch still reads. The request never leaves
    // the test (the network is blocked), so nothing is paid.
    await spent(3);
    const going = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract_history' });
    assert.deepEqual([going.statusCode, going.payload.provider, going.payload.providerLimitUsd, going.payload.stoppedReason], [200, 'OPENAI', 50, null]);
    assert.ok(backend.refused.some((url) => url.startsWith('https://api.openai.com')), 'tentou ler: o teto de US$ 2 não existe');
    // US$ 50 reached: stops safely before reading, the rest stays pending.
    await spent(47);
    const refusedBefore = backend.refused.length;
    const stopped = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract_history' });
    assert.deepEqual([stopped.payload.stoppedReason, stopped.payload.read, stopped.payload.remaining > 0], ['PROVIDER_LIMIT', 0, true]);
    assert.equal(backend.refused.length, refusedBefore, 'nenhuma nova chamada depois do limite');
    const batches = await q(`select provider, model, stopped_reason from public.vehicle_request_batches where provider = 'OPENAI' order by created_at`);
    assert.deepEqual(batches.map((row) => [row.provider, row.model, row.stopped_reason]), [['OPENAI', 'gpt-6-luna', null], ['OPENAI', 'gpt-6-luna', 'PROVIDER_LIMIT']]);
  } finally {
    Object.assign(process.env, { VERCEL_ENV: 'preview' });
    for (const key of ['SEARCH_EXTRACTION_AI_ENABLED', 'OPENAI_API_KEY', 'SEARCH_EXTRACTION_MODEL']) delete process.env[key];
  }
});

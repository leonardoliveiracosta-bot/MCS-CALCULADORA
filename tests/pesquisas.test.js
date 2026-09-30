'use strict';

// PESQUISAS com os handlers reais contra um banco PGlite com todas as migrações. Leitura das
// conversas pelo simulador local (fora de produção nunca há IA): nenhuma chamada paga e nenhuma
// mensagem enviada. Regra MCS: só há busca com modelo + valor + ano ou milhagem.
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
  // Only a model: no search (MCS rule), visible with what is missing.
  ...person(3, 'Rafa', [['CUSTOMER', 'I want a Civic']]),
  ...person(4, 'Caio', [['CUSTOMER', 'Need a Ford F-150 2018-2020 with 30,000 to 90,000 miles, budget $30,000']]),
  // The first calculator flow, without "Ref:", with model, value and limits: ready.
  ...person(5, 'Duda', [['CUSTOMER', 'Hello! I just sent a vehicle search request through My Car Scout\nYear range: 2018-2021\nVehicle: Toyota Camry\nMileage range: 25,000-80,000\nBudget: $25,000']]),
  ...person(6, 'Gabi', [['CUSTOMER', 'I need something with less than 60,000 miles']]),
  // Ready with a year on one side only; the value is below the MMR and still no ceiling.
  ...person(7, 'Hugo', [['CUSTOMER', 'Looking for a Camry 2021 or newer, up to $20,000']]),
  ...person(8, 'Ivo', [['CUSTOMER', 'I need a car']]),
  ...person(9, 'Rui', [['CUSTOMER', 'I want a Civic, budget $18,000']]),
  ...person(10, 'Téo', [['CUSTOMER', 'Looking for a 2022 or 2023 Tahoe']]),
  ...person(11, 'Sil', [['CUSTOMER', 'Need an SUV under $25,000']]),
  // A calculator ficha without Ref and without value: needs detail.
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
const car = (vin, make, model, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make, model, trim: 'EX', miles: 30000, mmrCents: 2500000, cleanTitle: true, odometerOk: true, ...extra } });
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
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const read = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract', chatId: id(30 + n) });
    assert.equal(read.payload.provider, 'SIMULATED', JSON.stringify(read.payload));
  }
  const compared = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'compare' });
  assert.equal(compared.statusCode, 200, JSON.stringify(compared.payload));
});
test.after(async () => { if (backend) await backend.db.close(); });

const list = async () => (await call('pesquisas', '/api/panel/pesquisas')).payload;
const itemOf = (data, name) => data.items.filter((item) => item.person.name === name);

const detail = (item) => [item.state, item.completeness, item.result, item.optionCount, item.lacks];

test('1 · "Civic" sozinho fica PRECISA DETALHE, visível e sem comparação', async () => {
  const [rafa] = itemOf(await list(), 'Rafa');
  assert.equal(rafa.source, 'CONVERSA');
  assert.equal(rafa.criteriaText, 'Honda Civic (marca pelo modelo)');
  assert.deepEqual(detail(rafa), ['PRECISA_DETALHE', 'PRECISA_DETALHE', null, null, ['valor', 'ano ou milhagem']]);
  assert.equal(rafa.stateLabel, 'PRECISA DETALHE');
  assert.deepEqual(rafa.evidence.map((item) => item.text), ['I want a Civic']);
  // Nothing of what needs detail was compared with the batch.
  const compared = await q(`select r.chat_id from public.vehicle_request_checks c join public.vehicle_requests r on 'conversa:' || r.id = c.request_key`);
  const detailChats = [3, 6, 8, 9, 10, 11].map((n) => id(30 + n));
  assert.deepEqual(compared.filter((row) => detailChats.includes(row.chat_id)), []);
});

test('2 · "Civic até US$ 18 mil" fica PRECISA DETALHE, faltando ano ou milhagem', async () => {
  const [rui] = itemOf(await list(), 'Rui');
  assert.equal(rui.criteriaText, 'Honda Civic (marca pelo modelo) · até US$ 18,000');
  assert.deepEqual(detail(rui), ['PRECISA_DETALHE', 'PRECISA_DETALHE', null, null, ['ano ou milhagem']]);
});

test('3 · "Tahoe 2022 ou 2023" fica PRECISA DETALHE, faltando valor', async () => {
  const [teo] = itemOf(await list(), 'Téo');
  assert.equal(teo.criteriaText, 'Chevrolet Tahoe (marca pelo modelo) · 2022 a 2023');
  assert.deepEqual(detail(teo), ['PRECISA_DETALHE', 'PRECISA_DETALHE', null, null, ['valor']]);
});

test('4 · "SUV até US$ 25 mil" fica PRECISA DETALHE, faltando modelo', async () => {
  const data = await list();
  const [sil] = itemOf(data, 'Sil');
  assert.equal(sil.criteriaText, 'SUV · até US$ 25,000');
  assert.deepEqual(detail(sil), ['PRECISA_DETALHE', 'PRECISA_DETALHE', null, null, ['modelo', 'ano ou milhagem']]);
  // The other cases without a search, each with exactly what is missing; none disappears.
  assert.deepEqual(itemOf(data, 'Gabi').map((item) => item.lacks), [['modelo', 'valor']]);
  assert.deepEqual(itemOf(data, 'Ivo').map((item) => [item.criteriaText, item.lacks]), [['Veículo não informado', ['modelo', 'valor', 'ano ou milhagem']]]);
  assert.deepEqual(itemOf(data, 'Eva Calculadora').map((item) => [item.source, item.state, item.lacks]), [['FICHA', 'PRECISA_DETALHE', ['valor']]]);
  assert.deepEqual(itemOf(data, 'Bia'), [], 'conversa sem pedido não vira busca');
});

test('5 · "Camry 2021+, até US$ 20 mil" fica PRONTO PARA BUSCAR; o valor não vira teto de MMR', async () => {
  const data = await list();
  const [hugo] = itemOf(data, 'Hugo');
  assert.equal(hugo.criteriaText, 'Toyota Camry (marca pelo modelo) · 2021 ou mais novo · até US$ 20,000');
  // Only the Camry 2022 (no upper year limit). Its MMR (US$ 25,000) is above the value, but the
  // value is not an MMR ceiling: without the official calculation it is a candidate to check.
  assert.deepEqual([hugo.completeness, hugo.result, hugo.optionCount, hugo.lacks], ['PRONTO', 'COM_CANDIDATOS', 1, []]);
  assert.equal(hugo.stateLabel, 'PRONTO PARA BUSCAR · CANDIDATOS NO LOTE · VALOR A CONFERIR');
  assert.deepEqual(hugo.missing, ['milhagem'], 'milhagem não informada: sem restrição');
  const [lucas] = itemOf(data, 'Lucas');
  assert.deepEqual([lucas.completeness, lucas.result, lucas.optionCount], ['PRONTO', 'COM_CANDIDATOS', 1], 'o CR-V sem MMR não conta');
  const [caio] = itemOf(data, 'Caio');
  assert.deepEqual([caio.completeness, caio.result, caio.optionCount], ['PRONTO', 'SEM_OPCAO', 0], 'o F-150 do lote cancelado não conta');
  const report = (await call('pesquisas', '/api/panel/pesquisas?view=audit')).payload;
  assert.deepEqual([report.ready, report.readyWithOptions, report.readyWithCandidates, report.readyWithoutOptions, report.needsDetail, report.review, report.conversationsWithoutRequest],
    [4, 0, 3, 1, 7, 0, 1]);
  assert.equal(report.allServed, false, 'não declara cobertura com pedido que precisa detalhe nem com candidato a conferir');
  assert.deepEqual(backend.refused, []);
});

test('6 · pedido da calculadora sem Ref, com os três elementos, fica PRONTO PARA BUSCAR', async () => {
  const [duda] = itemOf(await list(), 'Duda');
  assert.equal(duda.criteriaText, 'Toyota Camry · 2018 a 2021 · 25,000 a 80,000 milhas · até US$ 25,000');
  assert.deepEqual([duda.completeness, duda.result, duda.optionCount, duda.lacks], ['PRONTO', 'COM_CANDIDATOS', 1, []]);
  assert.deepEqual(requests.searchLacks({ make: 'Toyota', model: 'Camry', maxMiles: 50000, budgetUsd: 20000 }), [], 'milhagem sozinha basta como limite');
});

test('7 · orçamento da leitura: até US$ 50 por provedor, não US$ 2', async () => {
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

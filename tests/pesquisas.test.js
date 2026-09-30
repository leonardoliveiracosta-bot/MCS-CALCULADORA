'use strict';

// PESQUISAS com os handlers reais contra um banco PGlite com todas as migrações. Leitura das
// conversas pelo simulador local (fora de produção nunca há IA): nenhuma chamada paga e nenhuma
// mensagem enviada. Casos: pedido explícito vira busca com evidências; conversa sem pedido não
// vira; critério ausente não é inventado; sem opção continua visível; com opção válida; lote
// cancelado não conta.
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
  // Explicit request, buying in months (never a reason to leave the list).
  ...person(1, 'Lucas', [['CUSTOMER', 'Hi, I am looking for a Honda CR-V 2019-2021 between 20,000 and 60,000 miles'], ['MCS', 'Great, we will look'], ['CUSTOMER', 'No rush, I plan to buy in 4 months']]),
  // No vehicle request at all (the automatic message mentions cars and is ignored).
  ...person(2, 'Bia', [['CUSTOMER', 'Obrigado pelo retorno, até mais'], ['MCS', 'Hi, this is an automatic message from My Car Scout about a Toyota Camry', true]]),
  // Model without make: the make is never filled in.
  ...person(3, 'Rafa', [['CUSTOMER', 'I want a Civic, budget $18,000']]),
  // A request with no car in the active batch (the only F-150 is in a canceled batch).
  ...person(4, 'Caio', [['CUSTOMER', 'Need a Ford F-150 2018-2020 with 30,000 to 90,000 miles']])
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
  for (const key of ['OPENAI_API_KEY', 'SEARCH_EXTRACTION_AI_ENABLED', 'MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'D360_API_KEY']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  // Active batch: a CR-V that fits, a CR-V without MMR (never an option) and no F-150.
  await batch([car('PESQ00000000000001', 'Honda', 'CR-V'), car('PESQ00000000000002', 'Honda', 'CR-V', { mmrCents: null }), car('PESQ00000000000003', 'Toyota', 'Camry')], 'a');
  // Canceled while being assembled: its F-150 must never count.
  await batch([car('PESQ00000000000009', 'Ford', 'F-150')], 'c', false);
  for (const n of [1, 2, 3, 4]) {
    const read = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract', chatId: id(30 + n) });
    assert.equal(read.statusCode, 200, JSON.stringify(read.payload));
    assert.equal(read.payload.provider, 'SIMULATED');
  }
});
test.after(async () => { if (backend) await backend.db.close(); });

const list = async () => (await call('pesquisas', '/api/panel/pesquisas')).payload;
const itemOf = (data, name) => data.items.filter((item) => item.person.name === name);

test('pedido explícito vira busca com evidências; conversa sem pedido não vira', async () => {
  const data = await list();
  const [lucas] = itemOf(data, 'Lucas');
  assert.equal(lucas.source, 'CONVERSA');
  assert.equal(lucas.criteriaText, 'Honda CR-V · 2019 a 2021 · 20,000 a 60,000 milhas');
  assert.deepEqual(lucas.evidence.map((item) => item.text), ['Hi, I am looking for a Honda CR-V 2019-2021 between 20,000 and 60,000 miles']);
  assert.equal(lucas.state, 'FALTA_BUSCAR');
  assert.deepEqual(itemOf(data, 'Bia'), [], 'sem pedido, sem busca');
  const [run] = await q(`select status, provider, request_count from public.vehicle_request_runs where chat_id = '${id(32)}'`);
  assert.deepEqual([run.status, run.provider, run.request_count], ['NO_REQUEST', 'SIMULATED', 0]);
  // The same conversation again is never read (nor paid) twice.
  const again = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract', chatId: id(31) });
  assert.equal(again.payload.alreadyRead, true);
});

test('critério ausente não é inventado (nem pela IA)', async () => {
  const [rafa] = itemOf(await list(), 'Rafa');
  assert.equal(rafa.state, 'CRITERIOS_INSUFICIENTES');
  assert.equal(rafa.criteriaText, 'Civic · até US$ 18,000');
  assert.ok(rafa.missing.includes('marca'), JSON.stringify(rafa.missing));
  // An answer that names a make, a year and a budget the customer never wrote keeps none of them.
  const conversation = requests.conversationFor([{ id: 'm1', direction: 'CUSTOMER', body_text: 'I want a Civic, budget $18,000' }, { id: 'm2', direction: 'MCS', body_text: 'A Honda Civic 2020?' }]);
  const checked = requests.validateExtraction({ hasRequest: true, requests: [{ make: 'Honda', model: 'Civic', yearMin: 2020, yearMax: 2020, budgetUsd: 25000,
    evidence: { make: ['m2'], model: ['m1'], year: ['m1'], budget: ['m1'] }, confidence: 'alta' }] }, conversation);
  const [only] = checked.requests;
  assert.deepEqual(only.criteria, { model: 'Civic' });
  assert.equal(only.needsReview, true);
  assert.match(only.reviewReason, /marca, ano, orçamento/);
});

test('comparação com o lote ativo: com opção válida, sem opção continua visível, lote cancelado não conta', async () => {
  const compared = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'compare' });
  assert.equal(compared.statusCode, 200, JSON.stringify(compared.payload));
  const data = await list();
  const [lucas] = itemOf(data, 'Lucas');
  assert.deepEqual([lucas.state, lucas.optionCount], ['COM_OPCOES', 1], 'o CR-V sem MMR não conta');
  const [caio] = itemOf(data, 'Caio');
  assert.deepEqual([caio.state, caio.optionCount], ['SEM_OPCAO', 0], 'o F-150 do lote cancelado não conta');
  assert.equal(caio.stateLabel, 'SEM OPÇÃO NO LOTE');
  const checks = await q(`select c.request_key, c.result, c.option_count, u.activated_at is not null active from public.vehicle_request_checks c join public.manheim_uploads u on u.id = c.upload_id`);
  assert.ok(checks.length >= 2 && checks.every((row) => row.active), 'só o lote ativo foi comparado');
  // Nothing was sent and nothing paid.
  assert.equal((await q(`select count(*)::int n from public.messages where direction = 'MCS'`))[0].n, 2, 'só as duas mensagens da MCS da carga do teste');
  assert.deepEqual(backend.refused, []);
});

test('auditoria não declara cobertura sem prova', async () => {
  const report = (await call('pesquisas', '/api/panel/pesquisas?view=audit')).payload;
  assert.equal(report.extraction, 'SIMULADA');
  assert.equal(report.peopleWithMessages, 4);
  assert.equal(report.conversationsWithRequest, 3);
  assert.deepEqual([report.withOptions >= 1, report.withoutOptions >= 1, report.insufficient >= 1], [true, true, true]);
  assert.equal(report.trackingComplete, true, 'toda conversa lida e todo pedido comparado');
  assert.equal(report.allServed, false, 'há pedido sem opção e com critérios insuficientes');
});

test('produção com a flag desligada: nada é lido; o histórico retoma de onde parou', async () => {
  // Preview/test: the next unread conversations are read by the simulator, then nothing is left.
  const history = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract_history' });
  assert.deepEqual([history.statusCode, history.payload.remaining], [200, 0]);
  process.env.VERCEL_ENV = 'production';
  try {
    const off = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract_history' });
    assert.deepEqual([off.statusCode, off.payload.error, off.payload.extraction], [409, 'SEARCH_EXTRACTION_OFF', 'DESLIGADA']);
    const one = await call('pesquisas', '/api/panel/pesquisas', 'POST', { action: 'extract', chatId: id(31) });
    assert.deepEqual([one.payload.status, one.payload.skipped], ['DESLIGADA', true]);
  } finally { process.env.VERCEL_ENV = 'preview'; }
  assert.deepEqual(backend.refused, [], 'nenhuma chamada paga');
});

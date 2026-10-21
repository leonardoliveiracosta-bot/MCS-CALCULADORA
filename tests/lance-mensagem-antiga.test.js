'use strict';

// Modelo antigo da calculadora: a mensagem trazia "Maximum bid: $50,000" e não tinha a linha "Ref:", então a busca
// POR VALOR ficava sem lance e sem carro (25 fichas em produção, todas de 11 a 18/09, todas com marca e modelo).
// O painel passa a ler esse lance da mensagem ligada à ficha, só quando a ficha não tem lance nenhum.
// O caminho comum não muda: lance digitado, lance da ficha e POR CARRO ficam como estavam.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const batchRules = require('../panel-manheim-batch');
const { bidCentsFromText } = require('../panel-message-bid');
const { journeyDemands } = require('../panel-domain');

const id = (n) => `6c710000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const GLE = { make: 'Mercedes-Benz', model: 'GLE' };
const oldMessage = (bid) => ['Hi My Car Scout, here is my estimate', '', 'What I am looking for', 'Brand: Mercedes-Benz', 'Model: GLE', '', 'My estimate',
  'Maximum bid: ' + bid, 'Payment method: Financing', 'Register in Florida: No', 'ZIP code: 30238'].join('\n');
const J = { old: id(10), typed: id(20), budget: id(30), carro: id(40), short: id(50), none: id(60) };

function person(n, journey, criteria, body, budget = 'null') {
  const contact = id(n + 1), chat = id(n + 2), message = id(n + 3);
  return [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Cliente ${n}','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify(criteria)}',${budget},now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','lance-${n}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','${body}','x',now(),'lance-${n}',0,'WEBHOOK',now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`
  ].join('\n');
}
const valor = (extra = {}) => ({ mode_overrides: { VALOR: { wishlists: [{ ...GLE, trim: '', yearMin: null, yearMax: null, minMiles: null, maxMiles: null }], wishlistOverride: true, ...extra } } });
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  person(10, J.old, valor(), oldMessage('$50,000')),                         // o caso da Tiff
  person(20, J.typed, valor({ bidCents: 3000000 }), oldMessage('$50,000')),    // lance digitado vence
  person(30, J.budget, { wishlists: [{ make: 'Toyota', model: 'Camry' }], logical_modes: ['VALOR'] }, 'Quero um Camry', '2000000'), // caminho comum
  person(40, J.carro, { wishlists: [{ ...GLE, yearMin: 2020, yearMax: 2023 }], logical_modes: ['CARRO'] }, oldMessage('$50,000')), // POR CARRO nunca tem lance
  person(50, J.short, valor(), oldMessage('$45')),                            // "$45" é lido como US$ 45.000
  person(60, J.none, valor(), 'Oi, quero um GLE')                              // sem a mensagem antiga: continua sem lance
].join('\n');

let backend;
const ctx = { environment: 'preview', panel: { id: ACTOR }, config: { url: BASE, secretKey: 'secreta-simulada' } };
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const targets = async () => require('../panel-buscas-view').demandContext(await require('../panel-buscas').loadBuscasBase({ ...ctx })).targetByKey;

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.MANHEIM_MATCH_AUDIT_ENABLED; delete process.env.OPENAI_API_KEY; delete process.env.MANHEIM_OPENAI_ENABLED;
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
});
test.after(async () => { if (backend) await backend.db.close(); });

test('leitura do lance: os formatos das mensagens reais; texto que não é da calculadora não vira lance', () => {
  assert.equal(bidCentsFromText(oldMessage('$50,000')), 5000000);
  assert.equal(bidCentsFromText(oldMessage('$7,500')), 750000);
  assert.equal(bidCentsFromText(oldMessage('$40')), 4000000, '"40" é US$ 40.000');
  assert.equal(bidCentsFromText(oldMessage('40k')), 4000000);
  assert.equal(bidCentsFromText(oldMessage('$0')), null);
  assert.equal(bidCentsFromText(oldMessage('$2,000')), null, 'fora dos limites do "Salvar lance"');
  assert.equal(bidCentsFromText(oldMessage('$1,000,000')), null);
  assert.equal(bidCentsFromText('Lance máximo: US$ 40.000\nMy Car Scout · lance máximo'), 4000000);
  assert.equal(bidCentsFromText('Maximum bid: $50,000'), null, 'sem a marca da calculadora');
});

test('regra: o lance da mensagem só entra quando a ficha não tem lance; POR CARRO nunca', () => {
  const journey = (criteria, extra = {}) => ({ id: J.old, reference_code: 'X5TFW', criteria_json: criteria, budget_cents: null, ...extra });
  const [found] = journeyDemands(journey(valor(), { message_bid_cents: 5000000 }), []);
  assert.deepEqual([found.mode, found.bidCents, found.bidFromMessage, found.active, found.issues], ['VALOR', 5000000, true, true, []]);
  const [typed] = journeyDemands(journey(valor({ bidCents: 3000000 }), { message_bid_cents: 5000000 }), []);
  assert.deepEqual([typed.bidCents, typed.bidFromMessage], [3000000, undefined], 'o lance digitado vence');
  const [budget] = journeyDemands(journey({ wishlists: [GLE], logical_modes: ['VALOR'] }, { budget_cents: 2000000, message_bid_cents: 5000000 }), []);
  assert.deepEqual([budget.bidCents, budget.bidFromMessage], [2000000, undefined], 'o lance da ficha vence');
  const [carro] = journeyDemands(journey({ wishlists: [{ ...GLE, yearMin: 2020, yearMax: 2023 }], logical_modes: ['CARRO'] }, { message_bid_cents: 5000000 }), []);
  assert.deepEqual([carro.mode, carro.bidCents, carro.bidFromMessage], ['CARRO', null, undefined]);
  // Caminho comum: sem lance na mensagem, a demanda é idêntica à de antes (nenhum campo novo).
  for (const criteria of [valor(), valor({ bidCents: 3000000 }), { wishlists: [GLE], logical_modes: ['VALOR'] }]) {
    assert.deepEqual(journeyDemands(journey(criteria), []), journeyDemands({ ...journey(criteria), message_bid_cents: null }, []));
    assert.ok(journeyDemands(journey(criteria), []).every((demand) => !('bidFromMessage' in demand)));
  }
});

test('PESQUISAS e ENVIAR OPÇÕES: a ficha do modelo antigo ganha o lance; as outras ficam como estavam', async () => {
  const byKey = await targets();
  const pick = (journey, mode) => byKey.get(`journey:${journey}:${mode}`);
  assert.deepEqual([pick(J.old, 'VALOR').bidCents, pick(J.old, 'VALOR').reactivation || false], [5000000, false]);
  assert.equal(pick(J.short, 'VALOR').bidCents, 4500000);
  assert.equal(pick(J.typed, 'VALOR').bidCents, 3000000);
  assert.equal(pick(J.budget, 'VALOR').bidCents, 2000000);
  assert.equal(pick(J.carro, 'CARRO').bidCents ?? null, null);
  assert.equal(pick(J.none, 'VALOR'), undefined, 'sem lance em lugar nenhum continua fora das buscas ativas');
});

test('lote: os carros aparecem para a ficha do modelo antigo; nada muda para os outros', async () => {
  const car = (vin, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { lane: '6', run: String(Number(vin.slice(-2))), vin, year: 2021, make: 'Mercedes-Benz', model: 'GLE', trim: 'GLE 350', miles: 40000, mmrCents: 4500000, location: 'GA - Manheim Atlanta', saleDate: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), ...extra } });
  const CARS = [car('GLEX000000000001'), car('CAMR000000000002', { make: 'Toyota', model: 'Camry', trim: 'SE', mmrCents: 2000000 })];
  const files = [{ name: 'MCS_01.csv', size: 1000, chunks: [CARS] }];
  const manifest = files.map((file) => ({ name: file.name, size: file.size, rowCount: 2, vehicleCount: 2, chunkCount: 1, chunks: [{ count: 2, hash: batchRules.contentHash(CARS) }] }));
  const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: 'd'.repeat(32), vehicleCount: 2, files: manifest, manifestHash: batchRules.contentHash(manifest), headers: [['Vin', 'Year', 'Make', 'Model', 'Odometer', 'MMR']], headerMap: { files: [{ vin: 'Vin' }] } });
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  const uploadId = started.payload.uploadId;
  assert.equal((await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId, fileIndex: 0, chunkIndex: 0, vehicles: CARS })).statusCode, 200);
  const done = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'finalize', uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
  const rows = async (journey, mode) => (await backend.db.query(`select row_fingerprint from public.manheim_matches where upload_id=$1 and demand_key=$2 and undone_at is null order by row_fingerprint`, [uploadId, `journey:${journey}:${mode}`])).rows.map((row) => row.row_fingerprint);
  assert.deepEqual(await rows(J.old, 'VALOR'), ['vin:GLEX000000000001'], 'GLE de US$ 45.000 de MMR para o lance de US$ 50.000');
  assert.deepEqual(await rows(J.short, 'VALOR'), ['vin:GLEX000000000001']);
  assert.deepEqual(await rows(J.typed, 'VALOR'), [], 'lance digitado de US$ 30.000: o GLE de US$ 45.000 fica fora, como antes');
  assert.deepEqual(await rows(J.budget, 'VALOR'), ['vin:CAMR000000000002'], 'caminho comum igual');
  assert.deepEqual(await rows(J.carro, 'CARRO'), ['vin:GLEX000000000001'], 'POR CARRO pelos anos, sem lance');
  assert.deepEqual(await rows(J.none, 'VALOR'), []);
});

test('ficha aberta: mostra o mesmo lance da busca', async () => {
  const lead = await call('lead', `/api/panel/lead?id=${J.old}`);
  assert.equal(lead.statusCode, 200, JSON.stringify(lead.payload));
  const valorRequest = lead.payload.searchRequests.find((item) => item.mode === 'VALOR');
  assert.equal(valorRequest.bidCents, 5000000);
  const typed = await call('lead', `/api/panel/lead?id=${J.typed}`);
  assert.equal(typed.payload.searchRequests.find((item) => item.mode === 'VALOR').bidCents, 3000000);
});

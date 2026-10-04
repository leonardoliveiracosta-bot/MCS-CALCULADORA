'use strict';

// Nenhum contato da calculadora se perde. Banco isolado (PGlite com todas as migrações, nada de produção), com o texto
// que a calculadora monta (msc-calculadora.html, linkWhatsApp: a última linha é "Ref: XXXXX", ou "Ref: -----" sem armazenamento).
//  (i)   mensagem nova com "Ref: XXXXX" liga à ficha da Ref
//  (ii)  "Ref: -----" de telefone novo cria ficha nova (e nunca vira Ref)
//  (iii) telefone com duas fichas vai para a fila com motivo e evidência, sem ficar ligado a nenhuma
//  (iv)  reprocessar (cron de novo e SMS repetido) não duplica nada
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const calcMessage = require('../panel-calc-message');
const route = require('../panel-calc-route');

const id = (n) => `6ca10000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1), JA = id(2), B = id(3), JB1 = id(4), JB2 = id(5);
const seed = [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${A}','preview','Ana Souza','SMS_DIRECT',now(),now()),('${B}','preview','Bruno Lima','SMS_DIRECT',now(),now());`,
  `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at) values('preview','${A}','+13055550101','+13055550101',true,true,now()),('preview','${B}','+13055550202','+13055550202',true,true,now());`,
  `insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${JA}','preview','${A}','QWRT7','SMS_DIRECT','NOVO','ATIVO','{}',now(),now()),('${JB1}','preview','${B}',null,'SMS_DIRECT','NOVO','ATIVO','{}',now()-interval '2 days',now()),('${JB2}','preview','${B}',null,'SMS_DIRECT','NOVO','ATIVO','{}',now(),now());`
].join('\n');

// The text the calculator builds (linkWhatsApp, English copy), ending with the Ref line.
const calculatorText = (ref, name = 'Carla Dias') => ['EN · NOW · $6,000 · Dodge Challenger', '', 'Hello! I just ran a simulation on the My Car Scout calculator', '', `Name: ${name}`,
  'Vehicle: Dodge Challenger', 'ZIP code: 33101 — Miami, FL', 'Maximum bid: $6,000', 'Payment method: Cash', 'Planning to buy: Now', '',
  'The figures shown in the calculator are an initial estimate based on the information I provided,\nand do not represent the final purchase amount', '',
  'Additional costs may apply depending on the conditions of the transaction\nThe applicable breakdown will be confirmed in writing before any purchase authorization', '',
  "I'd like to discuss this simulation", `Ref: ${ref}`].join('\n');

let backend, ctx, services;
const q = async (sql, params) => (await backend.db.query(sql, params)).rows;
test.before(async () => {
  backend = await createBackend({ seed });
  globalThis.fetch = backend.fetch;
  const server = require('../panel-server');
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview' };
  services = { rows: server.rows, allRows: server.allRows, insert: server.insert, patchRows: server.patchRows, push: async () => null, route: (c, message) => route.routeOne(c, message) };
});
test.after(async () => { if (backend) await backend.db.close(); });
const receive = (sender, text, date) => require('../api/sms/inbound').receive(ctx, { sender, text, date }, services);

test('leitura do texto real: Ref, "Ref: -----", sem linha, modelo antigo e espanhol', () => {
  assert.deepEqual([calcMessage.parse(calculatorText('QWRT7')).refState, calcMessage.parse(calculatorText('QWRT7')).ref], ['REF', 'QWRT7']);
  const blocked = calcMessage.parse(calculatorText('-----'));
  assert.deepEqual([blocked.refState, blocked.ref, blocked.diagnosis], ['REF_ILEGIVEL', null, 'REF_TRACOS']);
  assert.equal(calcMessage.parse(calculatorText('QWRT7').replace(/\nRef: QWRT7$/, '')).diagnosis, 'SEM_LINHA_REF_CORTADA');
  assert.equal(calcMessage.parse('Hi! I just ran an estimate on the My Car Scout calculator.\nMaximum bid: $9,000\nI understand this is an estimate and not a commercial offer.').diagnosis, 'SEM_LINHA_REF_MODELO_ANTIGO');
  assert.equal(calcMessage.isCalculator('¡Hola! Acabo de hacer una simulación en la calculadora de My Car Scout\nOferta máxima: $5,000\nRef: ABCD2'), true);
  assert.equal(calcMessage.isCalculator('Hi, I’m interested in financing a vehicle through My Car Scout'), false);
});

test('(i) "Ref: XXXXX" liga à ficha da Ref', async () => {
  // The name agrees with the ficha of the Ref (Ana Souza): the second way finds no contradiction.
  const out = await receive('+13055559999', calculatorText('QWRT7', 'Ana Souza'), '2026-10-02T12:00:00Z');
  assert.equal(out.stored, true);
  const [row] = await q(`select r.destination, r.reason, r.journey_id from public.panel_calc_message_route r join public.messages m on m.id=r.message_id where m.body_text like '%Ref: QWRT7'`);
  assert.deepEqual([row.destination, row.reason, row.journey_id], ['LIGADA_REF', 'REF_ENCONTRADA', JA]);
  const links = await q(`select mj.journey_id from public.message_journeys mj join public.messages m on m.id=mj.message_id where m.body_text like '%Ref: QWRT7' and mj.undone_at is null`);
  assert.deepEqual(links.map((link) => link.journey_id), [JA]);
});

test('(i-b) "Ref: XXXXX" de uma ficha com outro nome: Confirmar vínculo, nunca junta sozinho', async () => {
  const out = await receive('+13055558888', calculatorText('QWRT7', 'Carla Dias').replace('Dodge Challenger', 'Dodge Challenger '), '2026-10-02T12:01:00Z');
  assert.equal(out.stored, true);
  const [row] = await q(`select r.destination, r.reason, r.evidence from public.panel_calc_message_route r join public.messages m on m.id=r.message_id where m.body_text like '%Carla Dias%Ref: QWRT7'`);
  assert.deepEqual([row.destination, row.reason, row.evidence.via, row.evidence.conflicts, row.evidence.candidates], ['FILA', 'FILA_CONTRADICAO', 'REF', ['nome'], [JA]]);
  const links = await q(`select mj.journey_id from public.message_journeys mj join public.messages m on m.id=mj.message_id where m.body_text like '%Carla Dias%Ref: QWRT7' and mj.undone_at is null`);
  assert.deepEqual(links, []);
});

test('(ii) "Ref: -----" de telefone novo cria ficha nova e nunca vira Ref', async () => {
  const before = (await q(`select count(*)::int n from public.journeys`))[0].n;
  const out = await receive('+13055550303', calculatorText('-----', 'Diego Ramos'), '2026-10-02T12:05:00Z');
  assert.equal(out.stored, true);
  const [row] = await q(`select r.destination, r.reason, r.ref_state, r.ref, r.journey_id, r.evidence from public.panel_calc_message_route r join public.messages m on m.id=r.message_id where m.body_text like '%Ref: -----'`);
  assert.deepEqual([row.destination, row.reason, row.ref_state, row.ref], ['NOVA_FICHA', 'FICHA_NOVA_TELEFONE_NOVO', 'REF_ILEGIVEL', null]);
  assert.equal(row.evidence.refIlegivel, true);
  const [journey] = await q(`select j.reference_code, c.display_name, p.phone_e164 from public.journeys j join public.contacts c on c.id=j.contact_id join public.contact_phones p on p.contact_id=c.id where j.id=$1`, [row.journey_id]);
  // the ficha gets its own internal code (database default), never the dashes
  assert.notEqual(journey.reference_code, '-----');
  assert.deepEqual([journey.display_name, journey.phone_e164], ['Diego Ramos', '+13055550303']);
  assert.equal((await q(`select count(*)::int n from public.journeys`))[0].n, before + 1);
  assert.equal((await q(`select count(*)::int n from public.message_journeys where journey_id=$1 and undone_at is null`, [row.journey_id]))[0].n, 1);
});

test('(iii) telefone com duas fichas vai para a fila com motivo e evidência, sem ficha escolhida', async () => {
  const out = await receive('+13055550202', calculatorText('-----', 'Bruno Lima'), '2026-10-02T12:10:00Z');
  assert.equal(out.stored, true);
  assert.equal(out.queued, true);
  const [row] = await q(`select r.destination, r.reason, r.evidence, r.message_id from public.panel_calc_message_route r join public.messages m on m.id=r.message_id join public.chats c on c.id=m.chat_id where c.contact_id=$1`, [B]);
  assert.deepEqual([row.destination, row.reason], ['FILA', 'FILA_VARIAS_FICHAS']);
  assert.deepEqual([...row.evidence.candidates].sort(), [JB1, JB2].sort());
  assert.equal((await q(`select count(*)::int n from public.message_journeys where message_id=$1 and undone_at is null`, [row.message_id]))[0].n, 0);
  const queue = await route.loadQueue(ctx);
  const item = queue.find((entry) => entry.messageId === row.message_id);
  assert.match(item.reasonText, /mais de uma ficha/);
  assert.equal(item.candidates.length, 2);
});

test('(iii-b) mensagem que a ingestão ligou sozinha à última ficha volta para a fila (um lugar só)', async () => {
  const chat = (await q(`select id from public.chats where contact_id=$1 limit 1`, [B]))[0].id;
  const [message] = await q(`insert into public.messages(environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values('preview',$1,'WHATSAPP','CUSTOMER',$2,'x',now(),'wa-test-1',1,now()) returning id`, [chat, calculatorText('ZZZZ9', 'Bruno Lima').replace('Ref: ZZZZ9', 'Ref: -----')]);
  await q(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'WHATSAPP_WEBHOOK',now())`, [message.id, JB2]);
  const summary = await route.routeCalculatorMessages(ctx, { max: 50 });
  assert.equal(summary.failed, 0);
  const [row] = await q(`select destination, reason, evidence from public.panel_calc_message_route where message_id=$1`, [message.id]);
  assert.deepEqual([row.destination, row.reason], ['FILA', 'FILA_VARIAS_FICHAS']);
  assert.deepEqual(row.evidence.unlinkedAuto, [JB2]);
  assert.equal((await q(`select count(*)::int n from public.message_journeys where message_id=$1 and undone_at is null`, [message.id]))[0].n, 0);
});

test('(iv) reprocessar não duplica: cron de novo, SMS repetido e decisão manual preservada', async () => {
  const count = async () => (await q(`select (select count(*) from public.journeys)::int j, (select count(*) from public.message_journeys)::int l, (select count(*) from public.panel_calc_message_route)::int r, (select count(*) from public.messages)::int m`))[0];
  const before = await count();
  await route.routeCalculatorMessages(ctx, { max: 50 });
  await q(`update public.panel_calc_message_route set updated_at=now()-interval '1 hour'`);
  await route.routeCalculatorMessages(ctx, { max: 50 });
  const repeated = await receive('+13055559999', calculatorText('QWRT7', 'Ana Souza'), '2026-10-02T12:00:00Z');
  assert.equal(repeated.duplicate, true);
  assert.deepEqual(await count(), before);
  // the operator decides one queue item; the rule never undoes it
  const [queued] = await q(`select message_id from public.panel_calc_message_route where destination='FILA' limit 1`);
  const decided = await require('../panel-server').supabase(BASE, 'secreta-simulada', '/rest/v1/rpc/panel_calc_route_apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: 'preview', p_message_id: queued.message_id, p_destination: 'LIGADA_TELEFONE', p_reason: 'DECISAO_MANUAL', p_ref_state: 'REF_ILEGIVEL', p_ref: null, p_journey_id: JB1, p_evidence: {}, p_rule_version: route.RULE_VERSION, p_link: true, p_manual: true }) });
  assert.equal(decided.linked, true);
  await q(`update public.panel_calc_message_route set updated_at=now()-interval '1 hour'`);
  await route.routeCalculatorMessages(ctx, { max: 50 });
  const [kept] = await q(`select destination, manual, journey_id from public.panel_calc_message_route where message_id=$1`, [queued.message_id]);
  assert.deepEqual([kept.destination, kept.manual, kept.journey_id], ['LIGADA_TELEFONE', true, JB1]);
});

test('zero sem destino: toda mensagem da calculadora no banco tem um destino', async () => {
  const [row] = await q(`select count(*)::int n from public.messages m where m.direction='CUSTOMER' and public.panel_calc_template_text(m.body_text) and not exists (select 1 from public.panel_calc_message_route r where r.message_id=m.id)`);
  assert.equal(row.n, 0);
  assert.deepEqual(backend.refused, []);
});

test('similaridade sozinha nunca liga: mesmo carro e valor de outra ficha, sem Ref e sem telefone conhecido', () => {
  const verdict = route.decide({ parsed: { refState: 'SEM_LINHA_REF', ref: null, name: 'Outra Pessoa', vehicle: 'Dodge Challenger' }, refOwners: [], contactId: null, fichas: [], linked: [] });
  assert.deepEqual([verdict.destination, verdict.reason, verdict.link], ['FILA', 'SEM_CONTATO', undefined]);
});

test('(d) SMS lido de print sem a linha "Ref:" no texto: a Ref do print vale, com a fonte dita', async () => {
  const verdict = await route.routeOne(ctx, { message_id: '00000000-0000-4000-8000-000000000000', body_text: calculatorText('QWRT7').replace(/\nRef: QWRT7$/, ''), contact_id: A, linked_journeys: [JA], print_ref: 'QWRT7' },
    { rpc: async () => ({ linked: false }), factsFor: async () => ({ parsed: calcMessage.parse(calculatorText('QWRT7').replace(/\nRef: QWRT7$/, '')), refOwners: [{ id: JA, contact_id: A }], contactId: A, fichas: [{ id: JA, contactName: 'Ana Souza', vehicleText: '' }], linked: [JA] }) });
  assert.deepEqual([verdict.destination, verdict.reason, verdict.evidence.refSource, verdict.ref], ['LIGADA_REF', 'REF_ENCONTRADA', 'PRINT', 'QWRT7']);
});

test('(e) a confirmação do print guarda o texto completo, com a linha "Ref:" que o print mostrava', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'panel', 'sms-print.js'), 'utf8');
  assert.match(source, /refState==='SEM_LINHA_REF'\)values\.message=values\.message\.replace\(\/\\s\+\$\/,''\)\+'\\nRef: '\+values\.ref\.toUpperCase\(\)/);
});

test('detecção no banco: o marcador "· FIND ·" sozinho também conta', async () => {
  const [row] = await q(`select public.panel_calc_template_text('EN · FIND · NOW · 2021-2025 · Honda HR-V · 1st My Car Scout') ok`);
  assert.equal(row.ok, true);
});

'use strict';
// Varredura fora da MCS: a IA só aponta a candidata (motivo e frase original conferida); nada sai sem a confirmação da operadora;
// confirmada, a conversa vira "fora do funil" pela triagem (recuperável); conversa sobre carro, financiamento ou calculadora nunca é candidata.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const subject = require('../panel-subject');

const ids = new Map([['m1', { id: '7a000000-0000-4000-8000-000000000001', direction: 'CUSTOMER', body_text: 'Oi primo, a festa da vovó é sábado às 18h' }], ['m2', { id: '7a000000-0000-4000-8000-000000000002', direction: 'MCS', body_text: 'Beleza, vou levar o bolo' }]]);
const answer = (fora) => ({ subject: 'OUTROS', confidence: 0.9, reason: 'pessoal', refs: [], fora_mcs: fora });

test('candidata só com certeza alta, motivo e frase original conferida', () => {
  const ok = subject.validate(answer({ candidato: true, categoria: 'PESSOAL', certeza: 'alta', motivo: 'Conversa de família sobre uma festa', message: 'm1', quote: 'a festa da vovó é sábado' }), ids);
  assert.deepEqual([ok.offMcs.candidate, ok.offMcs.category, ok.offMcs.messageId], [true, 'PESSOAL', ids.get('m1').id]);
  assert.match(ok.offMcs.quote, /festa da vovó/);
});

test('na dúvida não marca: certeza média, frase inventada, sem motivo ou categoria fora da lista', () => {
  const base = { candidato: true, categoria: 'PESSOAL', certeza: 'alta', motivo: 'x', message: 'm1', quote: 'a festa da vovó' };
  assert.equal(subject.validate(answer({ ...base, certeza: 'media' }), ids).offMcs.candidate, false);
  assert.equal(subject.validate(answer({ ...base, quote: 'vou vender meu sofá' }), ids).offMcs.candidate, false);
  assert.equal(subject.validate(answer({ ...base, motivo: '' }), ids).offMcs.candidate, false);
  assert.equal(subject.validate(answer({ ...base, categoria: 'SPAM' }), ids).offMcs.candidate, false);
  assert.equal(subject.validate(answer(null), ids).offMcs.candidate, false);
});

test('mensagem sobre carro ou financiamento nunca é candidata', () => {
  const sure = { candidato: true, categoria: 'OUTRO_NEGOCIO', certeza: 'alta', motivo: 'x', message: 'm1', quote: 'a festa da vovó' };
  assert.equal(subject.validate({ ...answer(sure), subject: 'FINANCIAMENTO' }, ids).offMcs.candidate, false);
  assert.equal(subject.validate({ ...answer(sure), subject: 'PEDIDO_CARRO' }, ids).offMcs.candidate, false);
});

test('ficha da calculadora nunca é candidata, mesmo se a leitura disser que sim; o término grava a candidata', async () => {
  const calls = [];
  const deps = (messages, known) => ({
    rpc: async (ctx, name, body) => { calls.push({ name, body }); return name === 'panel_subject_claim' ? 'token' : true; },
    loadMessages: async () => messages, knownRefs: async () => known,
    ask: async () => answer({ candidato: true, categoria: 'PESSOAL', certeza: 'alta', motivo: 'Conversa de família', message: 'm1', quote: messages[0].body_text.slice(0, 20) })
  });
  const personal = [{ id: ids.get('m1').id, direction: 'CUSTOMER', body_text: 'Oi primo, a festa da vovó é sábado às 18h' }];
  await subject.classifyOne({ environment: 'preview' }, { journey_id: 'j1', content_hash: 'h' }, deps(personal, []));
  assert.equal(calls.find((call) => call.name === 'panel_subject_finish_v3').body.p_offmcs.candidate, true);
  calls.length = 0;
  const calculator = [{ id: ids.get('m1').id, direction: 'CUSTOMER', body_text: 'Hello! I just ran a simulation on the My Car Scout calculator\nMaximum bid: $6,000\nRef: QWRT7' }];
  await subject.classifyOne({ environment: 'preview' }, { journey_id: 'j2', content_hash: 'h' }, deps(calculator, ['QWRT7']));
  assert.equal(calls.find((call) => call.name === 'panel_subject_finish_v3').body.p_offmcs.candidate, false);
});

test('fluxo real (banco isolado): candidata aparece para revisão; confirmar tira do funil; desfazer devolve; nada é apagado', async () => {
  const { BASE, createBackend } = require('./fixtures/banco-simulado');
  const id = (n) => `7b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const ACTOR = id(1), C = id(2), J = id(3), CH = id(4), M = id(5);
  const backend = await createBackend({ seed: [
    `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${C}','preview','Primo Zé','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${J}','preview','${C}','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${CH}','preview','WHATSAPP','${C}','wa:primo','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,created_at) values('${M}','preview','${CH}','WHATSAPP','CUSTOMER','Oi primo, a festa da vovó é sábado','x',now(),'sig-primo',1,now());`,
    `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${M}','${J}','TEST',now());`,
    `insert into public.panel_conversation_class(environment,journey_id,subject,input_hash,rule_version,classified_at,offmcs_candidate,offmcs_category,offmcs_reason,offmcs_quote,offmcs_message_id) values('preview','${J}','OUTROS','h',3,now(),true,'PESSOAL','Conversa de família sobre uma festa','a festa da vovó é sábado','${M}');`
  ].join('\n') });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
  const call = async (method, body) => { const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
    await require('../api/panel/triage')({ method, url: '/api/panel/triage', headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res); return res; };
  try {
    const listed = await call('GET');
    assert.equal(listed.statusCode, 200, JSON.stringify(listed.payload));
    assert.equal(listed.payload.offMcs.length, 1);
    assert.match(listed.payload.offMcs[0].quote, /festa da vovó/);
    // nothing left the funnel before the confirmation
    assert.equal((await backend.db.query(`select count(*)::int n from public.conversation_triage`)).rows[0].n, 0);
    const confirmed = await call('POST', { action: 'offmcs_confirm', journeyId: J });
    assert.equal(confirmed.statusCode, 200, JSON.stringify(confirmed.payload));
    const [row] = (await backend.db.query(`select decision, category, source from public.conversation_triage where chat_id=$1 and status='ACTIVE'`, [CH])).rows;
    assert.deepEqual([row.decision, row.category, row.source], ['FORA_DO_FUNIL', 'PESSOAL', 'MANUAL']);
    const after = await call('GET');
    assert.equal(after.payload.offMcs.length, 0);
    assert.equal(after.payload.out.length, 1);
    const undone = await call('POST', { action: 'offmcs_undo', journeyId: J, triageIds: confirmed.payload.triageIds });
    assert.equal(undone.statusCode, 200, JSON.stringify(undone.payload));
    assert.equal((await backend.db.query(`select count(*)::int n from public.conversation_triage where chat_id=$1 and status='ACTIVE' and decision='FORA_DO_FUNIL'`, [CH])).rows[0].n, 0);
    assert.equal((await backend.db.query(`select count(*)::int n from public.messages where id=$1`, [M])).rows[0].n, 1);
    assert.deepEqual(backend.refused, []);
  } finally { await backend.db.close(); }
});

test('Tratado automático: mensagem real da MCS depois da última do cliente tira o caso de HOJE; o botão manual "Tratado" saiu', () => {
  const fs = require('node:fs'), path = require('node:path');
  const today = fs.readFileSync(path.join(__dirname, '..', 'api', 'panel', 'today.js'), 'utf8');
  assert.match(today, /eventAfterDisposition\(facts\.latestAt,treatedAt\(journey,dispositionAt\)\)/);
  assert.match(today, /const treatedAt=\(journey,dispositionAt\)=>\{const replied=journey\?latestMcsAt\.get\(journey\.id\)/);
  const panel = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.doesNotMatch(panel, /element\('button', 'small', 'Tratado'\)/);
});

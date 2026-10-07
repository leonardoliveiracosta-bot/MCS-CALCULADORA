'use strict';

// TODOS · Espera: o resultado marcado à mão na ficha ("Resultado rápido") chega à aba TODOS, com os handlers reais
// contra o banco simulado (todas as migrações). Com Ref e sem Ref; "Desfazer" volta para "sem resposta".
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const id = (n) => `6d100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WITH_REF = id(10), NO_REF = id(20);
const person = (journey, contact, chat, message, ref, name) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}',${ref ? `'${ref}'` : 'null'},'WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now() - interval '2 days',now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','espera-${chat}','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','Quero um carro','x',now() - interval '5 hours','s-${message}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...person(WITH_REF, id(11), id(12), id(13), 'AB2CD', 'Cliente Com Ref'),
  ...person(NO_REF, id(21), id(22), id(23), null, 'Cliente Sem Ref')
].join('\n');

let backend;
const call = async (file, { method = 'GET', query = {}, body } = {}) => {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  const url = '/api/panel/' + file + (Object.keys(query).length ? '?' + new URLSearchParams(query) : '');
  await require('../api/panel/' + file)({ method, url, headers: { authorization: 'Bearer token-simulado' }, query, body }, res);
  return res;
};
const marks = async () => { const res = await call('today', { query: { sort: 'ready' } }); assert.equal(res.statusCode, 200); return res.payload.contactResults; };

test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('nada marcado: a aba recebe o mapa vazio (cada caso mostra "sem resposta")', async () => {
  assert.deepEqual(await marks(), {});
});

test('marcar na ficha chega à aba TODOS, com Ref e sem Ref; desfazer volta para "sem resposta"', async () => {
  const answered = await call('lead', { method: 'POST', body: { ref: 'AB2CD', journeyId: WITH_REF, action: 'quick', type: 'ANSWERED', operationId: crypto.randomUUID() } });
  assert.ok([200, 201].includes(answered.statusCode), JSON.stringify(answered.payload));
  const noAnswer = await call('lead', { method: 'POST', body: { journeyId: NO_REF, action: 'quick', type: 'NO_ANSWER', operationId: crypto.randomUUID() } });
  assert.ok([200, 201].includes(noAnswer.statusCode), JSON.stringify(noAnswer.payload));
  let shown = await marks();
  assert.equal(shown[WITH_REF].label, 'Atendeu');
  assert.equal(shown[NO_REF].label, 'Não atendeu');
  // The latest mark wins.
  await call('lead', { method: 'POST', body: { ref: 'AB2CD', journeyId: WITH_REF, action: 'quick', type: 'IN_PERSON', operationId: crypto.randomUUID() } });
  const deposit = await call('lead', { method: 'POST', body: { ref: 'AB2CD', journeyId: WITH_REF, action: 'quick', type: 'DEPOSIT', operationId: crypto.randomUUID() } });
  assert.equal((await marks())[WITH_REF].label, 'Vai pagar o depósito');
  // "Desfazer" (within the 10 seconds of the ficha) brings back the previous mark.
  const undone = await call('lead', { method: 'POST', body: { ref: 'AB2CD', journeyId: WITH_REF, action: 'undo', eventId: deposit.payload.eventId } });
  assert.ok([200, 201].includes(undone.statusCode), JSON.stringify(undone.payload));
  shown = await marks();
  assert.equal(shown[WITH_REF].label, 'Conversa presencial');
  assert.equal(shown[NO_REF].label, 'Não atendeu');
  // Nothing else changed in the list: both cases still there.
  const today = await call('today', { query: { sort: 'ready' } });
  const ids = today.payload.items.map((item) => item.journeyId || item.id);
  assert.ok(ids.includes(WITH_REF) && ids.includes(NO_REF));
});

'use strict';

// Adendo, item 4: fora do assunto. Banco PGlite com todas as migrações e OpenAI simulada.
// A conversa que nunca falou de carro vai para o grupo próprio; a correção fica guardada e vence a
// IA; nada é apagado; nenhuma mensagem é enviada.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const triage = require('../panel-triage');

const id = (n) => `6d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
const ENV = { ENTRADA_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'chave-simulada', ENTRADA_OPENAI_MODEL: 'gpt-6-luna', ENTRADA_OPENAI_SINCE: '2026-01-01T00:00:00Z' };
const PEOPLE = {
  carro: { n: 10, name: 'Cliente Carro', text: ['Hi, I am looking for a 2019 Honda Civic'] },
  aniversario: { n: 20, name: 'Amiga', text: ['Feliz aniversário! Vamos jantar sábado?'] },
  duvida: { n: 30, name: 'Contato Curto', text: ['Oi, tudo bem?'] }
};
function seed() {
  const rows = [`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`];
  Object.values(PEOPLE).forEach((person) => {
    const contact = id(person.n + 1), journey = id(person.n), chat = id(person.n + 2);
    rows.push(`insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${person.name}','WHATSAPP_DIRECT',now(),now());`);
    rows.push(`insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`);
    rows.push(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','t-${person.n}','RESOLVED',false,now(),now(),now(),now());`);
    person.text.forEach((text, index) => {
      const message = id(person.n * 100 + index);
      rows.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','CUSTOMER','${text.replace(/'/g, "''")}','x',now()-interval '2 hours','s${person.n}-${index}',1,'WHATSAPP_WEBHOOK',now()-interval '2 hours');`);
      rows.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`);
    });
  });
  return rows.join('\n');
}
function fakeOpenAI(calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const messages = JSON.parse(body.messages[1].content).mensagens;
    const text = messages.map((item) => item.texto).join(' ');
    const answer = /Civic/.test(text) ? { category: 'PRE_COMPRA_MCS', confidence: 'alta', reason: 'Quer comprar', sobre_carro: true, sobre_carro_certeza: 'alta' }
      : /aniversário/.test(text) ? { category: 'PESSOAL', confidence: 'alta', reason: 'Conversa pessoal', sobre_carro: false, sobre_carro_certeza: 'alta' }
        : { category: 'REVISAR', confidence: 'baixa', reason: 'Pouco contexto', sobre_carro: false, sobre_carro_certeza: 'baixa' };
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 300, completion_tokens: 40 }, choices: [{ message: { content: JSON.stringify({ ...answer, evidence_ids: [messages.at(-1).id] }) } }] }) };
  };
}

let backend, ctx;
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const counts = async () => (await backend.db.query('select (select count(*) from public.messages) m, (select count(*) from public.chats) c, (select count(*) from public.journeys) j, (select count(*) from public.contacts) p')).rows[0];

test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  delete process.env.OPENAI_API_KEY; delete process.env.ENTRADA_OPENAI_ENABLED;
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview' };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('a triagem grava se a conversa trata de carro; só um "não" com certeza vai para Fora do assunto', async () => {
  const before = await counts();
  const calls = [];
  const result = await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI(calls), limit: 10 });
  assert.equal(result.processed, 3);
  assert.ok(calls.every((body) => body.response_format.json_schema.schema.required.includes('sobre_carro')));
  const stored = Object.fromEntries((await backend.db.query('select chat_id,about_car from public.conversation_triage')).rows.map((row) => [row.chat_id, row.about_car]));
  assert.equal(stored[id(12)], true);
  assert.equal(stored[id(22)], false);
  assert.equal(stored[id(32)], true); // unsure "no" stays in the main flow
  const records = (await call('records', '/api/panel/records?sort=ready')).payload.items;
  const groupOf = (n) => records.find((item) => item.id === id(n))?.group?.key;
  assert.equal(groupOf(20), undefined, 'pessoal sai de CLIENTES pelo funil (regra antiga mantida)');
  const entry = (await call('triage', '/api/panel/triage')).payload;
  assert.deepEqual(entry.offTopic.map((item) => item.chatId), [id(22)]);
  assert.ok(!entry.out.some((item) => item.chatId === id(22)), 'um contato aparece em um grupo só');
  assert.deepEqual(await counts(), before, 'nada é apagado');
});

test('a correção fica guardada, vence a IA e tem desfazer', async () => {
  const before = await counts();
  const fixed = await call('triage', '/api/panel/triage', 'POST', { action: 'topic', chatId: id(22), aboutCar: true });
  assert.equal(fixed.statusCode, 200);
  assert.equal(fixed.payload.ids.length, 1);
  let entry = (await call('triage', '/api/panel/triage')).payload;
  assert.deepEqual(entry.offTopic, []);
  // A new AI reading of the same conversation never undoes the correction.
  await backend.db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(2099)}','preview','${id(22)}','WHATSAPP','CUSTOMER','Feliz aniversário de novo','x',now(),'s20-9',1,'WHATSAPP_WEBHOOK',now())`);
  await triage.runTriage(ctx, { env: ENV, fetchImpl: fakeOpenAI([]), limit: 10 });
  entry = (await call('triage', '/api/panel/triage')).payload;
  assert.deepEqual(entry.offTopic, []);
  // Marking a ficha as off-topic covers its conversations; undo brings the previous correction back.
  const marked = await call('triage', '/api/panel/triage', 'POST', { action: 'topic', journeyId: id(10), aboutCar: false });
  assert.equal(marked.statusCode, 200);
  const records = (await call('records', '/api/panel/records?sort=ready')).payload.items;
  assert.equal(records.find((item) => item.id === id(10)).group.key, 'FORA_DO_ASSUNTO');
  assert.equal(records.find((item) => item.id === id(10)).group.offTopicSource, 'MANUAL');
  const today = (await call('today', '/api/panel/today')).payload.items;
  const inToday = today.find((item) => item.id === id(10) || item.journeyId === id(10));
  if (inToday) assert.equal(inToday.group.key, 'FORA_DO_ASSUNTO');
  await call('triage', '/api/panel/triage', 'POST', { action: 'topic_undo', ids: marked.payload.ids });
  const after = (await call('records', '/api/panel/records?sort=ready')).payload.items;
  assert.notEqual(after.find((item) => item.id === id(10)).group.key, 'FORA_DO_ASSUNTO');
  const history = (await backend.db.query('select count(*)::int n, count(*) filter (where undone_at is null)::int active from public.conversation_topic_overrides')).rows[0];
  assert.equal(history.n, 2, 'o histórico das correções fica guardado');
  assert.equal(history.active, 1);
  const before2 = await counts();
  assert.equal(Number(before2.m), Number(before.m) + 1);
  assert.deepEqual(backend.refused, []);
});

test('não atendido e origem nos cartões de CLIENTES e da ENTRADA', async () => {
  const records = (await call('records', '/api/panel/records?sort=ready')).payload.items;
  const carro = records.find((item) => item.id === id(10));
  assert.equal(carro.group.key, 'NAO_ATENDIDO');
  assert.equal(carro.group.origin, 'DIRETO');
  assert.match(carro.group.unattended.waitedText, /h|min/);
  assert.equal(carro.lastCustomerMessage.text, 'Hi, I am looking for a 2019 Honda Civic');
  const entry = (await call('entry', '/api/panel/entry')).payload;
  const chat = entry.chats.find((item) => item.id === id(12));
  assert.equal(chat.group.key, 'NAO_ATENDIDO');
  assert.equal(chat.lastCustomerMessage.id, id(1000));
});

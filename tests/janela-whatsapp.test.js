'use strict';
// TODOS: quem espera resposta no WhatsApp traz até quando a janela de 24 h deixa o painel enviar. Só acrescenta um campo:
// a ordem, os motivos e as contagens da lista não mudam.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const id = (n) => `6d100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
// waiting: client wrote 2 h ago, no answer · answered: client 3 h ago, MCS 1 h ago · old: client 30 h ago, no answer.
const PEOPLE = {
  waiting: { n: 10, messages: [['CUSTOMER', 2]] },
  answered: { n: 20, messages: [['CUSTOMER', 3], ['MCS', 1]] },
  old: { n: 30, messages: [['CUSTOMER', 30]] }
};
function seed() {
  const rows = [`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`];
  Object.entries(PEOPLE).forEach(([name, person]) => {
    const contact = id(person.n + 1), journey = id(person.n), chat = id(person.n + 2);
    rows.push(`insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','${name}','WHATSAPP_DIRECT',now(),now());`);
    rows.push(`insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`);
    rows.push(`insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','j-${person.n}','RESOLVED',false,now(),now(),now(),now());`);
    person.messages.forEach(([direction, hours], index) => {
      const message = id(person.n * 100 + index);
      rows.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','${direction}','Hi, I want a 2019 Honda Civic','x',now()-interval '${hours} hours','j${person.n}-${index}',1,'WHATSAPP_WEBHOOK',now()-interval '${hours} hours');`);
      rows.push(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','IMPORT',now());`);
    });
  });
  return rows.join('\n');
}

let backend;
async function call(url) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/today')({ method: 'GET', url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams) }, res);
  return res;
}
test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('janela de 24 h: só quem espera resposta com a janela aberta traz o horário em que ela fecha', async () => {
  const res = await call('/api/panel/today?sort=ready');
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const byJourney = new Map(res.payload.items.map((item) => [item.journeyId || item.id, item]));
  const waiting = byJourney.get(id(10)), answered = byJourney.get(id(20)), old = byJourney.get(id(30));
  assert.ok(waiting && old, 'quem espera resposta continua na lista');
  const left = Date.parse(waiting.whatsappWindowUntil) - Date.now();
  assert.ok(left > 21.5 * 3600000 && left <= 22 * 3600000, 'fecha 24 h depois da mensagem do cliente (2 h atrás)');
  assert.equal(answered ? answered.whatsappWindowUntil : null, null, 'já respondido: nada a avisar');
  assert.equal(old.whatsappWindowUntil, null, 'janela já fechada: nada a avisar');
  // The rest of the item is as before.
  assert.equal(waiting.awaitingReply, true);
  if (answered) assert.equal(answered.awaitingReply, false);
  assert.equal(old.awaitingReply, true);
});

test('responder o cliente não tira o caso de TODOS: quem a MCS respondeu continua na lista, sem esperar resposta', async () => {
  const res = await call('/api/panel/today?sort=recent');
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  const byJourney = new Map(res.payload.items.map((item) => [item.journeyId || item.id, item]));
  const answered = byJourney.get(id(20));
  assert.ok(answered, 'respondido continua em TODOS');
  assert.equal(answered.awaitingReply, false);
  assert.ok(byJourney.get(id(10)) && byJourney.get(id(30)), 'quem espera resposta segue igual');
});

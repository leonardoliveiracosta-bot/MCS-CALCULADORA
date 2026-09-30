'use strict';

// Preview nunca envia WhatsApp real: o botão antigo "Responder" (api/panel/reply.js), a resposta
// automática e a própria função de envio ficam presos fora de produção, com a chave do 360dialog
// presente. O fetch só alcança o banco simulado; qualquer outro destino é recusado e registrado.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada', D360_API_KEY: 'chave-de-teste' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const id = (n) => `6c900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(11)}','preview','Ana','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,reference_code,created_at,updated_at) values('${id(21)}','preview','${id(11)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}','PRVW2',now(),now());`,
  `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,created_at) values('preview','${id(11)}','+13055550111','+13055550111',true,now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(31)}','preview','WHATSAPP','${id(11)}','wa:+13055550111','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(51)}','preview','${id(31)}','WHATSAPP','CUSTOMER','oi','oi',now() - interval '1 hour','p1',1,'WHATSAPP_WEBHOOK',now());`
].join('\n');

let backend;
test.before(async () => {
  backend = await createBackend({ seed });
  process.env.SUPABASE_URL = BASE;
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('Preview: "Responder" simula o envio, não chama o 360dialog e não grava mensagem', async () => {
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/reply')({ method: 'POST', url: '/api/panel/reply', headers: { authorization: 'Bearer token-simulado' }, query: {}, body: { action: 'send', journeyId: id(21), textEn: 'Hi Ana' } }, res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.simulated, true);
  assert.deepEqual(backend.refused, [], 'nenhuma chamada saiu para o 360dialog');
  assert.ok(!backend.calls.some((call) => /360dialog/.test(call.path)));
  const { rows: [{ n }] } = await backend.db.query(`select count(*)::int n from public.messages where direction = 'MCS'`);
  assert.equal(n, 0, 'nenhuma mensagem gravada na conversa');
});

test('Preview: a função de envio e a resposta automática também ficam presas', async () => {
  const reply = require('../api/panel/reply');
  assert.deepEqual(await reply.d360Send('+13055550111', 'Hi'), { error: 'D360_BLOCKED_OUTSIDE_PRODUCTION' });
  await assert.rejects(require('../whatsapp-auto-reply').sendMessage({ phone: '+13055550111' }), /D360_BLOCKED_OUTSIDE_PRODUCTION/);
  assert.deepEqual(backend.refused, []);
});

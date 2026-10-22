'use strict';

// POST /api/rene/send: o agente RENE (n8n) responde pelo mesmo envio do painel e a mensagem entra na conversa marcada RENE.
// Caminho comum: mensagem do cliente recente, ninguém respondeu, envia e grava, sem passo novo para o painel.
// Cada motivo de não enviar responde 200 { skipped } e não chama o 360dialog nem grava nada.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const server = require('../panel-server');
const reply = require('../api/panel/reply');
const rene = require('../api/rene/send');

const id = (n) => `7e0e0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const phoneOf = (n) => '+1305555' + String(n).padStart(4, '0');
const BOT = 'Hi, this is an automatic message from My Car Scout\nWe have had a high volume of messages';
const ctx = { environment: 'preview', config: { url: BASE, secretKey: 'secreta-simulada' } };

// Uma pessoa com ficha, chat WhatsApp 'wa:<telefone>' e mensagens (minutos atrás, direção, texto, origem).
function person(n, messages) {
  const contact = id(n * 100 + 1), chat = id(n * 100 + 2), journey = id(n * 100 + 3), raw = id(n * 100 + 4), phone = phoneOf(n);
  const sql = [
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Cliente ${n}','WHATSAPP_DIRECT',now(),now());`,
    `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at) values('preview','${contact}','${phone}','${phone}',true,true,now());`,
    `insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','RN${'ABCDEFGHJK'[n]}AA','WHATSAPP_DIRECT','NOVO','ATIVO','{}',now(),now());`,
    `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${chat}','preview','WHATSAPP','${contact}','wa:${phone}','RESOLVED',false,now(),now(),now(),now());`,
    `insert into public.whatsapp_raw_events(id,environment,event_key,event_type,payload_json,status) values('${raw}','preview','seed-${n}','messages','{}','DONE');`
  ];
  messages.forEach(([minutesAgo, direction, text, source = 'WHATSAPP_WEBHOOK'], index) => {
    const message = id(n * 100 + 10 + index);
    sql.push(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,time_uncertain,signature_base,occurrence_index,source_kind,created_at) values('${message}','preview','${chat}','WHATSAPP','${direction}','${text}','${text.toLowerCase()}',now()-interval '${minutesAgo} minutes',false,'rene-${n}-${index}',1,'${source}',now());`,
      `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${message}','${journey}','WHATSAPP_WEBHOOK',now());`,
      `insert into public.whatsapp_message_ids(environment,wa_message_id,message_id,raw_event_id) values('preview','wamid.${n}.${index}','${message}','${raw}');`);
  });
  return { sql: sql.join('\n'), phone, digits: phone.slice(1), journey, contact, wa: (index) => `wamid.${n}.${index}` };
}

const P = {
  common: person(1, [[90, 'MCS', 'Earlier answer from Leo', 'PANEL'], [10, 'CUSTOMER', 'Do you have a RAV4?'], [9, 'MCS', BOT]]),
  window: person(2, [[25 * 60, 'CUSTOMER', 'Old question'], [5, 'MCS', 'Our reply', 'PANEL']]),
  optout: person(3, [[60, 'CUSTOMER', 'STOP'], [10, 'CUSTOMER', 'Do you have a Camry?']]),
  panel: person(4, [[10, 'CUSTOMER', 'Any Accord?'], [5, 'MCS', 'Yes, sending now', 'PANEL']]),
  phone: person(5, [[10, 'CUSTOMER', 'Any Civic?'], [4, 'MCS', 'Typed on the phone']]),
  limit: person(6, [[50, 'CUSTOMER', 'one'], [40, 'CUSTOMER', 'two'], [30, 'CUSTOMER', 'three'], [20, 'CUSTOMER', 'four']]),
  failure: person(7, [[10, 'CUSTOMER', 'Any Tacoma?'], [8, 'CUSTOMER', 'Any Tundra?']]),
  text: person(8, [[10, 'CUSTOMER', 'Hello']]),
  preview: person(9, [[10, 'CUSTOMER', 'Hey']])
};

let backend;
let sentCount = 0;
function sender(result = () => ({ messageId: 'wamid.out.' + (++sentCount) })) {
  const calls = [];
  return { calls, d360Send: async (phone, text) => { calls.push({ phone, text }); return typeof result === 'function' ? result() : result; } };
}
const services = (d360) => ({ rows: server.rows, insert: server.insert, patchRows: server.patchRows, applyMessage: reply.applyMessage, d360Send: d360.d360Send });
const q = async (sql, values) => (await backend.db.query(sql, values)).rows;
const reneMessages = (journey) => q(`select m.body_text,m.direction,m.is_automatic,m.source_kind from public.messages m join public.message_journeys l on l.message_id=m.id where l.journey_id=$1 and m.source_kind='RENE'`, [journey]);

test.before(async () => {
  backend = await createBackend({ seed: Object.values(P).map((p) => p.sql).join('\n') });
  globalThis.fetch = backend.fetch;
});
test.after(async () => { if (backend) await backend.db.close(); });

test('caminho comum: envia pelo d360Send, grava na conversa como RENE e a resposta do bot não bloqueia', async () => {
  const d360 = sender();
  const out = await rene.handle(ctx, { to: P.common.digits, text: 'Yes, we have two RAV4 options', in_reply_to: P.common.wa(1) }, services(d360));
  assert.deepEqual(out, { status: 200, ok: true, messageId: 'wamid.out.1' });
  assert.deepEqual(d360.calls, [{ phone: P.common.phone, text: 'Yes, we have two RAV4 options' }]);
  assert.deepEqual(await reneMessages(P.common.journey), [{ body_text: 'Yes, we have two RAV4 options', direction: 'MCS', is_automatic: false, source_kind: 'RENE' }]);
  const [ids] = await q(`select count(*)::int n from public.whatsapp_message_ids where wa_message_id='wamid.out.1'`);
  assert.equal(ids.n, 1, 'o id do WhatsApp fica ligado, como no envio do painel');
});

test('4. o mesmo in_reply_to já respondido pelo RENE não sai de novo', async () => {
  const d360 = sender();
  const out = await rene.handle(ctx, { to: P.common.digits, text: 'Again', in_reply_to: P.common.wa(1) }, services(d360));
  assert.deepEqual(out, { status: 200, skipped: 'ALREADY_REPLIED' });
  assert.equal(d360.calls.length, 0);
  assert.equal((await reneMessages(P.common.journey)).length, 1);
});

test('6. texto vazio ou com mais de 1000 caracteres', async () => {
  const d360 = sender();
  for (const text of ['', '   ', 'x'.repeat(1001), undefined, 42]) {
    assert.deepEqual(await rene.handle(ctx, { to: P.text.digits, text, in_reply_to: P.text.wa(0) }, services(d360)), { status: 200, skipped: 'TEXT_INVALID' });
  }
  assert.equal(d360.calls.length, 0);
  assert.deepEqual(await rene.handle(ctx, { to: P.text.digits, text: 'y'.repeat(1000), in_reply_to: P.text.wa(0) }, services(d360)), { status: 200, ok: true, messageId: 'wamid.out.' + sentCount });
});

test('1. in_reply_to precisa ser mensagem recebida desse contato nas últimas 24 h', async () => {
  const d360 = sender();
  const cases = [
    { to: P.window.digits, in_reply_to: P.window.wa(0) },   // 25 h atrás
    { to: P.window.digits, in_reply_to: P.window.wa(1) },   // mensagem nossa, não do cliente
    { to: P.window.digits, in_reply_to: 'wamid.nao-existe' },
    { to: P.panel.digits, in_reply_to: P.common.wa(1) },    // mensagem de outro contato
    { to: 'abc', in_reply_to: P.common.wa(1) },
    { to: P.common.digits }
  ];
  for (const body of cases) assert.deepEqual(await rene.handle(ctx, { ...body, text: 'Hi' }, services(d360)), { status: 200, skipped: 'NOT_RECENT_CUSTOMER_MESSAGE' });
  assert.equal(d360.calls.length, 0);
});

test('2. contato que pediu para parar de receber mensagens', async () => {
  const d360 = sender();
  assert.deepEqual(await rene.handle(ctx, { to: P.optout.digits, text: 'We have a Camry', in_reply_to: P.optout.wa(1) }, services(d360)), { status: 200, skipped: 'OPTED_OUT' });
  assert.equal(d360.calls.length, 0);
});

test('3. uma pessoa já respondeu depois (pelo painel ou pelo celular)', async () => {
  const d360 = sender();
  assert.deepEqual(await rene.handle(ctx, { to: P.panel.digits, text: 'Hi', in_reply_to: P.panel.wa(0) }, services(d360)), { status: 200, skipped: 'HUMAN_REPLIED' });
  assert.deepEqual(await rene.handle(ctx, { to: P.phone.digits, text: 'Hi', in_reply_to: P.phone.wa(0) }, services(d360)), { status: 200, skipped: 'HUMAN_REPLIED' });
  assert.equal(d360.calls.length, 0);
});

test('5. no máximo 3 mensagens do RENE por contato em 24 h', async () => {
  // Um envio de 25 h atrás não conta.
  await q(`insert into public.whatsapp_raw_events(environment,event_key,event_type,payload_json,status,received_at) values('preview','rene-send:${P.limit.phone}:wamid.velho','RENE_SEND','{}','DONE',now()-interval '25 hours')`);
  const d360 = sender();
  for (const index of [0, 1, 2]) assert.equal((await rene.handle(ctx, { to: P.limit.digits, text: 'Reply ' + index, in_reply_to: P.limit.wa(index) }, services(d360))).ok, true);
  assert.deepEqual(await rene.handle(ctx, { to: P.limit.digits, text: 'Reply 3', in_reply_to: P.limit.wa(3) }, services(d360)), { status: 200, skipped: 'RATE_LIMIT' });
  assert.equal(d360.calls.length, 3);
  assert.equal((await reneMessages(P.limit.journey)).length, 3);
});

test('falha no 360dialog: recusa clara pode tentar de novo; resposta incerta nunca repete', async () => {
  const refused = sender({ error: 'D360_HTTP_400' });
  assert.deepEqual(await rene.handle(ctx, { to: P.failure.digits, text: 'Hi', in_reply_to: P.failure.wa(0) }, services(refused)), { status: 502, error: 'D360_HTTP_400' });
  assert.equal((await rene.handle(ctx, { to: P.failure.digits, text: 'Hi', in_reply_to: P.failure.wa(0) }, services(sender()))).ok, true);
  const uncertain = sender({ error: 'D360_NETWORK_ERROR' });
  assert.deepEqual(await rene.handle(ctx, { to: P.failure.digits, text: 'Hi', in_reply_to: P.failure.wa(1) }, services(uncertain)), { status: 502, error: 'D360_NETWORK_ERROR' });
  assert.deepEqual(await rene.handle(ctx, { to: P.failure.digits, text: 'Hi', in_reply_to: P.failure.wa(1) }, services(sender())), { status: 200, skipped: 'ALREADY_REPLIED' });
});

function response() { return { code: 0, payload: null, setHeader() {}, status(n) { this.code = n; return this; }, json(v) { this.payload = v; return v; } }; }
async function post(headers, body) { const res = response(); await rene({ method: 'POST', headers, body }, res); return res; }

test('autenticação: x-mcs-secret diferente de RENE_FORWARD_SECRET responde 401', async () => {
  process.env.RENE_FORWARD_SECRET = 'segredo-rene';
  const body = { to: P.text.digits, text: 'Hi', in_reply_to: P.text.wa(0) };
  for (const headers of [{}, { 'x-mcs-secret': 'errado' }, { 'x-mcs-secret': '' }]) assert.equal((await post(headers, body)).code, 401);
  delete process.env.RENE_FORWARD_SECRET;
  assert.equal((await post({ 'x-mcs-secret': '' }, body)).code, 401, 'sem a variável, ninguém entra');
  const res = response(); await rene({ method: 'GET', headers: {} }, res);
  assert.equal(res.code, 405);
});

test('fora de produção: com o segredo certo, o envio é simulado e nada é gravado', async () => {
  process.env.RENE_FORWARD_SECRET = 'segredo-rene';
  try {
    const before = await q(`select count(*)::int n from public.whatsapp_raw_events`);
    const res = await post({ 'x-mcs-secret': 'segredo-rene' }, { to: P.text.digits, text: 'Hi again', in_reply_to: P.text.wa(0) });
    // P.text.wa(0) já foi respondido no teste do texto: o motivo vem antes de qualquer envio.
    assert.deepEqual([res.code, res.payload], [200, { skipped: 'ALREADY_REPLIED' }]);
    // Número sem o 1 do país também vale.
    const fresh = await post({ 'x-mcs-secret': 'segredo-rene' }, { to: P.preview.digits.replace(/^1/, ''), text: 'Hi', in_reply_to: P.preview.wa(0) });
    assert.equal(fresh.code, 200);
    assert.equal(fresh.payload.simulated, true);
    const panelReply = await post({ 'x-mcs-secret': 'segredo-rene' }, { to: P.optout.digits, text: 'x', in_reply_to: P.optout.wa(1) });
    assert.deepEqual(panelReply.payload, { skipped: 'OPTED_OUT' });
    const after = await q(`select count(*)::int n from public.whatsapp_raw_events`);
    assert.equal(after[0].n, before[0].n);
    assert.ok(!backend.refused.some((url) => url.includes('360dialog')), 'o 360dialog nunca é chamado');
  } finally { delete process.env.RENE_FORWARD_SECRET; }
});

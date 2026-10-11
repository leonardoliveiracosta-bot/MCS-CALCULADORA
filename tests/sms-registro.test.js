'use strict';

// "Enviar por SMS" no painel: o SMS sai pelo celular, e o toque fica registrado na conversa como mensagem da MCS (o painel
// passa a saber que o cliente foi respondido). Desfazer tira o registro. O envio pelo WhatsApp e a tradução não mudam.
const test = require('node:test');
const assert = require('node:assert/strict');
const reply = require('../api/panel/reply');

const J = '11111111-1111-4111-8111-111111111111', C = '22222222-2222-4222-8222-222222222222', OTHER = '44444444-4444-4444-8444-444444444444';
const PHONE = '+13055550100', now = Date.parse('2026-10-11T15:00:00Z');
const ctx = { environment: 'production', config: {} };

function memoryDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  const match = (row, key, rule) => {
    const value = row[key];
    if (rule === 'is.null') return value === null || value === undefined;
    if (rule === 'is.true') return value === true;
    if (rule.startsWith('eq.')) return String(value) === rule.slice(3);
    if (rule.startsWith('gte.')) return String(value) >= rule.slice(4);
    throw Error('filter not supported: ' + rule);
  };
  const where = (table, params) => (tables[table] || []).filter((row) => Object.entries(params).every(([key, rule]) => ['select', 'order', 'limit'].includes(key) || match(row, key, rule)));
  let n = 0;
  const services = {
    async rows(_, table, params) { const list = where(table, params); return params.limit ? list.slice(0, Number(params.limit)) : list; },
    async insert(_, table, payload) { n += 1; const row = { id: require('node:crypto').randomUUID(), ...payload }; (tables[table] ||= []).push(row); return [row]; },
    async patchRows(_, table, filters, payload) { const list = where(table, filters); list.forEach((row) => Object.assign(row, payload)); return list; }
  };
  return { tables, services };
}
const seed = (extra = {}) => ({
  journeys: [{ id: J, environment: 'production', contact_id: C, stage: 'NOVO', status: 'ATIVO' }],
  contact_phones: [{ contact_id: C, environment: 'production', phone_e164: PHONE, is_primary: true, is_current: true, retired_at: null }],
  chats: [{ id: 'chat-sms', environment: 'production', contact_id: C, channel: 'SMS', canonical_key: 'sms:' + PHONE }],
  messages: [{ id: 'c1', environment: 'production', chat_id: 'chat-sms', channel: 'SMS', direction: 'CUSTOMER', body_normalized: 'hi', occurred_at_utc: '2026-10-11T14:00:00.000Z', undone_at: null }],
  ...extra
});

test('SMS aberto pelo painel vira mensagem da MCS na conversa do cliente, ligada à ficha', async () => {
  const db = memoryDb(seed());
  const out = await reply.handle(ctx, { action: 'sms_sent', journeyId: J, text: 'https://www.mycarscout.net/o/abc' }, db.services, now);
  assert.equal(out.status, 201);
  assert.equal(out.recorded, true);
  const message = db.tables.messages.find((row) => row.id === out.messageId);
  assert.deepEqual([message.chat_id, message.channel, message.direction, message.source_kind, message.body_text], ['chat-sms', 'SMS', 'MCS', 'PANEL_SMS', 'https://www.mycarscout.net/o/abc']);
  assert.equal(db.tables.message_journeys[0].journey_id, J);
  assert.equal(db.tables.interactions[0].type, 'OUTBOUND_MESSAGE');
  // The same as a WhatsApp answer: Novo becomes Respondido and the contact time moves.
  assert.equal(db.tables.journeys[0].stage, 'RESPONDIDO');
  assert.equal(db.tables.journeys[0].last_effective_contact_at, new Date(now).toISOString());
  // The customer's own message is untouched.
  assert.equal(db.tables.messages.find((row) => row.id === 'c1').direction, 'CUSTOMER');
  // A second tap on the same text a minute later is the same SMS (nothing new).
  const again = await reply.handle(ctx, { action: 'sms_sent', journeyId: J, text: 'https://www.mycarscout.net/o/abc' }, db.services, now + 60000);
  assert.equal(again.duplicate, true);
  assert.equal(db.tables.messages.filter((row) => row.direction === 'MCS').length, 1);
});

test('stage além de Novo não muda; sem conversa SMS ainda, ela é criada para o telefone do cliente', async () => {
  const db = memoryDb(seed({ journeys: [{ id: J, environment: 'production', contact_id: C, stage: 'DECIDINDO', status: 'ATIVO' }], chats: [], messages: [] }));
  const out = await reply.handle(ctx, { action: 'sms_sent', journeyId: J, text: 'Hello' }, db.services, now);
  assert.equal(out.status, 201);
  assert.equal(db.tables.journeys[0].stage, 'DECIDINDO');
  assert.deepEqual([db.tables.chats[0].canonical_key, db.tables.chats[0].contact_id, db.tables.chats[0].channel], ['sms:' + PHONE, C, 'SMS']);
});

test('o número numa conversa SMS de outro contato nunca mistura; texto vazio ou ficha inválida não grava', async () => {
  const db = memoryDb(seed({ chats: [{ id: 'chat-x', environment: 'production', contact_id: OTHER, channel: 'SMS', canonical_key: 'sms:' + PHONE }] }));
  assert.equal((await reply.handle(ctx, { action: 'sms_sent', journeyId: J, text: 'Hello' }, db.services, now)).error, 'SMS_CHAT_OTHER_CONTACT');
  assert.equal((await reply.handle(ctx, { action: 'sms_sent', journeyId: J, text: '  ' }, db.services, now)).error, 'TEXT_REQUIRED');
  assert.equal((await reply.handle(ctx, { action: 'sms_sent', journeyId: 'x', text: 'Hello' }, db.services, now)).error, 'REPLY_NOT_ELIGIBLE');
  assert.equal(db.tables.messages.filter((row) => row.direction === 'MCS').length, 0);
});

test('Desfazer tira o registro (só o SMS do painel, desta ficha, em até 30 minutos)', async () => {
  const db = memoryDb(seed());
  const out = await reply.handle(ctx, { action: 'sms_sent', journeyId: J, text: 'Hello' }, db.services, now);
  const late = await reply.handle(ctx, { action: 'sms_undo', journeyId: J, messageId: out.messageId }, db.services, now + 31 * 60000);
  assert.equal(late.error, 'UNDO_EXPIRED');
  // A customer message is never undone by this.
  assert.equal((await reply.handle(ctx, { action: 'sms_undo', journeyId: J, messageId: 'c1' }, db.services, now)).status, 400);
  const undone = await reply.handle(ctx, { action: 'sms_undo', journeyId: J, messageId: out.messageId }, db.services, now + 60000);
  assert.equal(undone.undone, true);
  assert.ok(db.tables.messages.find((row) => row.id === out.messageId).undone_at);
  assert.ok(db.tables.message_journeys[0].undone_at);
  assert.equal(db.tables.messages.find((row) => row.id === 'c1').undone_at, null);
});

test('fora de produção nada é gravado (o mesmo cuidado do envio pelo WhatsApp)', async () => {
  const db = memoryDb(seed());
  const real = { ...db.services, patchRows: require('../panel-server').patchRows };
  const before = process.env.VERCEL_ENV; process.env.VERCEL_ENV = 'preview';
  try {
    const out = await reply.handle(ctx, { action: 'sms_sent', journeyId: J, text: 'Hello' }, real, now);
    assert.deepEqual([out.status, out.recorded, out.simulated], [200, false, true]);
    assert.equal(db.tables.messages.length, 1);
  } finally { if (before === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = before; }
});

// The same record against the real schema (every migration, PGlite): the message, its link to the ficha, the interaction and
// the stage pass the database's own rules, and the ficha's conversation shows it as a message from MCS.
test('no banco de verdade: o SMS registrado aparece na conversa da ficha como mensagem da MCS', async () => {
  const { BASE, createBackend } = require('./fixtures/banco-simulado');
  const id = (n) => `6e500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const seedSql = [
    `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
    `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(11)}','preview','Cliente SMS','SMS_DIRECT',now(),now());`,
    `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,is_primary,created_at) values('preview','${id(11)}','+13055550177','+13055550177',true,true,now());`,
    `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(10)}','preview','${id(11)}','SMS_DIRECT','NOVO','ATIVO','{}',now(),now());`
  ].join('\n');
  const before = { url: process.env.SUPABASE_URL, env: process.env.VERCEL_ENV, fetch: globalThis.fetch };
  const backend = await createBackend({ seed: seedSql });
  try {
    Object.assign(process.env, { SUPABASE_URL: BASE, VERCEL_ENV: 'production' });
    globalThis.fetch = backend.fetch;
    const real = { environment: 'preview', config: { url: BASE, secretKey: 'secreta-simulada' } };
    const out = await reply.handle(real, { action: 'sms_sent', journeyId: id(10), text: 'Here are your options' });
    assert.equal(out.status, 201, JSON.stringify(out));
    const { rows: [message] } = await backend.db.query(`select m.channel, m.direction, m.source_kind, m.body_text, c.canonical_key from public.messages m join public.chats c on c.id = m.chat_id where m.id = $1`, [out.messageId]);
    assert.deepEqual(message, { channel: 'SMS', direction: 'MCS', source_kind: 'PANEL_SMS', body_text: 'Here are your options', canonical_key: 'sms:+13055550177' });
    const { rows: [journey] } = await backend.db.query(`select stage from public.journeys where id = $1`, [id(10)]);
    assert.equal(journey.stage, 'RESPONDIDO');
    const undone = await reply.handle(real, { action: 'sms_undo', journeyId: id(10), messageId: out.messageId });
    assert.equal(undone.undone, true);
    const { rows: [after] } = await backend.db.query(`select undone_at is not null as undone from public.messages where id = $1`, [out.messageId]);
    assert.equal(after.undone, true);
  } finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of [['SUPABASE_URL', before.url], ['VERCEL_ENV', before.env]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await backend.db.close();
  }
});

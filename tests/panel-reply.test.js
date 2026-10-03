'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const reply = require('../api/panel/reply');
const { buildWeeklySummary } = require('../panel-weekly');

const HOUR = 3600000, now = Date.parse('2026-09-28T15:00:00Z'), iso = (offset) => new Date(now + offset).toISOString();
const J = '11111111-1111-4111-8111-111111111111', C = '22222222-2222-4222-8222-222222222222', CHAT = '33333333-3333-4333-8333-333333333333';
const ctx = { environment: 'production', config: {} };

// Banco em memória que entende os filtros PostgREST usados pelo endpoint.
function memoryDb(seed) {
  const tables = JSON.parse(JSON.stringify(seed));
  const match = (row, key, rule) => {
    const value = row[key];
    if (rule === 'is.null') return value === null || value === undefined;
    if (rule === 'not.is.null') return value !== null && value !== undefined;
    if (rule === 'is.true') return value === true;
    if (rule === 'is.false') return value === false;
    if (rule.startsWith('eq.')) return String(value) === rule.slice(3);
    throw Error('filter not supported: ' + rule);
  };
  const calls = { rows: [], d360: [], insert: [], apply: [], ai: [] };
  const services = {
    async rows(_, table, params) {
      calls.rows.push({ table, params });
      let list = (tables[table] || []).filter((row) => Object.entries(params).every(([key, rule]) => ['select', 'order', 'limit'].includes(key) || match(row, key, rule)));
      if (params.order) { const [key, dir] = params.order.split('.'); list = list.sort((a, b) => (dir === 'desc' ? -1 : 1) * String(a[key]).localeCompare(String(b[key]))); }
      return params.limit ? list.slice(0, Number(params.limit)) : list;
    },
    async insert(_, table, payload) { calls.insert.push({ table, payload }); const row = { id: 'raw-' + calls.insert.length, ...payload }; (tables[table] ||= []).push(row); return [row]; },
    async applyMessage(_, rawId, item) {
      calls.apply.push({ rawId, item });
      // o que a RPC grava (conferido de verdade em tests/sql/teste-painel-resposta.sql)
      tables.messages.push({ id: 'm-' + item.messageId, chat_id: CHAT, direction: item.direction, is_automatic: false, source_kind: item.source_kind, body_text: item.body, occurred_at_utc: new Date(Number(item.timestamp) * 1000).toISOString() });
      return { messageId: 'm-' + item.messageId, duplicate: false };
    },
    async d360Send(phone, text) { calls.d360.push({ phone, text }); return { messageId: 'wamid.OK' }; },
    async anthropicJson(system, user) { calls.ai.push({ system, user }); return { en: 'Hey, the car is ready.', pt_back: 'Oi, o carro está pronto.' }; }
  };
  return { tables, services, calls };
}

function seed(overrides = {}) {
  return {
    journeys: [{ id: J, environment: 'production', contact_id: C, reference_code: 'ABCDE' }],
    contacts: [{ id: C, environment: 'production', display_name: 'Maria' }],
    chats: [{ id: CHAT, environment: 'production', contact_id: C, channel: 'WHATSAPP', is_group: false, canonical_key: 'wa:+13055550100' }],
    contact_phones: [{ contact_id: C, environment: 'production', phone_e164: '+13055550100', is_current: true, retired_at: null }],
    messages: [
      { id: 'c1', environment: 'production', chat_id: CHAT, direction: 'CUSTOMER', occurred_at_utc: iso(-5 * HOUR), undone_at: null },
      { id: 'm1', environment: 'production', chat_id: CHAT, direction: 'MCS', occurred_at_utc: iso(-1 * HOUR), undone_at: null }
    ],
    ...overrides
  };
}

test('window uses only CUSTOMER messages', async () => {
  const db = memoryDb(seed());
  const out = await reply.handle(ctx, { action: 'window', journeyId: J }, db.services, now);
  assert.equal(out.status, 200);
  assert.equal(out.allowed, true);
  assert.equal(out.openUntil, iso(19 * HOUR)); // cliente -5 h + 24 h; a MCS de -1 h não conta
  const query = db.calls.rows.find((call) => call.table === 'messages').params;
  assert.equal(query.direction, 'eq.CUSTOMER');
  assert.equal(query.chat_id, 'eq.' + CHAT);

  const onlyMcs = memoryDb(seed({ messages: [{ id: 'm1', environment: 'production', chat_id: CHAT, direction: 'MCS', occurred_at_utc: iso(-HOUR), undone_at: null }] }));
  const none = await reply.handle(ctx, { action: 'window', journeyId: J }, onlyMcs.services, now);
  assert.equal(none.status, 200); assert.equal(none.allowed, false); assert.equal(none.openUntil, undefined);
  assert.equal(none.whatsappBase, 'https://wa.me/' + none.phone.replace(/^\+/, ''));

  const old = memoryDb(seed({ messages: [{ id: 'c1', environment: 'production', chat_id: CHAT, direction: 'CUSTOMER', occurred_at_utc: iso(-25 * HOUR), undone_at: null }, { id: 'm1', environment: 'production', chat_id: CHAT, direction: 'MCS', occurred_at_utc: iso(-HOUR), undone_at: null }] }));
  const closed = await reply.handle(ctx, { action: 'window', journeyId: J }, old.services, now);
  assert.equal(closed.allowed, false);
  assert.equal(closed.openUntil, iso(-HOUR));
});

test('closed window returns 400 and nothing is sent', async () => {
  const db = memoryDb(seed({ messages: [{ id: 'c1', environment: 'production', chat_id: CHAT, direction: 'CUSTOMER', occurred_at_utc: iso(-24 * HOUR - 1000), undone_at: null }] }));
  const out = await reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'Hello' }, db.services, now);
  assert.deepEqual(out, { status: 400, error: 'WINDOW_CLOSED' });
  assert.equal(db.calls.d360.length, 0);
  assert.equal(db.calls.insert.length, 0);
  assert.equal(db.calls.apply.length, 0);
});

test('360dialog failure leaves no message row', async () => {
  const db = memoryDb(seed());
  db.services.d360Send = async () => ({ error: 'D360_HTTP_470' });
  const before = db.tables.messages.length;
  const out = await reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'Hello' }, db.services, now);
  assert.deepEqual(out, { status: 502, error: 'D360_HTTP_470' });
  assert.equal(db.tables.messages.length, before);
  assert.equal(db.calls.insert.length, 0);
  assert.equal(db.calls.apply.length, 0);
  assert.equal((db.tables.whatsapp_raw_events || []).length, 0);
});

test('successful send registers a synthetic raw event and a PANEL MCS message', async () => {
  const db = memoryDb(seed());
  const out = await reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'Hey, the car is ready.' }, db.services, now);
  assert.deepEqual(out, { status: 200, ok: true, messageId: 'wamid.OK' });
  assert.deepEqual(db.calls.d360, [{ phone: '+13055550100', text: 'Hey, the car is ready.' }]);
  const raw = db.calls.insert[0];
  assert.equal(raw.table, 'whatsapp_raw_events');
  assert.match(raw.payload.event_key, /^panel-send:[0-9a-f-]{36}$/);
  assert.equal(raw.payload.event_type, 'PANEL_SEND');
  assert.deepEqual(raw.payload.payload_json, {});
  assert.equal(raw.payload.status, 'DONE');
  const { rawId, item } = db.calls.apply[0];
  assert.equal(rawId, 'raw-1');
  assert.equal(item.direction, 'MCS');
  assert.equal(item.source_kind, 'PANEL');
  assert.equal(item.body, 'Hey, the car is ready.');
  assert.equal(item.phone, '+13055550100');
  assert.equal(item.messageId, 'wamid.OK');
  assert.equal(item.forceContactId, C);
  assert.deepEqual(item.refs, ['ABCDE']);
  assert.equal(item.timestamp, String(Math.floor(now / 1000)));
  const row = db.tables.messages.at(-1);
  assert.equal(row.direction, 'MCS'); assert.equal(row.is_automatic, false); assert.equal(row.source_kind, 'PANEL');
});

test('send validates text, and the per-journey lock blocks a second send in flight', async () => {
  const db = memoryDb(seed());
  assert.equal((await reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'x'.repeat(4001) }, db.services, now)).error, 'TEXT_TOO_LONG');
  assert.equal((await reply.handle(ctx, { action: 'send', journeyId: J, textEn: '  ' }, db.services, now)).error, 'TEXT_REQUIRED');
  let release; db.services.d360Send = () => new Promise((resolve) => { release = () => resolve({ messageId: 'wamid.X' }); });
  const first = reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'One' }, db.services, now);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'Two' }, db.services, now), { status: 409, error: 'SEND_IN_PROGRESS' });
  release();
  assert.equal((await first).ok, true);
  db.services.d360Send = async () => ({ messageId: 'wamid.Y' });
  assert.equal((await reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'Three' }, db.services, now)).ok, true);
});

test('a failed registration after a real send says so instead of claiming nothing was sent', async () => {
  const db = memoryDb(seed());
  db.services.applyMessage = async () => { throw Error('RPC down'); };
  assert.deepEqual(await reply.handle(ctx, { action: 'send', journeyId: J, textEn: 'Hi' }, db.services, now), { status: 500, error: 'SENT_NOT_RECORDED', messageId: 'wamid.OK' });
});

test('translate returns valid JSON with en and pt_back, without the daily AI reservation', async () => {
  const db = memoryDb(seed());
  const out = await reply.handle(ctx, { action: 'translate', text: 'Oi, o carro está pronto.' }, db.services, now);
  assert.deepEqual(out, { status: 200, en: 'Hey, the car is ready.', pt_back: 'Oi, o carro está pronto.' });
  assert.match(db.calls.ai[0].system, /SOMENTE JSON/);
  assert.match(db.calls.ai[0].system, /"en"/); assert.match(db.calls.ai[0].system, /"pt_back"/);
  assert.equal(db.calls.ai[0].user, 'Oi, o carro está pronto.');
  db.services.anthropicJson = async () => ({ en: 'Hi — ready', pt_back: 'Oi, pronto' });
  assert.equal((await reply.handle(ctx, { action: 'translate', text: 'Oi' }, db.services, now)).en, 'Hi, ready');
  db.services.anthropicJson = async () => { throw Error('AI_UNAVAILABLE'); };
  assert.deepEqual(await reply.handle(ctx, { action: 'translate', text: 'Oi' }, db.services, now), { status: 502, error: 'AI_UNAVAILABLE' });
  db.services.anthropicJson = async () => ({ en: 'only english' });
  assert.deepEqual(await reply.handle(ctx, { action: 'translate', text: 'Oi' }, db.services, now), { status: 502, error: 'AI_UNAVAILABLE' });
  assert.equal((await reply.handle(ctx, { action: 'translate', text: 'x'.repeat(4001) }, db.services, now)).error, 'TEXT_TOO_LONG');
  const source = fs.readFileSync('api/panel/reply.js', 'utf8');
  assert.doesNotMatch(source, /reserveCall|claim_auto_reply|finish_auto_reply/);
});

test('group, phoneless, ambiguous or multi-chat targets return REPLY_NOT_ELIGIBLE', async () => {
  const cases = {
    group: seed({ chats: [{ id: CHAT, environment: 'production', contact_id: C, channel: 'WHATSAPP', is_group: true, canonical_key: 'wa:+13055550100' }] }),
    noChat: seed({ chats: [] }),
    twoChats: seed({ chats: [seed().chats[0], { ...seed().chats[0], id: 'other', canonical_key: 'wa:+13055550101' }] }),
    phoneless: seed({ chats: [{ ...seed().chats[0], canonical_key: 'wa-user:US.abc' }] }),
    phoneRetired: seed({ contact_phones: [{ ...seed().contact_phones[0], retired_at: iso(-HOUR) }] }),
    phoneNotCurrent: seed({ contact_phones: [{ ...seed().contact_phones[0], is_current: false }] }),
    phoneShared: seed({ contact_phones: [seed().contact_phones[0], { ...seed().contact_phones[0], contact_id: 'someone-else' }] })
  };
  for (const [name, data] of Object.entries(cases)) {
    for (const action of ['window', 'send']) {
      const db = memoryDb(data);
      const out = await reply.handle(ctx, { action, journeyId: J, textEn: 'Hi' }, db.services, now);
      assert.deepEqual(out, { status: 400, error: 'REPLY_NOT_ELIGIBLE' }, name + ':' + action);
      assert.equal(db.calls.d360.length, 0, name);
    }
  }
  const db = memoryDb(seed());
  assert.deepEqual(await reply.handle(ctx, { action: 'window', journeyId: 'not-a-uuid' }, db.services, now), { status: 400, error: 'REPLY_NOT_ELIGIBLE' });
});

test('a PANEL reply counts as my reply: weekly summary and every "my reply" read key on direction, not source_kind', () => {
  const journeys = [{ id: 'j1', contact_id: 'c1', source: 'WHATSAPP_DIRECT', status: 'ATIVO', created_at: iso(-30 * HOUR) }];
  const messages = [{ id: 'in', direction: 'CUSTOMER', source_kind: 'WHATSAPP_WEBHOOK', created_at: iso(-30 * HOUR) }, { id: 'out', direction: 'MCS', is_automatic: false, source_kind: 'PANEL', created_at: iso(-30 * HOUR + 15 * 60000) }];
  const messageLinks = [{ journey_id: 'j1', message_id: 'in' }, { journey_id: 'j1', message_id: 'out' }];
  const result = buildWeeklySummary({ journeys, messageLinks, messages, units: [], dispositions: [] }, now);
  assert.equal(result.responded.current, 1);
  assert.equal(result.averageResponseMinutes.current, 15);
  assert.equal(result.unanswered24h.current, 0);
  // HOJE e CLIENTES: a última resposta minha é a última MCS, venha de onde vier
  const today = fs.readFileSync('api/panel/today.js', 'utf8'), records = fs.readFileSync('api/panel/records.js', 'utf8'), entry = fs.readFileSync('api/panel/entry.js', 'utf8'), weekly = fs.readFileSync('panel-weekly.js', 'utf8');
  assert.match(today, /latestMcsMessage=timedMessages\.find\(\(message\)=>message\.direction==='MCS'\)/);
  // CLIENTES: the database summary keeps the latest MCS message by direction (panel_journey_message_facts).
  assert.match(records, /latestMcsMessage=summary\.last_mcs_id\?\{id:summary\.last_mcs_id,direction:'MCS'/);
  assert.match(fs.readFileSync('supabase/migrations/20261014010000_clientes_resumo_mensagens.sql', 'utf8'), /direction = 'MCS'/);
  assert.match(entry, /item\.direction === 'MCS' && !item\.is_automatic/);
  assert.match(weekly, /item\.direction==='MCS'&&!item\.is_automatic/);
});

test('panel UI: composer at the end of CONVERSA, Florida window line, send only after translation', () => {
  const panel = fs.readFileSync('painel/painel.js', 'utf8');
  assert.match(panel, /renderConversation\(\);\n\s+replyComposer\(conversationBlock, id, reload\);\n\s+right\.append\(conversationBlock\);/);
  // The window line and the send live in the shared send control (sugestoes.js): Florida time,
  // one path per window state, provider errors said as "not sent, nothing recorded".
  const shared = fs.readFileSync('painel/sugestoes.js', 'utf8');
  assert.match(shared, /'Janela de 24 h aberta' \+ \(data\.path\.until \? ' até ' \+ clock\(data\.path\.until\) \+ ' \(Flórida\)' : ''\)/);
  assert.match(shared, /timeZone: 'America\/New_York'/);
  assert.match(shared, /abre a conversa no WhatsApp do celular com o texto preenchido/);
  assert.match(panel, /translatedFor !== pt\.value\.trim\(\)/);
  assert.match(shared, /Não enviado · nada foi registrado/);
  assert.match(panel, /IA indisponível/);
  const composer = panel.slice(panel.indexOf('async function replyComposer'), panel.indexOf('async function globalSearch'));
  assert.doesNotMatch(composer, /—/);
  assert.doesNotMatch(fs.readFileSync('api/panel/reply.js', 'utf8'), /—/);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const handler = require('../api/sms/inbound');
const { contactIndex } = require('../panel-contact');

const now = Date.parse('2026-09-28T15:00:00Z');
const ctx = { environment: 'production', config: {} };
const C1 = 'c1', C2 = 'c2';

function memoryDb(overrides = {}) {
  const tables = {
    contacts: [{ id: C1, environment: 'production', display_name: 'João Silva' }, { id: C2, environment: 'production', display_name: 'Ana Costa' }],
    contact_phones: [{ contact_id: C1, environment: 'production', phone_e164: '+13055550100', is_current: true, retired_at: null }],
    journeys: [
      { id: 'j1-old', environment: 'production', contact_id: C1, reference_code: 'PQRST', status: 'ATIVO', created_at: '2026-09-01T00:00:00Z' },
      { id: 'j1', environment: 'production', contact_id: C1, reference_code: 'ABCDE', vehicle_text: 'Honda Civic', status: 'ATIVO', created_at: '2026-09-20T00:00:00Z' },
      { id: 'j1-closed', environment: 'production', contact_id: C1, reference_code: null, status: 'ENCERRADO', created_at: '2026-09-25T00:00:00Z' },
      { id: 'j2', environment: 'production', contact_id: C2, reference_code: 'XYZ23', status: 'ATIVO', created_at: '2026-09-10T00:00:00Z' }
    ],
    journey_refs: [], chats: [], messages: [], message_journeys: [], interactions: [],
    ...overrides
  };
  const calls = { push: [], writes: [] };
  let seq = 0;
  const match = (row, key, rule) => {
    if (key === 'and') {
      const [, gte, lt] = rule.match(/^\(occurred_at_utc\.gte\.(.+),occurred_at_utc\.lt\.(.+)\)$/);
      return row.occurred_at_utc >= gte && row.occurred_at_utc < lt;
    }
    const value = row[key];
    if (rule === 'is.null') return value == null;
    if (rule === 'is.true') return value === true;
    if (rule.startsWith('eq.')) return String(value) === rule.slice(3);
    throw Error('filter ' + rule);
  };
  const select = (table, params) => {
    let list = tables[table].filter((row) => Object.entries(params).every(([key, rule]) => ['select', 'order', 'limit'].includes(key) || match(row, key, rule)));
    if (params.order) { const [key, dir] = params.order.split('.'); list = list.slice().sort((a, b) => (dir === 'desc' ? -1 : 1) * String(a[key]).localeCompare(String(b[key]))); }
    return params.limit ? list.slice(0, Number(params.limit)) : list;
  };
  const services = {
    // The calculator Ref proven for the ficha (panel-ref-proof); here ABCDE has its simulation, any other code does not.
    calcRef: async (_, journey) => journey && journey.reference_code === 'ABCDE' ? 'ABCDE' : null,
    rows: async (_, table, params) => select(table, params),
    allRows: async (_, table, params) => select(table, params),
    async insert(_, table, payload) {
      if (table === 'chats' && tables.chats.some((chat) => chat.canonical_key === payload.canonical_key && chat.channel === payload.channel)) throw Error('duplicate key');
      const row = { id: table + '-' + (++seq), ...payload }; tables[table].push(row); calls.writes.push(table); return [row];
    },
    async patchRows(_, table, filters, payload) { calls.writes.push(table + ':patch'); tables[table].filter((row) => 'eq.' + row.id === filters.id).forEach((row) => Object.assign(row, payload)); },
    push(_, input) { calls.push.push(input); return Promise.resolve({ accepted: 1 }); }
  };
  return { tables, calls, services };
}

async function captureLogs(fn) {
  const lines = [], original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of Object.keys(original)) console[name] = (...args) => lines.push(args.map((arg) => JSON.stringify(arg)).join(' '));
  try { return { result: await fn(), lines }; } finally { Object.assign(console, original); }
}

test('unknown number without ref: 200 stored:false, nothing stored, nothing logged', async () => {
  const db = memoryDb();
  const { result, lines } = await captureLogs(() => handler.receive(ctx, { sender: '+1 (786) 555-0199', senderName: 'Stranger', text: 'secret family message', date: '2026-09-28T14:59:00Z' }, db.services, now));
  assert.deepEqual(result, { stored: false });
  assert.deepEqual(db.calls.writes, []);
  assert.equal(db.calls.push.length, 0);
  assert.equal(lines.length, 0);
});

test('known client number: CUSTOMER/SMS stored, linked to latest open journey, chat touched, push sent', async () => {
  const db = memoryDb();
  const result = await handler.receive(ctx, { sender: '(305) 555-0100', senderName: 'Joao', text: '  Is the  car still available? ', date: '2026-09-28T14:58:30Z' }, db.services, now);
  assert.equal(result.stored, true);
  const [message] = db.tables.messages;
  assert.equal(message.direction, 'CUSTOMER'); assert.equal(message.channel, 'SMS'); assert.equal(message.source_kind, 'SMS_SHORTCUT');
  assert.equal(message.time_uncertain, true); assert.equal(message.body_text, 'Is the  car still available?'); assert.equal(message.body_normalized, 'is the car still available?');
  assert.equal(message.occurred_at_utc, '2026-09-28T14:58:30.000Z');
  const [chat] = db.tables.chats;
  assert.equal(chat.canonical_key, 'sms:+13055550100'); assert.equal(chat.channel, 'SMS'); assert.equal(chat.is_group, false); assert.equal(chat.resolution_status, 'RESOLVED'); assert.equal(chat.contact_id, C1);
  assert.equal(chat.last_seen_at, new Date(now).toISOString());
  assert.deepEqual(db.tables.message_journeys.map((link) => [link.message_id, link.journey_id]), [[message.id, 'j1']]);
  assert.deepEqual(db.calls.push, [{ contactId: C1, messageId: message.id, payload: { type: 'customer-message', messageId: message.id, journeyId: 'j1', title: 'João Silva · Ref ABCDE · Honda Civic' } }]);
  // HOJE: o contato passa a ter entrada recente, rotulada como SMS
  const facts = contactIndex({ messages: db.tables.messages, messageLinks: db.tables.message_journeys }).facts({ journeyId: 'j1' });
  assert.equal(facts.entered, true); assert.equal(facts.channel, 'SMS'); assert.equal(facts.latestAt, Date.parse('2026-09-28T14:58:30Z'));
});

test('ref in the text links an unknown number to the ref journey', async () => {
  const db = memoryDb();
  const result = await handler.receive(ctx, { sender: '+17865550199', text: 'Hi, my ref is XYZ23, any news?', date: 'not a date' }, db.services, now);
  assert.equal(result.stored, true);
  assert.equal(db.tables.message_journeys[0].journey_id, 'j2');
  assert.equal(db.tables.chats[0].contact_id, C2);
  assert.equal(db.tables.messages[0].occurred_at_utc, new Date(now).toISOString()); // data inválida vira agora
  // cliente conhecido citando uma Ref própria mais antiga: vai para essa ficha
  const known = memoryDb();
  await handler.receive(ctx, { sender: '3055550100', text: 'About PQRST please', date: '2026-09-28T14:00:00Z' }, known.services, now);
  assert.equal(known.tables.message_journeys[0].journey_id, 'j1-old');
  // Ref em minúsculas ou colada em outra palavra não conta
  const lower = memoryDb();
  assert.deepEqual(await handler.receive(ctx, { sender: '+17865550199', text: 'my ref xyz23 / REFXYZ23' }, lower.services, now), { stored: false });
});

test('duplicate in the same minute keeps one row', async () => {
  const db = memoryDb();
  const body = { sender: '+13055550100', text: 'Hello there', date: '2026-09-28T14:58:10Z' };
  assert.equal((await handler.receive(ctx, body, db.services, now)).stored, true);
  assert.deepEqual(await handler.receive(ctx, { ...body, text: 'hello   THERE', date: '2026-09-28T14:58:50Z' }, db.services, now), { stored: false, duplicate: true });
  assert.equal(db.tables.messages.length, 1);
  assert.equal((await handler.receive(ctx, { ...body, date: '2026-09-28T14:59:05Z' }, db.services, now)).stored, true); // outro minuto
  assert.equal(db.tables.messages.length, 2);
});

test('name match: exactly one contact (accents ignored) stores; two equal names discard', async () => {
  const one = memoryDb();
  assert.equal((await handler.receive(ctx, { sender: '', senderName: '  joao   SILVA ', text: 'Oi' }, one.services, now)).stored, true);
  assert.equal(one.tables.chats[0].canonical_key, 'sms:name:' + C1);
  const two = memoryDb({ contacts: [{ id: C1, environment: 'production', display_name: 'João Silva' }, { id: C2, environment: 'production', display_name: 'Joao Silva' }] });
  assert.deepEqual(await handler.receive(ctx, { senderName: 'João Silva', text: 'Oi, ref XYZ23' }, two.services, now), { stored: false });
  assert.deepEqual(two.calls.writes, []);
  const none = memoryDb();
  assert.deepEqual(await handler.receive(ctx, { senderName: 'Maria', text: 'Oi' }, none.services, now), { stored: false });
});

test('ambiguous phone, phone of a chat owned by someone else, empty or long text are not stored', async () => {
  const shared = memoryDb({ contact_phones: [{ contact_id: C1, environment: 'production', phone_e164: '+13055550100', is_current: true, retired_at: null }, { contact_id: C2, environment: 'production', phone_e164: '+13055550100', is_current: true, retired_at: null }] });
  assert.deepEqual(await handler.receive(ctx, { sender: '+13055550100', text: 'Oi' }, shared.services, now), { stored: false });
  const owned = memoryDb({ chats: [{ id: 'x', environment: 'production', channel: 'SMS', canonical_key: 'sms:+17865550199', contact_id: C1 }] });
  assert.deepEqual(await handler.receive(ctx, { sender: '+17865550199', text: 'ref XYZ23' }, owned.services, now), { stored: false });
  const db = memoryDb();
  assert.deepEqual(await handler.receive(ctx, { sender: '+13055550100', text: '   ' }, db.services, now), { stored: false });
  assert.deepEqual(await handler.receive(ctx, { sender: '+13055550100', text: 'x'.repeat(25001) }, db.services, now), { stored: false });
  assert.deepEqual(db.calls.writes, []);
});

function fakeRes() { return { statusCode: 0, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(value) { this.body = value || ''; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = JSON.stringify(value); return this; } }; }
async function callWith(target, headers, body, env = { SMS_INBOUND_SECRET: 'right-secret' }, method = 'POST') {
  const saved = { ...process.env }; Object.assign(process.env, env);
  const req = { method, headers, body, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(body)); } };
  const res = fakeRes();
  try { await target(req, res); } finally { for (const key of Object.keys(env)) { if (key in saved) process.env[key] = saved[key]; else delete process.env[key]; } }
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

test('bad or missing secret is 401; a valid secret always answers 200', async () => {
  const body = { sender: '+17865550199', text: 'hello' };
  const call = (...args) => callWith(handler, ...args);
  assert.equal((await call({}, body)).status, 401);
  assert.equal((await call({ 'x-sms-secret': 'wrong' }, body)).status, 401);
  assert.equal((await call({ 'x-sms-secret': 'right-secret' }, body, {})).status, 401); // segredo ausente no servidor
  // recarrega com VERCEL_ENV=production para passar pela gravação de verdade
  const previousEnv = process.env.VERCEL_ENV; process.env.VERCEL_ENV = 'production';
  const fresh = () => { for (const key of Object.keys(require.cache)) if (!key.includes('node_modules') && !key.endsWith('.test.js')) delete require.cache[key]; return require('../api/sms/inbound'); };
  const live = fresh();
  const db = memoryDb(); live.services = db.services;
  const callLive = (headers, payload, env) => callWith(live, headers, payload, env);
  const env = { SMS_INBOUND_SECRET: 'right-secret', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'p', SUPABASE_SECRET_KEY: 's' };
  try {
    const { result, lines } = await captureLogs(() => callLive({ 'x-sms-secret': 'right-secret' }, body, env));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { stored: false });
    assert.equal(lines.length, 0);
    const realRows = db.services.rows; db.services.rows = async () => { throw Error('SUPABASE_DOWN'); };
    const failed = await captureLogs(() => callLive({ 'x-sms-secret': 'right-secret' }, { sender: '+13055550100', text: 'private words here' }, env));
    assert.deepEqual(failed.result, { status: 200, body: { stored: false } });
    assert.deepEqual(failed.lines, ['"[sms-inbound] falha ao processar"']);
    db.services.rows = realRows;
    const stored = await callLive({ 'x-sms-secret': 'right-secret' }, { sender: '+13055550100', text: 'Real one' }, env);
    assert.deepEqual(stored, { status: 200, body: { stored: true } });
  } finally { if (previousEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previousEnv; fresh(); }
});

test('current secret and active device code are accepted; wrong and revoked codes are 401', async () => {
  const previousEnv = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  const fresh = () => { for (const key of Object.keys(require.cache)) if (!key.includes('node_modules') && !key.endsWith('.test.js')) delete require.cache[key]; return require('../api/sms/inbound'); };
  const live = fresh();
  const code = 'iphone-device-code';
  const tokenHash = require('node:crypto').createHash('sha256').update(code).digest('hex');
  let revoked = false;
  live.services = {
    rows: async (_ctx, table) => table === 'sms_device_tokens' && !revoked ? [{ token_hash: tokenHash }] : [],
    allRows: async () => [], insert: async () => [], patchRows: async () => [], push: async () => null
  };
  const env = { SMS_INBOUND_SECRET: 'right-secret', SUPABASE_URL: 'https://x.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'p', SUPABASE_SECRET_KEY: 's' };
  try {
    assert.equal((await callWith(live, { 'x-sms-secret': 'right-secret' }, { text: 'hello' }, env)).status, 200);
    assert.equal((await callWith(live, { 'x-sms-secret': code }, { text: 'hello' }, env)).status, 200);
    assert.equal((await callWith(live, { 'x-sms-secret': 'wrong-device-code' }, { text: 'hello' }, env)).status, 401);
    revoked = true;
    assert.equal((await callWith(live, { 'x-sms-secret': code }, { text: 'hello' }, env)).status, 401);
  } finally {
    if (previousEnv === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = previousEnv;
    fresh();
  }
});

test('endpoint source: timing-safe secret, never logs the body, no panel auth, no vercel.json route', () => {
  const source = fs.readFileSync('api/sms/inbound.js', 'utf8');
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /process\.env\.SMS_INBOUND_SECRET/);
  assert.doesNotMatch(source, /requirePanel/);
  assert.doesNotMatch(source, /console\.(log|info|warn)\(/);
  assert.deepEqual(source.match(/console\.\w+\([^;]*\);/g), ["console.error('[sms-inbound] falha ao processar');"]);
  assert.doesNotMatch(fs.readFileSync('vercel.json', 'utf8'), /sms\/inbound/);
  assert.equal(handler.messageDate('2008-12-31T00:00:00Z', now), now);
  assert.equal(handler.messageDate(new Date(now + 2 * 86400000).toISOString(), now), now);
});

test('GET and other methods answer 405 before touching the secret', async () => {
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const out = await callWith(handler, { 'x-sms-secret': 'right-secret' }, {}, { SMS_INBOUND_SECRET: 'right-secret' }, method);
    assert.equal(out.status, 405, method);
  }
});

test('secret of a different size is 401 without calling timingSafeEqual; same size compares safely', async () => {
  const crypto = require('node:crypto'), original = crypto.timingSafeEqual; const sizes = [];
  crypto.timingSafeEqual = (a, b) => { sizes.push([a.length, b.length]); return original(a, b); };
  try {
    for (const secret of ['x', 'right-secre', 'right-secret-longer', 'ríght-secret']) {
      const out = await callWith(handler, { 'x-sms-secret': secret }, { text: 'hi' });
      assert.equal(out.status, 401, secret);
    }
    assert.deepEqual(sizes, []);
    assert.equal((await callWith(handler, { 'x-sms-secret': 'wrong-secret' }, { text: 'hi' })).status, 401); // mesmo tamanho, conteúdo errado
    assert.deepEqual(sizes, [[12, 12]]);
    assert.equal(handler.secretMatches(['right-secret'], 'right-secret'), false);
  } finally { crypto.timingSafeEqual = original; }
});

test('ref search uses word boundaries', async () => {
  for (const text of ['REFXYZ23', 'XYZ23ABC', 'aXYZ23', 'XYZ234']) {
    const db = memoryDb();
    assert.deepEqual(await handler.receive(ctx, { sender: '+17865550199', text }, db.services, now), { stored: false }, text);
  }
  for (const text of ['XYZ23', '(XYZ23)', 'ref: XYZ23.', 'XYZ23, thanks']) {
    const db = memoryDb();
    assert.equal((await handler.receive(ctx, { sender: '+17865550199', text }, db.services, now)).stored, true, text);
  }
});

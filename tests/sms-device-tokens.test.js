'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const uuid = '00000000-0000-4000-8000-000000000001';

function loadWith(relative, mocks) {
  const file = path.join(root, relative); const mod = { exports: {} };
  const localRequire = (name) => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(localRequire, mod, mod.exports);
  return mod.exports;
}

function output() {
  return { code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return payload; } };
}

function server(overrides = {}) {
  return {
    requirePanel: async () => ({ environment: 'production', panel: { id: uuid }, config: {} }),
    jsonBody: async (req) => req.body || {},
    send: (res, code, payload) => res.status(code).json(payload),
    safeText: (value, maximum, required) => { const text = String(value || '').trim(); return (required && !text) || text.length > maximum ? null : text; },
    isUuid: (value) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(String(value || '')),
    allRows: async () => [], patchRows: async () => [], rpc: async () => [],
    ...overrides
  };
}

test('panel API requires requirePanel before listing or changing device codes', async () => {
  let touched = false;
  const handler = loadWith('api/panel/sms-device-tokens.js', { '../../panel-server': server({ requirePanel: async () => null, allRows: async () => { touched = true; } }) });
  const res = output();
  await handler({ method: 'GET' }, res);
  assert.equal(touched, false);
});

test('generation returns plaintext once and sends only its sha256 hash to storage', async () => {
  let args;
  const handler = loadWith('api/panel/sms-device-tokens.js', { '../../panel-server': server({ rpc: async (_ctx, name, values) => {
    assert.equal(name, 'panel_sms_device_token_generate'); args = values;
    return [{ id: uuid, device_name: 'iPhone', created_at: '2026-10-03T10:00:00Z', revoked_at: null }];
  } }) });
  const res = output();
  await handler({ method: 'POST', body: { action: 'generate', deviceName: 'iPhone' } }, res);
  assert.equal(res.code, 201);
  assert.equal(Buffer.from(res.payload.code, 'base64url').length, 32);
  assert.match(args.p_token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(args.p_token_hash, res.payload.code);
  assert.deepEqual(res.payload.item, { id: uuid, deviceName: 'iPhone', createdAt: '2026-10-03T10:00:00Z', status: 'ACTIVE' });
  assert.equal('tokenHash' in res.payload.item, false);
});

test('listing never returns code or hash, and revoke is scoped to id and environment', async () => {
  let patched;
  const mock = server({
    allRows: async () => [{ id: uuid, device_name: 'iPhone', created_at: '2026-10-03T10:00:00Z', revoked_at: '2026-10-03T11:00:00Z', token_hash: 'a'.repeat(64) }],
    patchRows: async (_ctx, table, filters, values) => { patched = { table, filters, values }; }
  });
  const handler = loadWith('api/panel/sms-device-tokens.js', { '../../panel-server': mock });
  const listed = output(); await handler({ method: 'GET' }, listed);
  assert.deepEqual(listed.payload, { items: [{ id: uuid, deviceName: 'iPhone', createdAt: '2026-10-03T10:00:00Z', status: 'REVOKED' }] });
  assert.doesNotMatch(JSON.stringify(listed.payload), /token|hash|code/i);
  const revoked = output(); await handler({ method: 'POST', body: { action: 'revoke', id: uuid } }, revoked);
  assert.equal(revoked.code, 200);
  assert.deepEqual(patched.table, 'sms_device_tokens');
  assert.deepEqual(patched.filters, { id: 'eq.' + uuid, environment: 'eq.production', revoked_at: 'is.null' });
  assert.match(patched.values.revoked_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('migration and settings card keep hashes private and the feature inside the existing settings view', () => {
  const sql = fs.readFileSync(path.join(root, 'supabase/migrations/20261003235011_sms_device_tokens.sql'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'painel/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'painel/sms-device-tokens.js'), 'utf8');
  assert.match(sql, /create table public\.sms_device_tokens/);
  assert.match(sql, /unique index[\s\S]*\(environment, token_hash\)/);
  assert.match(sql, /enable row level security/);
  assert.match(sql, /force row level security/);
  assert.match(sql, /revoke all on public\.sms_device_tokens from public, anon, authenticated/);
  assert.match(sql, /grant all on public\.sms_device_tokens to service_role/);
  assert.match(sql, /security invoker/);
  assert.match(html, /id="settings-panel"[\s\S]*id="sms-device-generate"/);
  assert.match(html, /Gerar código para este iPhone/);
  assert.match(js, /\/api\/panel\/sms-device-tokens/);
  assert.doesNotMatch(html + js, /SMS_INBOUND_SECRET/);
});

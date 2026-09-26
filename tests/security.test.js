'use strict';
process.env.VERCEL_ENV = 'preview';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-test';
process.env.SUPABASE_SECRET_KEY = 'secret-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const attachmentHandler = require('../api/panel/attachments');
const { validateAttachment, pathForApi } = attachmentHandler;
const { isUuid } = require('../panel-server');
const completePassword = require('../api/panel/complete-password');
const entry = require('../api/panel/entry');
const today = require('../api/panel/today');

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
test('attachment validation accepts PNG and rejects disguised SVG/HTML', () => {
  assert.equal(validateAttachment('ok.png', 'image/png', png.length, png), 'image/png');
  assert.equal(validateAttachment('bad.svg', 'image/png', png.length, png), null);
  assert.equal(validateAttachment('bad.png', 'image/svg+xml', png.length, png), null);
  assert.equal(validateAttachment('bad.html', 'image/png', png.length, png), null);
  assert.equal(validateAttachment('ok.pdf','application/pdf',8,Buffer.from('%PDF-1.7')),'application/pdf');
});

test('storage API path preserves slashes and encodes segments', () => {
  assert.equal(pathForApi('quarantine/preview/id/a b.png'), 'quarantine/preview/id/a%20b.png');
});

test('UUID validation rejects malformed attachment ids', () => {
  assert.equal(isUuid('f6074aec-214c-4dc9-a50d-fdf2b749c141'), true);
  assert.equal(isUuid('../preview/not-a-uuid'), false);
});

test('failed finalize removes the exact quarantine object', async () => {
  const deleted = [];
  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' });
    if (url.includes('/rest/v1/panel_users?select=')) return response(200, [{ id: '0cd6cda8-7c93-455c-af10-f8e49b1d2f8a', email: 'test@example.com', role: 'admin', active: true, must_change_password: false }]);
    if (options.method === 'DELETE' && url.includes('/storage/v1/object/mcs-panel-attachments/')) {
      deleted.push(url);
      return response(200, {});
    }
    throw new Error('unexpected fetch');
  };
  const output = res();
  await attachmentHandler({
    method: 'POST', headers: { authorization: 'Bearer user-token' },
    body: {
      action: 'finalize', attachmentId: 'f6074aec-214c-4dc9-a50d-fdf2b749c141',
      quarantinePath: 'quarantine/preview/f6074aec-214c-4dc9-a50d-fdf2b749c141/ok.png',
      filename: 'ok.png', mimeType: 'image/png', contactId: 'not-a-uuid'
    }
  }, output);
  assert.equal(output.code, 400);
  assert.equal(output.payload.error, 'ATTACHMENT_RELATION_INVALID');
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /\/quarantine\/preview\/f6074aec-214c-4dc9-a50d-fdf2b749c141\/ok\.png$/);
  assert.doesNotMatch(deleted[0], /%2F/i);
});

test('tampered quarantine path is rejected and the expected path is cleaned', async () => {
  const deleted = [];
  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' });
    if (url.includes('/rest/v1/panel_users?select=')) return response(200, [{ id: '0cd6cda8-7c93-455c-af10-f8e49b1d2f8a', email: 'test@example.com', role: 'admin', active: true, must_change_password: false }]);
    if (options.method === 'DELETE') { deleted.push(url); return response(200, {}); }
    throw new Error('unexpected fetch');
  };
  const output = res();
  await attachmentHandler({
    method: 'POST', headers: { authorization: 'Bearer user-token' },
    body: {
      action: 'finalize', attachmentId: 'f6074aec-214c-4dc9-a50d-fdf2b749c141',
      quarantinePath: 'quarantine/preview/another-id/ok.png', filename: 'ok.png', mimeType: 'image/png'
    }
  }, output);
  assert.equal(output.code, 400);
  assert.equal(output.payload.error, 'ATTACHMENT_PATH_INVALID');
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /\/quarantine\/preview\/f6074aec-214c-4dc9-a50d-fdf2b749c141\/ok\.png$/);
});

test('finalize records the actual object size instead of client-declared size', async () => {
  const actual = Buffer.concat([png, Buffer.from([1, 2, 3, 4, 5])]);
  let stored;
  global.fetch = async (url, options = {}) => {
    if (url.endsWith('/auth/v1/user')) return response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' });
    if (url.includes('/rest/v1/panel_users?select=')) return response(200, [{ id: '0cd6cda8-7c93-455c-af10-f8e49b1d2f8a', email: 'test@example.com', role: 'admin', active: true, must_change_password: false }]);
    if (url.includes('/storage/v1/object/mcs-panel-attachments/quarantine/') && (!options.method || options.method === 'GET')) {
      return { ok: true, status: 200, arrayBuffer: async () => actual.buffer.slice(actual.byteOffset, actual.byteOffset + actual.byteLength) };
    }
    if (url.endsWith('/storage/v1/object/move') && options.method === 'POST') return response(200, {});
    if (url.endsWith('/rest/v1/attachments') && options.method === 'POST') {
      stored = JSON.parse(options.body);
      return response(201, [{ id: stored.id }]);
    }
    if(url.includes('/rest/v1/contacts?select=id')||url.includes('/rest/v1/journeys?select=id'))return response(200,[{id:'ok'}]);
    if(url.endsWith('/rest/v1/activity_log')&&options.method==='POST')return response(201,[]);
    throw new Error('unexpected fetch');
  };
  const output = res();
  await attachmentHandler({
    method: 'POST', headers: { authorization: 'Bearer user-token' },
    body: {
      action: 'finalize', attachmentId: 'f6074aec-214c-4dc9-a50d-fdf2b749c141',
      quarantinePath: 'quarantine/preview/f6074aec-214c-4dc9-a50d-fdf2b749c141/ok.png',
      filename: 'ok.png', mimeType: 'image/png', byteSize: 999999,
      contactId:'f6074aec-214c-4dc9-a50d-fdf2b749c141',journeyId:'0cd6cda8-7c93-455c-af10-f8e49b1d2f8a'
    }
  }, output);
  assert.equal(output.code, 201);
  assert.equal(stored.byte_size, actual.length);
  assert.notEqual(stored.byte_size, 999999);
});

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload), arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
}
function res() {
  return { code: 0, payload: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return this; } };
}

test('empty password cannot clear must_change_password', async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.endsWith('/auth/v1/user')) return response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' });
    return response(200, [{ id: '0cd6cda8-7c93-455c-af10-f8e49b1d2f8a', email: 'test@example.com', role: 'admin', active: true, must_change_password: true }]);
  };
  const output = res();
  await completePassword({ method: 'POST', headers: { authorization: 'Bearer user-token' }, body: {} }, output);
  assert.equal(output.code, 400);
  assert.equal(output.payload.error, 'PASSWORD_REQUIREMENTS_NOT_MET');
  assert.equal(calls.length, 2);
});

test('all protected data handlers are blocked while password change is pending', async () => {
  global.fetch = async (url) => url.endsWith('/auth/v1/user')
    ? response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' })
    : response(200, [{ id: '0cd6cda8-7c93-455c-af10-f8e49b1d2f8a', email: 'test@example.com', role: 'admin', active: true, must_change_password: true }]);
  for (const [handler, request] of [
    [today, { method: 'GET', headers: { authorization: 'Bearer user-token' } }],
    [entry, { method: 'GET', headers: { authorization: 'Bearer user-token' } }],
    [attachmentHandler, { method: 'POST', headers: { authorization: 'Bearer user-token' }, body: { action: 'sign' } }]
  ]) {
    const output = res();
    await handler(request, output);
    assert.equal(output.code, 403);
    assert.equal(output.payload.error, 'PASSWORD_CHANGE_REQUIRED');
  }
});

test('authenticated user without panel_users is denied', async () => {
  global.fetch = async (url) => url.endsWith('/auth/v1/user')
    ? response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' })
    : response(200, []);
  const output = res();
  await today({ method: 'GET', headers: { authorization: 'Bearer user-token' } }, output);
  assert.equal(output.code, 403);
  assert.equal(output.payload.error, 'PANEL_ACCESS_DENIED');
});

test('flag clears only after Auth accepts the real password update', async () => {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push([url, options]);
    if (url.endsWith('/auth/v1/user') && (!options.method || options.method === 'GET')) return response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' });
    if (url.includes('/rest/v1/panel_users?select=')) return response(200, [{ id: '0cd6cda8-7c93-455c-af10-f8e49b1d2f8a', email: 'test@example.com', role: 'admin', active: true, must_change_password: true }]);
    if (url.endsWith('/auth/v1/user') && options.method === 'PUT') return response(200, { id: 'f6074aec-214c-4dc9-a50d-fdf2b749c141' });
    if (url.includes('/rest/v1/panel_users?id=')) return response(204, null);
    throw new Error('unexpected fetch');
  };
  const output = res();
  await completePassword({ method: 'POST', headers: { authorization: 'Bearer user-token' }, body: { newPassword: 'StrongPassword!2026' } }, output);
  assert.equal(output.code, 200);
  assert.equal(calls.filter(([url, options]) => url.endsWith('/auth/v1/user') && options.method === 'PUT').length, 1);
  assert.equal(calls.filter(([url, options]) => url.includes('/rest/v1/panel_users?id=') && options.method === 'PATCH').length, 1);
});

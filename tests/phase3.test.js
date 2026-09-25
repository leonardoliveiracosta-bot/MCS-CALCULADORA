'use strict';

process.env.VERCEL_ENV = 'preview';
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_PUBLISHABLE_KEY = 'publishable-test';
process.env.SUPABASE_SECRET_KEY = 'secret-test';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DAY_MS, buildTodayItems, checklistSummary, clientOkPatch, consolidateCalcRuns,
  logicalMode, nextStageForUnits, searchMatches, shortDeadline
} = require('../panel-domain');
const { supabase } = require('../panel-server');

const now = new Date('2026-09-25T16:00:00.000Z');
const journey = (id, extra = {}) => ({
  id, contact_id: id.replace(/.$/, '0'), stage: 'RESPONDIDO', status: 'ATIVO',
  stage_frozen: false, budget_cents: 0, contact: { display_name: id }, ...extra
});
const base = (journeys) => ({ journeys, messages: [], checklist: [], promises: [], divergences: [], units: [], suppressions: [] });

test('HOJE orders by longest wait, then budget, then completed checklist', () => {
  const data = base([
    journey('00000000-0000-4000-8000-000000000001', { next_action_at: new Date(now - 4 * DAY_MS).toISOString(), budget_cents: 100 }),
    journey('00000000-0000-4000-8000-000000000002', { next_action_at: new Date(now - 2 * DAY_MS).toISOString(), budget_cents: 9000000 }),
    journey('00000000-0000-4000-8000-000000000003', { next_action_at: new Date(now - 4 * DAY_MS).toISOString(), budget_cents: 200 })
  ]);
  data.checklist.push({ journey_id: data.journeys[2].id, status: 'COMPLETE' });
  assert.deepEqual(buildTodayItems(data, now).map((item) => item.id), [data.journeys[2].id, data.journeys[0].id, data.journeys[1].id]);
});

test('HOJE includes sem resposta, overdue return, and 2/5/7-day rules', () => {
  const ids = Array.from({ length: 5 }, (_, index) => `00000000-0000-4000-8000-00000000000${index + 1}`);
  const data = base([
    journey(ids[0]),
    journey(ids[1], { next_action_at: new Date(now - DAY_MS).toISOString() }),
    journey(ids[2], { next_action_missing_since: new Date(now - 2 * DAY_MS).toISOString() }),
    journey(ids[3], { search_started_at: new Date(now - 5 * DAY_MS).toISOString() }),
    journey(ids[4])
  ]);
  data.messages.push({ journey_id: ids[0], direction: 'CUSTOMER', channel: 'WHATSAPP', body_text: 'Ainda aguardo.', occurred_at_utc: new Date(now - DAY_MS).toISOString() });
  data.units.push({ journey_id: ids[4], status: 'UNDER_REVIEW', vehicle_text: 'SUV', presented_at: new Date(now - 7 * DAY_MS).toISOString() });
  const reasons = Object.fromEntries(buildTodayItems(data, now).map((item) => [item.id, item.reasons.map((reason) => reason.kind)]));
  assert.deepEqual(reasons[ids[0]], ['NO_RESPONSE']);
  assert.deepEqual(reasons[ids[1]], ['NEXT_ACTION']);
  assert.deepEqual(reasons[ids[2]], ['MISSING_NEXT_ACTION']);
  assert.deepEqual(reasons[ids[3]], ['SEARCH_STALLED']);
  assert.deepEqual(reasons[ids[4]], ['UNIT_NO_RESPONSE']);
});

test('HOJE carries open divergences and promises without duplicating a journey', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const data = base([journey(id)]);
  data.divergences.push({ journey_id: id, field: 'TETO', status: 'OPEN', created_at: new Date(now - DAY_MS).toISOString() });
  data.promises.push({ journey_id: id, status: 'OPEN', promise_text: 'Retornar', due_at: new Date(now - DAY_MS).toISOString() });
  const items = buildTodayItems(data, now);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].reasons.map((reason) => reason.kind), ['DIVERGENCE', 'PROMISE']);
});

test('old reimport does not cancel dismissal but a newer real message does', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const data = base([journey(id)]);
  data.suppressions.push({ journey_id: id, kind: 'NO_RESPONSE', action: 'DISMISS', created_at: new Date(now - DAY_MS).toISOString(), cancelled_at: null });
  data.messages.push({ journey_id: id, direction: 'CUSTOMER', channel: 'SMS', body_text: 'Mensagem antiga', occurred_at_utc: new Date(now - 2 * DAY_MS).toISOString() });
  assert.equal(buildTodayItems(data, now).length, 0);
  data.messages.push({ journey_id: id, direction: 'CUSTOMER', channel: 'SMS', body_text: 'Mensagem nova', occurred_at_utc: new Date(now.getTime() - 1000).toISOString() });
  assert.equal(buildTodayItems(data, now).length, 1);
});

test('calculator consolidation keeps sid/ref/mode separate and selects last contact snapshot', () => {
  const rows = [
    { id: '1', created_at: '2026-01-01T10:00:00Z', dados: { sid: 'A', ref: 'ABC23', evento: 'simulacao', quando: '2026-01-01T10:00:00Z', lance: 10000, modelo: 'Old' } },
    { id: '2', created_at: '2026-01-01T11:00:00Z', dados: { sid: 'A', ref: 'ABC23', evento: 'whatsapp', quando: '2026-01-01T11:00:00Z', lance: 10000, modelo: 'Contact' } },
    { id: '3', created_at: '2026-01-01T12:00:00Z', dados: { sid: 'A', ref: 'ABC23', evento: 'share', quando: '2026-01-01T12:00:00Z', lance: 10000, modelo: 'Later non-contact' } },
    { id: '4', created_at: '2026-01-02T10:00:00Z', dados: { sid: 'B', ref: 'ABC23', evento: 'busca', quando: '2026-01-02T10:00:00Z', ano_de: 2020 } },
    { id: '5', created_at: '2026-01-03T10:00:00Z', dados: { sid: 'A', ref: 'ABC23', evento: 'busca', quando: '2026-01-03T10:00:00Z', ano_de: 2021 } }
  ];
  const result = consolidateCalcRuns(rows);
  assert.equal(result.length, 3);
  assert.equal(result.find((item) => item.sid === 'A' && item.logicalMode === 'CARRO').vehicleText, 'Contact');
  assert.equal(logicalMode({ dados: { evento: 'share' } }), 'REVIEW');
});

test('Cliente deu OK freezes as QUALIFICADO + ENCERRADO with exact reason', () => {
  const result = clientOkPatch('2026-09-25T12:00:00Z', '00000000-0000-4000-8000-000000000001');
  assert.equal(result.stage, 'QUALIFICADO');
  assert.equal(result.status, 'ENCERRADO');
  assert.equal(result.closed_reason, 'CLIENTE_DEU_OK');
  assert.equal(result.stage_frozen, true);
});

test('six evidence points are only checklist completo and short deadline is informational', () => {
  const result = checklistSummary(Array.from({ length: 6 }, () => ({ status: 'COMPLETE' })));
  assert.equal(result.label, 'checklist completo');
  assert.doesNotMatch(result.label, /pronto para lance/i);
  assert.equal(shortDeadline(new Date(now.getTime() + 30 * DAY_MS).toISOString(), now), true);
});

test('unit transitions return to EM_BUSCA only when none remains under review', () => {
  assert.equal(nextStageForUnits('EM_BUSCA', [{ status: 'UNDER_REVIEW' }]), 'DECIDINDO');
  assert.equal(nextStageForUnits('DECIDINDO', [{ status: 'DECLINED' }, { status: 'UNDER_REVIEW' }]), 'DECIDINDO');
  assert.equal(nextStageForUnits('DECIDINDO', [{ status: 'DECLINED' }]), 'EM_BUSCA');
});

test('global search matches name accents, phone digits, and Ref', () => {
  assert.equal(searchMatches('jose', { display_name: 'José da Silva' }), true);
  assert.equal(searchMatches('3055551212', { phone_e164: '+1 (305) 555-1212' }), true);
  assert.equal(searchMatches('abc23', { ref_code: 'ABC23' }), true);
  assert.equal(searchMatches('abc24', { ref_code: 'ABC23' }), false);
  assert.equal(searchMatches('E3TST', { display_name: 'TESTE PAINEL E3 — BETA' }), false);
});

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, text: async () => JSON.stringify(payload), arrayBuffer: async () => new ArrayBuffer(0), headers: new Map() };
}
function output() {
  return { code: 0, payload: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return this; } };
}

test('PostgREST 201 with return=minimal is accepted as an empty success', async () => {
  global.fetch = async () => ({
    ok: true,
    status: 201,
    headers: new Map(),
    text: async () => ''
  });
  assert.equal(await supabase('https://example.supabase.co', 'secret-test', '/rest/v1/audit_log', {
    method: 'POST',
    headers: { prefer: 'return=minimal' },
    body: '{}'
  }), null);
});

test('every phase-3 API is blocked while must_change_password is true', async () => {
  global.fetch = async (url) => url.endsWith('/auth/v1/user')
    ? response(200, { id: '00000000-0000-4000-8000-000000000001' })
    : response(200, [{ id: '00000000-0000-4000-8000-000000000002', email: 'sanitized@example.test', role: 'admin', active: true, must_change_password: true }]);
  const cases = [
    ['../api/panel/today', { method: 'GET' }],
    ['../api/panel/orders', { method: 'GET', query: {} }],
    ['../api/panel/qualification', { method: 'GET' }],
    ['../api/panel/records', { method: 'GET', query: {} }],
    ['../api/panel/search', { method: 'GET', query: { q: 'TESTE' } }],
    ['../api/panel/report', { method: 'GET', query: { period: 'today' } }],
    ['../api/panel/actions', { method: 'POST', body: { action: 'start_search', journeyId: '00000000-0000-4000-8000-000000000003' } }]
  ];
  for (const [modulePath, request] of cases) {
    const handler = require(modulePath);
    const res = output();
    await handler({ ...request, headers: { authorization: 'Bearer sanitized-token' } }, res);
    assert.equal(res.code, 403, modulePath);
    assert.equal(res.payload.error, 'PASSWORD_CHANGE_REQUIRED', modulePath);
  }
});

test('conversation UI treats imported text only as text and bans browser modal APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /\b(?:alert|confirm|prompt)\s*\(/);
  assert.match(source, /textContent/);
});

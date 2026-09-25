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
  DAY_MS, buildTodayItems, buildTodayOrderItems, checklistSummary, clientOkPatch, consolidateCalcRuns,
  journeyLogicalMode, logicalMode, nextStageForUnits, orderSearchMatches, searchMatches, shortDeadline
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

test('calculator consolidation uses event mode, merges duplicate Ref, and reads every session event', () => {
  const rows = [
    { id: '1', created_at: '2026-01-01T10:00:00Z', dados: { sid: 'A', ref: 'ABC23', evento: 'simulacao', quando: '2026-01-01T10:00:00Z', lance: 10000, pagamento: 'cash', modelo: 'Old', estado: { uf: 'FL', nome: 'Florida' } } },
    { id: '2', created_at: '2026-01-01T11:00:00Z', dados: { sid: 'A', ref: 'ABC23', evento: 'whatsapp', quando: '2026-01-01T11:00:00Z' } },
    { id: '3', created_at: '2026-01-01T12:00:00Z', dados: { sid: 'A', ref: 'ABC23', evento: 'saida', quando: '2026-01-01T12:00:00Z' } },
    { id: '4', created_at: '2026-01-02T10:00:00Z', dados: { sid: 'B-find-x', ref: 'RHD4F', evento: 'busca', quando: '2026-01-02T10:00:00Z', ano_de: 2016, ano_ate: 2024, marca: 'Fiat', modelo: '500', estado: { uf: 'FL' }, canal: 'sms', zip: '33030' } },
    { id: '5', created_at: '2026-01-03T10:00:00Z', dados: { sid: 'B-find-x', ref: 'RHD4F', evento: 'busca', quando: '2026-01-03T10:00:00Z', ano_de: 2016, ano_ate: 2024, marca: 'Cadillac', modelo: 'XT4', estado: { uf: 'FL' }, canal: 'sms', zip: '33030' } },
    { id: '6', created_at: '2026-01-04T10:00:00Z', dados: { sid: 'C', ref: 'ABCDE', evento: 'simulacao', quando: '2026-01-04T10:00:00Z', lance: 1 } }
  ];
  const result = consolidateCalcRuns(rows);
  assert.equal(result.length, 2);
  const value = result.find((item) => item.logicalMode === 'VALOR');
  assert.equal(value.budgetCents, 1000000);
  assert.equal(value.paymentText, 'cash');
  assert.equal(value.state, 'FL');
  assert.equal(value.contactChannel, 'WHATSAPP');
  const car = result.find((item) => item.ref === 'RHD4F');
  assert.equal(car.logicalMode, 'CARRO');
  assert.equal(car.state, 'FL');
  assert.equal(car.vehicleText, '2016–2024 Fiat 500 · 2016–2024 Cadillac XT4');
  assert.equal(car.contactChannel, 'SMS');
  assert.equal(result.some((item) => item.ref === 'ABCDE'), false);
  assert.equal(logicalMode({ dados: { evento: 'share' } }), 'VALOR');
});

test('direct order mode comes from stored mode and never from budget presence', () => {
  assert.equal(journeyLogicalMode({ budget_cents: 5000000, criteria_json: { mode: 'VALOR' } }), 'VALOR');
  assert.equal(journeyLogicalMode({ budget_cents: 5000000, criteria_json: {} }), 'REVIEW');
  assert.equal(journeyLogicalMode({ budget_cents: null, criteria_json: { modo: 'CARRO' } }), 'CARRO');
});

test('clicked WhatsApp or SMS calculator requests appear in HOJE only while unlinked', () => {
  const items = buildTodayOrderItems([
    { key: 'a', ref: 'ABC23', clickedContact: true, contactChannel: 'WHATSAPP', occurredAt: new Date(now - DAY_MS).toISOString(), logicalMode: 'VALOR' },
    { key: 'b', ref: 'ABC24', clickedContact: true, contactChannel: 'SMS', occurredAt: new Date(now - 2 * DAY_MS).toISOString(), logicalMode: 'CARRO', link: { journeyId: 'j' } },
    { key: 'c', ref: 'ABC25', clickedContact: false, occurredAt: new Date(now - 3 * DAY_MS).toISOString(), logicalMode: 'VALOR' }
  ], now);
  assert.deepEqual(items.map((item) => item.id), ['a']);
  assert.equal(items[0].reasons[0].label, 'WHATSAPP CLICADO');
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

test('order search accepts Ref prefix, case-insensitive model, and ZIP', () => {
  const order = { ref: 'RHD4F', vehicleText: '2016–2024 Cadillac XT4', zip: '33030' };
  assert.equal(orderSearchMatches('Ref rhd4f', order), true);
  assert.equal(orderSearchMatches('cadillac', order), true);
  assert.equal(orderSearchMatches('33030', order), true);
  assert.equal(orderSearchMatches('RHD5F', order), false);
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

test('tab changes replace stale counts with loading and ignore older responses', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.match(source, /const requestVersion = \+\+viewRequestVersion/);
  assert.match(source, /renderLoading\(view\)/);
  assert.match(source, /currentView === view && viewRequestVersion === requestVersion/);
  assert.match(source, /empty\(\$\(roots\[view\]\), 'Carregando…'\)/);
});

test('FICHAS clears an old detail when the list is empty or the tab changes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.match(source, /function clearRecordDetail/);
  assert.match(source, /clearRecordDetail\(\);[\s\S]*renderLoading\(view\)/);
  assert.match(source, /if \(!items\.length\) \{\s*clearRecordDetail\('Nenhuma ficha selecionada\.'\)/);
  assert.match(source, /if \(currentView !== 'records'\) return/);
});

test('remember login persists a refreshable session without storing the password', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'painel', 'index.html'), 'utf8');
  const source = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.match(html, /id="remember-login"[\s\S]*Manter conectado neste dispositivo/);
  assert.match(source, /grant_type=refresh_token/);
  assert.match(source, /localStorage\.getItem\(SESSION_KEY\)/);
  assert.match(source, /sessionStorage\.getItem\(SESSION_KEY\)/);
  assert.match(source, /refreshToken = data\.refresh_token/);
  assert.doesNotMatch(source, /setItem\([^\n]*(?:password|senha)/i);
});

test('WhatsApp import makes confirmation and storage failures explicit', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'api', 'panel', 'entry.js'), 'utf8');
  assert.match(client, /await loadQueue\(false\);/);
  assert.match(client, /arquivo lido\. Confirme os dados abaixo para gravar a conversa/);
  assert.match(client, /scrollIntoView\(\{ behavior: 'smooth', block: 'start' \}\)/);
  assert.match(client, /Falha na importação:[\s\S]*Nenhum sucesso foi confirmado/);
  assert.match(server, /start: 'IMPORT_START_FAILED'/);
  assert.match(server, /batch: 'IMPORT_BATCH_FAILED'/);
  assert.match(server, /finish: 'IMPORT_FINISH_FAILED'/);
});

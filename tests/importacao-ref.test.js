'use strict';
// IMPORTAÇÕES: print sem telefone mas com a Ref de uma ficha já identificada, mensagem cortada repetida,
// e retomada automática dos prints guardados. Usa o código real do servidor sobre um banco falso em memória.
const test = require('node:test');
const assert = require('node:assert/strict');

const ENV = 'production';
const JOURNEY = 'dbcf30a7-79ee-4f69-b0df-6ee1336869c8', CONTACT = 'b2a99a8a-121d-4f07-805e-fda0955d3e13', ACTOR = 'ed24c183-d61e-4714-ada6-7dadef53685d';
const FULL = "Hello! I just sent a vehicle search request through My Car Scout\n\nName: Harman Harman\nPlanning to buy: Ready to buy now\nFirst time at a dealer auction: Yes, first time\nYear range: 2021-2025\nVehicle: Ford Mustang\nMileage range: 100,000-200,000\nZIP code: 11416 · Ozone Park, New York\n\nI'd like to discuss this vehicle search\nRef: CG8LN";
const CROPPED = FULL.replace('Harman Harman', 'Herman Harman').replace('\nRef: CG8LN', '');
const OTHER = "Hi again, I changed my mind about the budget and now I would like to also see a Cadillac Escalade with fewer miles please call me";

function world({ phones = ['+17183747832'], journeys } = {}) {
  const db = {
    journeys: journeys || [{ id: JOURNEY, environment: ENV, contact_id: CONTACT, reference_code: 'CG8LN', status: 'ATIVO' }],
    journey_refs: [], contacts: [{ id: CONTACT, environment: ENV, display_name: 'Harman Harman' }],
    contact_phones: phones.map((phone, index) => ({ id: 'p' + index, environment: ENV, contact_id: CONTACT, phone_e164: phone, is_current: true, retired_at: null, is_primary: index === 0 })),
    message_journeys: [{ environment: ENV, message_id: 'c3333333-3333-4333-8333-333333333333', journey_id: JOURNEY, undone_at: null }],
    messages: [{ id: 'c3333333-3333-4333-8333-333333333333', environment: ENV, body_text: FULL, body_normalized: FULL.trim().toLowerCase().replace(/\s+/g, ' ') }],
    sms_print_reads: [], calc_runs: []
  };
  const calls = [];
  const matches = (row, key, value) => {
    const cell = row[key];
    if (value.startsWith('eq.')) return String(cell) === value.slice(3);
    if (value.startsWith('neq.')) return String(cell) !== value.slice(4);
    if (value === 'is.null') return cell === null || cell === undefined;
    if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(cell));
    return true;
  };
  global.fetch = async (input, options = {}) => {
    const url = new URL(String(input)), method = options.method || 'GET';
    const json = (value, status = 200) => ({ ok: status < 400, status, json: async () => value, text: async () => JSON.stringify(value), arrayBuffer: async () => new ArrayBuffer(0) });
    if (url.pathname.startsWith('/storage/')) { calls.push({ storage: url.pathname }); return json({}); }
    const rpc = url.pathname.match(/\/rest\/v1\/rpc\/(.+)$/);
    if (rpc) { calls.push({ rpc: rpc[1], body: JSON.parse(options.body || '{}') }); return json(rpc[1] === 'panel_sms_print_attach_photo' ? { journeyId: JOURNEY, photoOnly: true } : { journeyId: JOURNEY, contactId: CONTACT, messageId: 'new', attachmentId: 'a', duplicate: false }); }
    const table = url.pathname.replace('/rest/v1/', '');
    if (!db[table]) return json([]);
    const filters = [...url.searchParams].filter(([key]) => !['select', 'order', 'limit'].includes(key));
    const found = db[table].filter((row) => filters.every(([key, value]) => matches(row, key, value)));
    if (method === 'PATCH') { found.forEach((row) => Object.assign(row, JSON.parse(options.body))); calls.push({ patch: table, body: JSON.parse(options.body) }); return json(found); }
    return json(found);
  };
  return { db, calls, ctx: { config: { url: 'http://fake', secretKey: 'k' }, environment: ENV, panel: { id: ACTOR } } };
}
const printRecord = (extra = {}) => ({ id: 'a1111111-1111-4111-8111-111111111111', status: 'READY', source_journey_id: null, source_contact_id: null, original_filename: 'IMG_9241.jpeg', quarantine_path: 'quarantine/x', storage_path: 'panel/production/b2222222-2222-4222-8222-222222222222/IMG_9241.jpeg', attachment_id: null, sha256: null, extracted_json: {}, error_code: null, ...extra });
const confirm = async (ctx, record, body) => {
  const { confirmPrint } = require('../api/panel/sms-print');
  let outcome; await confirmPrint(ctx, record, body, (code, payload) => { outcome = { code, payload }; return outcome; });
  return outcome;
};

test('print sem telefone e cortado: a Ref identifica a ficha e a mensagem repetida só anexa a foto', async () => {
  const { ctx, calls } = world();
  const out = await confirm(ctx, printRecord(), { auto: true, phone: '', name: 'Herman Harman', ref: 'CG8LN', message: CROPPED });
  assert.equal(out.code, 201);
  assert.equal(out.payload.duplicateMessage, true, JSON.stringify(out) + JSON.stringify(calls));
  assert.ok(calls.some((call) => call.rpc === 'panel_sms_print_attach_photo' && call.body.p_target_journey === JOURNEY));
  assert.ok(!calls.some((call) => call.rpc === 'panel_sms_print_confirm'), 'a mesma mensagem não pode ser importada duas vezes');
});

test('print sem telefone com mensagem nova: reaproveita o telefone único da ficha comprovada pela Ref', async () => {
  const { ctx, calls } = world();
  const out = await confirm(ctx, printRecord(), { auto: true, phone: '', name: 'Herman Harman', ref: 'CG8LN', message: OTHER });
  assert.equal(out.code, 201);
  assert.equal(out.payload.inheritedPhone, true);
  const call = calls.find((item) => item.rpc === 'panel_sms_print_confirm');
  assert.equal(call.body.p_phone, '+17183747832');
  assert.equal(call.body.p_target_journey, JOURNEY);
});

test('sem prova suficiente nada é inventado: Ref desconhecida ou dois telefones ficam pendentes', async () => {
  const unknown = world();
  assert.equal((await confirm(unknown.ctx, printRecord(), { auto: true, phone: '', ref: 'ZZZZ9', message: OTHER })).code, 400);
  assert.ok(!unknown.calls.some((call) => call.rpc));
  const two = world({ phones: ['+17183747832', '+12125550000'] });
  const out = await confirm(two.ctx, printRecord(), { auto: true, phone: '', ref: 'CG8LN', message: OTHER });
  assert.equal(out.code, 400);
  assert.equal(out.payload.error, 'SMS_PRINT_VALUES_INVALID');
  assert.ok(!two.calls.some((call) => call.rpc === 'panel_sms_print_confirm'));
});

test('mensagem curta ou diferente não é tratada como repetida', () => {
  const { sameMessage } = require('../panel-sms-print');
  assert.equal(sameMessage(FULL, CROPPED), true);
  assert.equal(sameMessage(FULL, FULL.replace('Ford Mustang', 'Chevrolet Camaro')), false);
  assert.equal(sameMessage('Hello', 'Hello'), false);
  assert.equal(sameMessage(FULL, OTHER), false);
});

test('retomada: escolhe o que vale tentar, sem repetir fora do prazo nem insistir no que depende de pessoa', () => {
  const { resumable, MAX_ATTEMPTS } = require('../panel-print-resume');
  const now = Date.parse('2026-10-02T12:00:00Z'), ago = (minutes) => new Date(now - minutes * 60000).toISOString();
  const base = { status: 'READY', created_by: ACTOR, created_at: ago(500), updated_at: ago(60), resume_attempts: 0, last_resume_at: null };
  const reads = [
    { ...base, id: 'limit', error_code: 'AI_DAILY_LIMIT', extracted_json: {} },
    { ...base, id: 'saved-not', error_code: null, extracted_json: { ref: 'CG8LN', message: 'x' } },
    { ...base, id: 'review', error_code: 'NAME_MATCH_REVIEW', extracted_json: { message: 'x' } },
    { ...base, id: 'invalid', error_code: 'SMS_PRINT_INVALID_IMAGE', extracted_json: {} },
    { ...base, id: 'fresh', error_code: 'AI_DAILY_LIMIT', updated_at: ago(1), extracted_json: {} },
    { ...base, id: 'backoff', error_code: 'AI_DAILY_LIMIT', last_resume_at: ago(3), extracted_json: {} },
    { ...base, id: 'capped', error_code: 'AI_DAILY_LIMIT', resume_attempts: MAX_ATTEMPTS, extracted_json: {} },
    { ...base, id: 'no-owner', error_code: 'AI_DAILY_LIMIT', created_by: null, extracted_json: {} },
    { ...base, id: 'done', status: 'CONFIRMED', extracted_json: { message: 'x' } }
  ];
  assert.deepEqual(resumable(reads, now).map((read) => read.id).sort(), ['limit', 'saved-not']);
  // a print already read keeps being retried after the read cap: it costs nothing and a later print can prove its Ref
  const capped = [{ ...base, id: 'read-capped', resume_attempts: MAX_ATTEMPTS, extracted_json: { ref: 'CG8LN', message: 'x' } }];
  assert.equal(resumable(capped, now).length, 1);
});

test('retomada: lê de novo, salva o que a Ref prova, deixa o resto pendente com o motivo e não duplica', async () => {
  const { resumeOne } = require('../panel-print-resume');
  const state = { record: printRecord({ error_code: 'AI_DAILY_LIMIT', extracted_json: {} }), patches: [] };
  const deps = {
    printRecord: async () => state.record,
    readPrintRecord: async (_ctx, record) => { state.record = { ...record, error_code: null, extracted_json: { ref: 'CG8LN', phone: '', message: CROPPED, name: 'Herman Harman' } }; return { read: state.record }; },
    confirmPrint: async (_ctx, record, _body, reply) => { if (record.status === 'CONFIRMED') return reply(200, { duplicate: true }); state.record = { ...record, status: 'CONFIRMED' }; return reply(201, { journeyId: JOURNEY, photoOnly: true }); },
    patchRows: async (_ctx, _table, _filters, payload) => { state.patches.push(payload); }
  };
  const read = { id: state.record.id, created_by: ACTOR, resume_attempts: 0 };
  const first = await resumeOne({ environment: ENV }, read, deps);
  assert.equal(first.outcome, 'SAVED');
  assert.equal(state.patches[0].resume_attempts, 1, 'a leitura paga conta uma tentativa');
  const again = await resumeOne({ environment: ENV }, read, deps);
  assert.equal(again.outcome, 'SAVED', 'repetir um print já guardado não faz nada novo');
  const unread = await resumeOne({ environment: ENV }, read, { ...deps, printRecord: async () => ({ ...printRecord(), error_code: 'AI_UNAVAILABLE' }), readPrintRecord: async () => ({ read: { ...printRecord(), error_code: 'AI_UNAVAILABLE', extracted_json: {} }, manual: true }) });
  assert.equal(unread.outcome, 'UNREAD');
  const pending = await resumeOne({ environment: ENV }, read, { ...deps, printRecord: async () => printRecord({ extracted_json: { ref: 'ZZZZ9', message: OTHER } }), confirmPrint: async (_c, _r, _b, reply) => reply(400, { error: 'SMS_PRINT_VALUES_INVALID' }) });
  assert.equal(pending.outcome, 'PENDING');
  assert.equal(pending.reason, 'SMS_PRINT_VALUES_INVALID');
});

'use strict';
// Dupla verificação (B): listas, contadores e próxima ação seguem a regra da mesa e do contato real.
const test = require('node:test');
const assert = require('node:assert/strict');
const requests = require('../vehicle-requests');
const { optOutOf } = require('../panel-opt-out');

test('"não informado" lists only what the search type uses', () => {
  const onlyCar = { make: 'Toyota', model: 'Camry' };
  assert.deepEqual(requests.notInformed(onlyCar, 'VALOR'), ['valor']);
  assert.deepEqual(requests.notInformed(onlyCar, 'CARRO'), ['ano', 'milhagem']);
  assert.deepEqual(requests.notInformed(onlyCar), ['ano', 'milhagem', 'valor']);
});

test('opt-out is the same rule for suggestions and the automatic reading', () => {
  const at = new Date().toISOString();
  assert.ok(optOutOf([{ direction: 'CUSTOMER', body_text: 'STOP', occurred_at_utc: at }]));
  assert.equal(optOutOf([{ direction: 'CUSTOMER', body_text: "I'll stop by tomorrow", occurred_at_utc: at }]), null);
  assert.equal(optOutOf([{ direction: 'MCS', body_text: 'STOP', occurred_at_utc: at }]), null);
  assert.equal(require('../panel-reply-suggest').optOutOf, optOutOf);
});

test('old-conversation queue leaves out discarded and out-of-funnel people, with the reason', async () => {
  const suggest = require('../panel-reply-suggest');
  const old = new Date(Date.now() - 40 * 86400000).toISOString();
  const person = (n) => ({ journey: { id: 'j' + n, contact_id: 'c' + n, reference_code: 'Z' + n + 'AAA', status: 'ATIVO' }, contact: { id: 'c' + n, display_name: 'Cliente ' + n },
    chat: { id: 'ch' + n, contact_id: 'c' + n, channel: 'WHATSAPP', is_group: false, canonical_key: 'wa:+1305555010' + n }, phone: { contact_id: 'c' + n, phone_e164: '+1305555010' + n, is_current: true },
    message: { id: 'm' + n, direction: 'CUSTOMER', body_text: 'I want a Camry', occurred_at_utc: old } });
  const people = [1, 2, 3].map(person);
  const tables = {
    journeys: people.map((p) => p.journey), contacts: people.map((p) => p.contact), chats: people.map((p) => p.chat), contact_phones: people.map((p) => p.phone),
    messages: people.map((p) => p.message), message_journeys: people.map((p) => ({ journey_id: p.journey.id, message_id: p.message.id })), journey_toggle_states: [], journey_refs: [],
    panel_item_dispositions: [{ item_kind: 'JOURNEY', item_key: 'j2', status: 'DISCARDED', discard_reason: 'sem interesse', updated_at: old, cleared_at: null }],
    conversation_triage: [{ journey_id: 'j3', decision: 'FORA_DO_FUNIL' }]
  };
  const result = await suggest.queue({ environment: 'preview' }, {}, { allRows: async (_ctx, table) => tables[table] || [] });
  assert.deepEqual(result.eligible.map((item) => item.journeyId), ['j1']);
  assert.deepEqual(result.excluded.map((item) => [item.journeyId, item.reason.code]).sort(), [['j2', 'DISCARDED'], ['j3', 'TRIAGE_OUT']]);
  assert.match(result.excluded.find((item) => item.journeyId === 'j2').reason.text, /sem interesse/);
});

test('financiamento: até US$ 7.000 só à vista; a partir de US$ 7.001 pode financiar', () => {
  const { CONFIG } = require('../calc-core');
  assert.equal(CONFIG.financiamentoMinimo, 7001);
  const warns = (lance) => lance > 0 && lance < CONFIG.financiamentoMinimo; // the calculator's rule
  assert.equal(warns(7000), true);
  assert.equal(warns(7001), false);
});

test('comparar com lote grande: cada rodada para no limite de tempo (ao menos 1 pedido) e a próxima continua', async () => {
  const search = require('../panel-search-requests');
  const reader = async (_ctx, table) => table === 'manheim_uploads' ? [{ id: 'u1' }] : [];
  const items = [1, 2, 3].map((n) => ({ key: 'k' + n, criteriaHash: 'h' + n, completeness: 'PRONTO', searchMode: 'CARRO', criteria: { make: 'Toyota', model: 'Camry' } }));
  const saved = [];
  const services = { allRows: reader, rows: reader, stateServices: { rows: reader }, upsertCheck: async (_ctx, row) => saved.push(row.request_key) };
  const late = await search.compareItems({ environment: 'production' }, items, { services, deadlineAt: Date.now() - 1 });
  assert.equal(late.compared, 1, 'passou do tempo: grava um e devolve o resto para a próxima rodada');
  const onTime = await search.compareItems({ environment: 'production' }, items, { services, deadlineAt: Date.now() + 60000 });
  assert.equal(onTime.compared, 3);
  assert.deepEqual(saved, ['k1', 'k1', 'k2', 'k3']);
});

test('comparar: um pedido que falha não derruba a rodada; fica em FALTA BUSCAR e os outros seguem', async () => {
  const search = require('../panel-search-requests');
  const reader = async (_ctx, table) => table === 'manheim_uploads' ? [{ id: 'u1' }] : [];
  const items = ['a', 'b', 'c'].map((key) => ({ key, criteriaHash: 'h', completeness: 'PRONTO', comparable: false }));
  const saved = [];
  const services = { allRows: reader, rows: reader, stateServices: { rows: reader }, upsertCheck: async (_ctx, row) => { if (row.request_key === 'b') throw Error('PGRST_FAKE'); saved.push(row.request_key); } };
  const original = console.error; console.error = () => {};
  try {
    const out = await search.compareItems({ environment: 'production' }, items, { services });
    assert.equal(out.compared, 2);
    assert.deepEqual(out.failed, ['b']);
    assert.deepEqual(saved, ['a', 'c']);
  } finally { console.error = original; }
});

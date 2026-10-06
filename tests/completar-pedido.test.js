'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const completing = require('../painel/completar-pedido');
const attend = require('../painel/atendimento');
const now = Date.parse('2026-10-06T21:00:00Z'), DAY = 86400000;
const at = (days) => new Date(now - days * DAY).toISOString();
const id = (n) => `7c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const message = (days, direction, extra = {}) => ({ id: String(days), occurred_at_utc: at(days), created_at: at(0), direction, channel: 'WHATSAPP', ...extra });
const shell = (n) => ({ entry: { key: 'ficha:' + id(n), journeyId: id(n), bucket: 'completar', item: null }, data: { group: 'COMPLETAR' } });
const row = (n, days, awaitingReply = false, extra = {}) => ({ entry: { key: 'ficha:' + id(n), journeyId: id(n), bucket: awaitingReply ? 'depende' : 'aguardando', item: { id: id(n), sortAt: at(days), lastCustomerAt: at(days), awaitingReply, ...extra } }, data: {} });
const identity = (days, direction, extra = {}) => ({ phones: ['+13055550123'], internalCode: '2L2TD', listMessage: completing.lastMessage([message(days, direction)]), ...extra });
const keys = (rows) => rows.map((one) => one.entry.key);

test('última mensagem real decide a espera, sem automáticas, mensagens desfeitas ou marcadores', () => {
  const latest = completing.lastMessage([message(5, 'CUSTOMER', { channel: 'SMS' }), message(10, 'MCS'), message(0, 'MCS', { is_automatic: true }), message(1, 'MCS', { undone_at: at(0) }), message(2, 'MCS', { is_edit_marker: true }), message(3, 'MCS', { is_delete_marker: true })]);
  assert.deepEqual(latest, { at: at(5), direction: 'CUSTOMER', channel: 'SMS', source: null });
  assert.deepEqual(completing.wait({ listMessage: latest }, now), { tone: 'mid', main: '5 dias · sem resposta', sub: 'SMS' });
  const ours = identity(10, 'MCS');
  assert.deepEqual(completing.wait(ours, now), { tone: '', main: 'Aguardando o cliente · há 10 dias', sub: 'WhatsApp' });
});

test('SMS sem data original não usa a data de importação nem afirma que espera o cliente', () => {
  const latest = completing.lastMessage([message(5, 'CUSTOMER', { occurred_at_utc: null, channel: 'SMS', created_at: at(5) })]);
  assert.equal(latest.at, null);
  assert.deepEqual(completing.wait({ listMessage: latest }, now), { tone: '', main: 'Sem resposta', sub: 'SMS · data original desconhecida' });
  assert.equal(completing.wait('loading', now).main, 'Carregando conversa…');
  assert.equal(completing.wait(null, now).main, 'Conversa indisponível');
  assert.equal(completing.wait({}, now).main, 'Sem mensagem');
});

test('bolinha do cliente usa os mesmos limites de 24 horas e 7 dias', () => {
  for (const [days, tone] of [[0.5, 'new'], [1, 'mid'], [7, 'mid'], [8, 'old']]) assert.equal(completing.wait(identity(days, 'CUSTOMER'), now).tone, tone);
});

test('pronto para ligar intercala completar entre quem espera resposta e quem aguarda cliente', () => {
  const existing = [row(1, 20, true), row(2, 1)];
  const missing = [shell(3), shell(4)];
  const identities = new Map([[id(3), identity(5, 'CUSTOMER')], [id(4), identity(10, 'MCS')]]);
  const sorted = completing.insert(existing, missing, identities, 'ready', now);
  assert.deepEqual(keys(sorted), keys([existing[0], missing[0], existing[1], missing[1]]));
  assert.deepEqual(keys(sorted.filter((one) => one.entry.item)), keys(existing));
  assert.deepEqual(keys(existing), keys([row(1, 20, true), row(2, 1)]));
});

test('mais recentes e mais antigas usam a última mensagem, nunca pinam completar no topo', () => {
  const recent = [row(1, 1), row(2, 20)], missing = shell(3), identities = new Map([[id(3), identity(5, 'MCS')]]);
  assert.deepEqual(keys(completing.insert(recent, [missing], identities, 'recent', now)), keys([recent[0], missing, recent[1]]));
  assert.deepEqual(keys(completing.insert(recent.slice().reverse(), [missing], identities, 'oldest', now)), keys([recent[1], missing, recent[0]]));
  const undated = shell(4); identities.set(id(4), { listMessage: { direction: 'CUSTOMER', channel: 'SMS', at: null } });
  for (const mode of ['recent', 'oldest']) assert.equal(completing.insert(recent, [undated], identities, mode, now).at(-1), undated);
});

test('valor, carro, Ref e localização seguem o comparador do painel; sem dados vai ao fim', () => {
  const missing = shell(3), identities = new Map([[id(3), identity(5, 'MCS', { location: 'GA', calcRef: 'ABCDE', refAt: at(5) })]]);
  for (const mode of ['value_desc', 'value_asc', 'vehicle']) {
    const existing = [row(1, 1, false, { budgetCents: 500000, make: 'BMW' }), row(2, 20, false, { budgetCents: 100000, make: 'Ford' })];
    assert.equal(completing.insert(existing, [missing], identities, mode, now).at(-1), missing);
  }
  for (const mode of ['location', 'ref_recent']) {
    const existing = [row(1, 1, false, { state: 'FL', reference_code: 'AAAAA', refAt: at(1) }), row(2, 20, false, { state: 'NY', reference_code: 'BBBBB', refAt: at(20) })];
    assert.deepEqual(keys(completing.insert(existing, [missing], identities, mode, now)), keys([existing[0], missing, existing[1]]));
  }
});

test('dados de apresentação não alteram bucket, contagens nem o pedido incompleto', () => {
  const input = { todayItems: [{ kind: 'JOURNEY', id: id(1), awaitingReply: true }], incomplete: [{ key: 'r', journeyId: id(3), missing: ['make', 'model'], lacksText: 'Falta carro' }], now };
  const model = attend.model(input), before = structuredClone(model);
  const identities = new Map([[id(3), identity(5, 'CUSTOMER')]]);
  completing.insert(model.cases.filter((entry) => entry.item).map((entry) => ({ entry })), model.cases.filter((entry) => !entry.item).map((entry) => ({ entry })), identities, 'ready', now);
  assert.deepEqual(model, before);
  assert.equal(model.counts.completar, 1);
  assert.equal(model.cases.find((entry) => !entry.item).bucket, 'completar');
});

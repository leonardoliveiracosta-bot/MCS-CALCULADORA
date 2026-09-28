'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { sortItems, lastRealMessageAt } = require('../panel-sort');

test('ultima mensagem real ignora automaticas e desfeitas e usa occurred_at_local se faltar a UTC', () => {
  const at = lastRealMessageAt([
    { occurred_at_utc: '2026-08-09T15:10:49Z', direction: 'CUSTOMER' },
    { occurred_at_utc: '2026-09-27T14:20:00Z', direction: 'MCS', is_automatic: true },
    { occurred_at_utc: '2026-09-20T10:00:00Z', direction: 'MCS', undone_at: '2026-09-21T00:00:00Z' },
    { occurred_at_local: '2026-08-12T09:00:00', direction: 'MCS' }
  ]);
  assert.equal(at, '2026-08-12T09:00:00');
  assert.equal(lastRealMessageAt([{ occurred_at_utc: '2026-09-27T00:00:00Z', is_automatic: true }]), null);
  assert.equal(lastRealMessageAt([]), null);
});

test('Mais antigas e Mais recentes usam sortAt do servidor, nao a data de atualizacao do registro', () => {
  const items = [
    { id: 'setembro', sortAt: '2026-09-25T12:00:00Z', updated_at: '2026-09-27T14:20:00Z' },
    { id: 'agosto', sortAt: '2026-08-09T15:10:49Z', updated_at: '2026-09-27T14:20:01Z' },
    { id: 'sem-data', sortAt: null, updated_at: '2026-09-28T00:00:00Z' }
  ];
  assert.deepEqual(sortItems(items, 'oldest').map((item) => item.id), ['agosto', 'setembro', 'sem-data']);
  assert.deepEqual(sortItems(items, 'recent').map((item) => item.id), ['setembro', 'agosto', 'sem-data']);
});

test('sem sortAt o comportamento antigo continua', () => {
  const items = [{ id: 'a', updated_at: '2026-09-01T00:00:00Z' }, { id: 'b', updated_at: '2026-09-02T00:00:00Z' }];
  assert.deepEqual(sortItems(items, 'recent').map((item) => item.id), ['b', 'a']);
});

test('CLIENTES, PEDIDOS e ENTRADA mandam sortAt calculado no servidor', () => {
  const read = (file) => fs.readFileSync(require.resolve('../' + file), 'utf8');
  assert.match(read('api/panel/records.js'), /sortAt:lastRealAt\|\|order\?\.occurredAt\|\|null/);
  assert.match(read('api/panel/orders.js'), /sortAt: lastRealByJourney\(/);
  assert.match(read('api/panel/entry.js'), /sortAt: lastRealMessageAt\(messagesByChat\.get\(chat\.id\)\)/);
  const panel = read('painel/painel.js');
  assert.match(panel, /última mensagem: \$\{floridaDayMonth\(item\.lastRealMessageAt\)\}/);
  assert.match(panel, /timeZone:'America\/New_York'/);
});

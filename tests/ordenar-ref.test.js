'use strict';
// "Ref mais recentes": a Ref que nasceu por último (primeira simulação da calculadora) primeiro.
// Mensagem nova não muda a ordem; quem não tem Ref vai para o fim.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sortItems, MODES } = require('../panel-sort');

test('Ref mais recentes: pela data em que a Ref nasceu, nunca pela última mensagem', () => {
  assert.ok(MODES.has('ref_recent'));
  const items = [
    { key: 'a', ref: 'AAAAA', refAt: '2026-10-01T10:00:00Z', sortAt: '2026-10-05T23:00:00Z' },
    { key: 'b', ref: 'BBBBB', refAt: '2026-10-04T10:00:00Z', sortAt: '2026-10-02T10:00:00Z' },
    { key: 'c', ref: '', refAt: null, sortAt: '2026-10-05T23:59:00Z' },
    { key: 'd', ref: 'DDDDD', refAt: '2026-10-03T10:00:00Z', sortAt: null }
  ];
  assert.deepEqual(sortItems(items, 'ref_recent').map((item) => item.key), ['b', 'd', 'a', 'c']);
});

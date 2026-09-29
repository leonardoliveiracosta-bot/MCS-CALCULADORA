'use strict';

// Identidade visual: the redesign may change CSS and layout, never the hooks the system uses.
// The frozen inventory (tests/fixtures/inventario-painel.json) was generated on main 675d906 from
// the tests and the panel scripts; every ID, class and data-* attribute in it must still exist.
const test = require('node:test');
const assert = require('node:assert/strict');
const frozen = require('./fixtures/inventario-painel.json');
const { defined } = require('./fixtures/inventario-painel');

const now = defined();

for (const kind of ['ids', 'classes', 'data']) {
  test(`inventário protegido: ${kind} usados por testes e scripts continuam definidos`, () => {
    assert.ok(frozen[kind].length > 10, 'inventário não vazio');
    const missing = frozen[kind].filter((item) => !now[kind].has(item.name)).map((item) => `${item.name} (${item.usedBy.join(', ')})`);
    assert.deepEqual(missing, []);
  });
  test(`inventário protegido: nenhum ${kind} definido na base foi removido ou renomeado`, () => {
    const missing = frozen.definedAtBase[kind].filter((name) => !now[kind].has(name));
    assert.deepEqual(missing, []);
  });
}

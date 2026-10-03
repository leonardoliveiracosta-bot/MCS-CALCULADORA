'use strict';
// A conferência não re-julga marca/modelo pela IA: só o servidor, com o mesmo modelsMatch da busca.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { modelsMatch } = require('../vehicle-catalog');
const source = fs.readFileSync(path.join(__dirname, '../panel-manheim-audit.js'), 'utf8');

test('MAKE_MODEL fora dos códigos que a IA pode devolver', () => {
  const codes = source.match(/const MODEL_CODES = Object\.freeze\(\[([^\]]*)\]/)[1];
  assert.doesNotMatch(codes, /MAKE_MODEL/);
  assert.match(source, /modelsMatch\(parsed\.model, wish\.model, parsed\.make, wish\.make\)/);
});

test('famílias do catálogo casam com o modelo pedido (sem versão na calculadora)', () => {
  for (const [car, asked] of [['Escalade ESV', 'Escalade'], ['Yukon XL', 'Yukon'], ['Grand Cherokee L', 'Grand Cherokee'], ['Santa Fe Sport', 'Santa Fe'], ['XV Crosstrek', 'Crosstrek'], ['Escalade EXT', 'Escalade']]) assert.equal(modelsMatch(car, asked, '', ''), true, car);
  assert.equal(modelsMatch('Tahoe', 'Escalade', 'Chevrolet', 'Cadillac'), false);
});

'use strict';
// ENVIAR OPÇÕES com todos: o servidor sabe se cada pedido já foi comparado com o lote ativo (na
// importação, targets_json, ou depois, manheim_demand_syncs), com o critério de hoje.
const test = require('node:test');
const assert = require('node:assert/strict');
const { comparedKeys } = require('../panel-buscas-view');

test('pedido comparado = mesma chave e mesmo critério, na importação ou depois', () => {
  const known = comparedKeys([{ key: 'journey:a:CARRO', criteriaHash: 'h1' }], [{ demand_key: 'journey:b:VALOR', criteria_hash: 'h2' }]);
  assert.equal(known.has('journey:a:CARRO|h1'), true);
  assert.equal(known.has('journey:b:VALOR|h2'), true);
  assert.equal(known.has('journey:a:CARRO|h9'), false, 'critério mudou: ainda não comparado');
  assert.equal(known.has('journey:c:CARRO|h1'), false, 'pedido novo: ainda não comparado');
  assert.equal(comparedKeys(null, null), null, 'sem leitura: desconhecido, nunca "não comparado"');
  assert.equal(comparedKeys(null, []).size, 0);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { orderSummaries } = require('../panel-order-summary');
const { buildIndex } = require('../panel-classification');

test('cada pedido recebe o próprio resumo', () => {
  const result = orderSummaries({ orders: ['AAAAA', 'BBBBB'], summaries: [{ ref: 'AAAAA', summary: 'quer Camry até 6 mil' }, { ref: 'BBBBB', summary: 'quer Charger por valor' }] });
  assert.equal(result.state, 'POR_PEDIDO');
  assert.deepEqual(result.items.map((item) => item.ref), ['AAAAA', 'BBBBB']);
});

test('pedidos indistinguíveis: ambiguidade declarada e nenhum resumo atribuído', () => {
  const result = orderSummaries({ orders: ['AAAAA', 'BBBBB'], summaries: [{ ref: null, summary: 'cliente fala de carros' }] });
  assert.equal(result.state, 'AMBIGUO');
  assert.deepEqual(result.items, []);
  assert.match(result.text, /AAAAA, BBBBB.*ambiguidade declarada/);
});

test('um pedido sem Ref nomeada recebe o resumo; Ref inventada pelo Claude não vale', () => {
  assert.deepEqual(orderSummaries({ orders: ['AAAAA'], summaries: [{ ref: null, summary: 'x' }] }).items, [{ ref: 'AAAAA', summary: 'x' }]);
  const invented = orderSummaries({ orders: ['AAAAA', 'BBBBB'], summaries: [{ ref: 'ZZZZZ', summary: 'y' }, { ref: 'AAAAA', summary: 'z' }] });
  assert.equal(invented.state, 'AMBIGUO');
  assert.deepEqual(invented.missing, ['BBBBB']);
  assert.equal(invented.items.length, 1);
});

test('sem leitura por pedido nada é inventado', () => {
  assert.equal(orderSummaries({ orders: ['AAAAA'], summaries: [] }).state, 'SEM_LEITURA');
});

test('a classificação entrega os resumos por pedido junto com o assunto', () => {
  const index = buildIndex([], [{ journey_id: 'j', subject: 'PEDIDO_CARRO', classified_at: '2026-10-02T10:00:00Z', reason: 'x', request_summaries: [{ ref: 'AAAAA', summary: 'ok' }] }]);
  assert.equal(index.subjectOf('j').summaries[0].ref, 'AAAAA');
  assert.deepEqual(index.subjectOf('outra').summaries || [], []);
});

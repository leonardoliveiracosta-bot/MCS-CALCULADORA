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

const { pendingSummary, AMBIGUOUS_TEXT } = require('../panel-order-summary');

test('Pendências: sem pedido, o resumo é da conversa e vem marcado como conversa', () => {
  const result = pendingSummary({ orders: [], summaries: [], conversationSummary: 'cliente quer saber prazo' });
  assert.equal(result.state, 'CONVERSA');
  assert.deepEqual(result.items, [{ ref: null, scope: 'conversa', summary: 'cliente quer saber prazo' }]);
});

test('Pendências: um resumo por pedido, só o do próprio pedido', () => {
  const result = pendingSummary({ orders: ['AAAAA', 'BBBBB'], summaries: [{ ref: 'AAAAA', summary: 'Camry' }, { ref: 'BBBBB', summary: 'Charger' }], conversationSummary: 'texto da conversa inteira' });
  assert.equal(result.state, 'PEDIDO');
  assert.deepEqual(result.items.map((item) => [item.ref, item.scope, item.summary]), [['AAAAA', 'pedido', 'Camry'], ['BBBBB', 'pedido', 'Charger']]);
  assert.ok(!JSON.stringify(result).includes('texto da conversa inteira'));
});

test('Pendências: pedidos indistinguíveis = ambíguo, aguardando a IA; o texto da conversa não vai a nenhum pedido', () => {
  const result = pendingSummary({ orders: ['AAAAA', 'BBBBB'], summaries: [{ ref: null, summary: 'fala de carros' }], conversationSummary: 'texto da conversa inteira' });
  assert.equal(result.state, 'AMBIGUO');
  assert.equal(result.text, AMBIGUOUS_TEXT);
  assert.deepEqual(result.items, []);
  const partial = pendingSummary({ orders: ['AAAAA', 'BBBBB'], summaries: [{ ref: 'AAAAA', summary: 'Camry' }] });
  assert.equal(partial.state, 'AMBIGUO');
  assert.deepEqual(partial.items.map((item) => item.ref), ['AAAAA']);
  assert.deepEqual(partial.missing, ['BBBBB']);
});

test('Pendências: sem nenhum resumo nada é inventado', () => {
  assert.equal(pendingSummary({ orders: ['AAAAA', 'BBBBB'], summaries: [], conversationSummary: 'x' }).state, 'SEM_LEITURA');
  assert.equal(pendingSummary({ orders: ['AAAAA'], summaries: [], conversationSummary: 'x' }).items[0].scope, 'conversa');
  assert.equal(pendingSummary({}).state, 'SEM_LEITURA');
});

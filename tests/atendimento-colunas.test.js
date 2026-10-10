'use strict';

// Ordenar pelo cabeçalho do Atendimento: regras do módulo compartilhado (servidor e navegador).
const test = require('node:test');
const assert = require('node:assert/strict');
const columns = require('../painel/atendimento-colunas');
const pageRules = require('../panel-attend-page');

const entry = (n, facts, extra = {}) => ({ key: 'k' + n, bucket: 'atender', reasons: [], decisions: [], requests: [], item: { kind: 'JOURNEY', id: 'i' + n, phones: [], cardFacts: facts, ...extra } });
const valor = (cents) => ({ modes: ['VALOR'], perMode: { VALOR: { vehicleText: 'Carro', budgetCents: cents } } });

test('coluna válida só com chave conhecida e sentido asc ou desc', () => {
  assert.equal(pageRules.columnOf('valor:asc'), 'valor:asc');
  assert.equal(pageRules.columnOf('estado:desc'), 'estado:desc');
  for (const bad of [undefined, null, '', 'valor', 'valor:up', 'nome:asc', 'valor:asc:x', {}]) assert.equal(pageRules.columnOf(bad), null, String(bad));
});

test('sem coluna (o caminho comum) a ordem é exatamente a mesma', () => {
  const order = [1, 2, 3].map((n) => ({ entry: entry(n, valor(n * 100)), data: {} }));
  assert.equal(columns.sortOrder(order, null, () => null), order);
  assert.equal(columns.sortOrder(order, 'invalida:asc', () => null), order);
});

test('vazio sempre no fim, empate mantém a ordem anterior, desc inverte só os preenchidos', () => {
  const order = [entry(1, valor(500)), entry(2, {}), entry(3, valor(100)), entry(4, valor(500)), entry(5, {})].map((one) => ({ entry: one, data: {} }));
  const keys = (column) => columns.sortOrder(order, column, () => null).map((row) => row.entry.key);
  assert.deepEqual(keys('valor:asc'), ['k3', 'k1', 'k4', 'k2', 'k5']);
  assert.deepEqual(keys('valor:desc'), ['k1', 'k4', 'k3', 'k2', 'k5']);
});

test('estado: o escrito pela calculadora; só com o número, a faixa do ZIP', () => {
  assert.equal(columns.state('33101 — Miami, FL'), 'FL');
  assert.equal(columns.state('10001 — New York, NY'), 'NY');
  for (const [zip, state] of [['33101', 'FL'], ['32801', 'FL'], ['10001', 'NY'], ['90001', 'CA'], ['75001', 'TX'], ['30301', 'GA'], ['60601', 'IL'], ['98101', 'WA'], ['02108', 'MA'], ['07030', 'NJ'], ['20001', 'DC'], ['85001', 'AZ'], ['88510', 'TX']]) assert.equal(columns.state(zip), state, zip);
  assert.equal(columns.state(''), '');
  assert.equal(columns.state('not recognized'), '');
});

test('servidor: a coluna ordena a lista inteira antes de cortar a página', () => {
  const now = Date.now();
  const items = Array.from({ length: 45 }, (_, n) => ({ kind: 'JOURNEY', id: `7f400000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`, contact: { display_name: 'P' + n }, phones: [], sortAt: new Date(now - n * 60000).toISOString(), group: { key: 'ATENDIDO' }, cardFacts: valor((n + 1) * 10000) }));
  const model = pageRules.modelOf({ items, discardedJourneys: [] }, { chats: [], reviews: [] }, {}, {}, { items: [] }, 'ready', now);
  const plain = pageRules.select(model, new Map(), { sort: 'ready', now });
  const byValue = pageRules.select(model, new Map(), { sort: 'ready', now, column: 'valor:desc' });
  assert.equal(byValue.order.length, 45);
  assert.equal(byValue.order[0].entry.item.cardFacts.perMode.VALOR.budgetCents, 450000, 'o maior valor está fora dos 30 primeiros da ordem padrão');
  assert.ok(plain.order.slice(0, 30).every((row) => row.entry.item.cardFacts.perMode.VALOR.budgetCents !== 450000));
  assert.deepEqual(pageRules.select(model, new Map(), { sort: 'ready', now, column: null }).order.map((row) => row.entry.key), plain.order.map((row) => row.entry.key));
});

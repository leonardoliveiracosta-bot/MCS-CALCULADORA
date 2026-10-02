'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { listCriteria } = require('../panel-domain');
const merge = require('../panel-request-merge');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ficha = (extra = {}) => ({ id: 'j1', vehicle_text: null, budget_cents: null, criteria_json: {}, ...extra });
const order = (ref, vehicleText, budgetCents) => ({ ref, vehicleText, budgetCents, wishlists: [{ make: vehicleText.split(' ')[0], model: vehicleText.split(' ').slice(1).join(' ') }] });

test('R7T8Q: a ficha sem carro nem lance mostra na lista o Dodge Charger e US$ 5.000 da calculadora, com a procedência', () => {
  const shown = listCriteria(ficha(), [order('R7T8Q', 'Dodge Charger', 500000)]);
  assert.equal(shown.vehicleText, 'Dodge Charger');
  assert.equal(shown.budgetCents, 500000);
  assert.deepEqual([shown.vehicleSource, shown.bidSource], ['CALCULADORA', 'CALCULADORA']);
});

test('a ficha vence a calculadora: o carro e o lance que a ficha tem são os da lista', () => {
  const shown = listCriteria(ficha({ budget_cents: 750000, criteria_json: { wishlists: [{ make: 'Ford', model: 'Mustang' }] } }), [order('R7T8Q', 'Dodge Charger', 500000)]);
  assert.equal(shown.vehicleText, 'Ford Mustang');
  assert.equal(shown.budgetCents, 750000);
  assert.deepEqual([shown.vehicleSource, shown.bidSource], ['FICHA', 'FICHA']);
});

test('vários pedidos: o cartão de um pedido não herda o lance da ficha nem o carro de outro pedido', () => {
  const orders = [order('AAAAA', 'Dodge Charger', 500000), order('BBBBB', 'Audi Q7', 2000000)];
  const journey = ficha({ budget_cents: 900000 });
  const first = listCriteria(journey, orders, orders[0]);
  assert.deepEqual([first.vehicleText, first.budgetCents], ['Dodge Charger', 500000]);
  const second = listCriteria(journey, orders, orders[1]);
  assert.deepEqual([second.vehicleText, second.budgetCents], ['Audi Q7', 2000000]);
  const person = listCriteria(journey, orders);
  assert.equal(person.vehicleText, 'Dodge Charger | Audi Q7');
  assert.equal(person.budgetCents, 900000);
  assert.equal(person.bidSource, 'FICHA');
});

test('lista de Atendimento e de Clientes usam os mesmos dados efetivos do pedido', () => {
  for (const file of ['api/panel/today.js', 'api/panel/records.js']) assert.match(read(file), /listCriteria/, file);
  assert.match(read('api/panel/today.js'), /criteriaSource/);
  assert.match(read('api/panel/records.js'), /criteriaSource/);
});

test('auditoria de Buscar carros não conta a ficha e a leitura da IA como dois pedidos', () => {
  const source = read('api/panel/pesquisas.js');
  assert.match(source, /async function audit\(ctx\)[\s\S]*merge\.present\(full\.items\)[\s\S]*withCounts\(full, shown\.items\)/);
  // The presentation itself: a conversation reading equal to exactly one ficha request folds into it.
  const wish = { make: 'Ford', model: 'Mustang', yearMin: 2018, yearMax: 2022, minMiles: 0, maxMiles: 80000 };
  const items = [
    { key: 'ficha:1', source: 'FICHA', person: { journeyId: 'J' }, criteria: wish, searchMode: 'CARRO' },
    { key: 'conversa:1', source: 'CONVERSA', person: { journeyId: 'J' }, criteria: wish, searchMode: 'CARRO', chatId: 'c' }
  ];
  const shown = merge.present(items);
  assert.equal(shown.items.length, 1);
  assert.equal(shown.merged, 1);
  assert.equal(shown.items[0].aiEvidence[0].confirmed, false);
  // Two equal requests of the same person: not merged (never choose one for the other).
  const twin = merge.present([items[0], { ...items[0], key: 'ficha:2' }, items[1]]);
  assert.equal(twin.items.length, 3);
});

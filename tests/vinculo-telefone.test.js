'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const link = require('../panel-phone-link');

const ficha = (id, contactName, vehicleText) => ({ id, contactName, vehicleText });

test('telefone liga só quando há exatamente uma ficha e nenhuma contradição', () => {
  const decision = link.decide({ fichas: [ficha('a', 'Ivan Silva', 'Toyota Camry')], values: { name: 'Ivan', message: 'Camry 2019' } });
  assert.deepEqual([decision.action, decision.journeyId], ['LINK', 'a']);
});

test('zero fichas: quarentena com motivo escrito', () => {
  const decision = link.decide({ fichas: [], values: { name: 'Ivan' } });
  assert.equal(decision.action, 'QUARANTINE');
  assert.equal(decision.reason, 'QUARENTENA_SEM_FICHA');
  assert.match(decision.text, /quarentena/);
});

test('duas ou mais fichas: fila com as candidatas, nada escolhido sozinho', () => {
  const decision = link.decide({ fichas: [ficha('a', 'Ivan', ''), ficha('b', 'Ivan', '')], values: { name: 'Ivan' } });
  assert.equal(decision.action, 'QUEUE');
  assert.equal(decision.reason, 'FILA_VARIAS_FICHAS');
  assert.deepEqual(decision.candidates, ['a', 'b']);
  assert.equal(decision.journeyId, undefined);
});

test('contradição de nome ou de carro vai para a fila com o motivo', () => {
  const name = link.decide({ fichas: [ficha('a', 'Ivan Silva', '')], values: { name: 'Maria Souza' } });
  assert.deepEqual([name.action, name.reason, name.conflicts], ['QUEUE', 'FILA_CONTRADICAO', ['nome']]);
  const car = link.decide({ fichas: [ficha('a', 'Ivan', 'Toyota Camry')], values: { name: 'Ivan', message: 'I want a Dodge Charger' } });
  assert.deepEqual(car.conflicts, ['carro']);
  const unknown = link.decide({ fichas: [ficha('a', 'Ivan', '')], values: { name: '', message: 'Dodge' } });
  assert.equal(unknown.action, 'LINK');
});

test('o motivo guarda os candidatos e volta igual', () => {
  const decision = link.decide({ fichas: [ficha('a', 'x', ''), ficha('b', 'x', '')], values: {} });
  assert.deepEqual(link.parse(link.encode(decision)), { code: 'FILA_VARIAS_FICHAS', candidates: ['a', 'b'] });
  assert.deepEqual(link.parse(null), { code: null, candidates: [] });
});

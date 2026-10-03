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

test('telefone igual, nome diferente: nunca junta sozinho, nem quando a ficha não tem nome para conferir', () => {
  // The Dante case: an SMS simulation, a WhatsApp ficha whose contact name is the phone itself.
  const unknown = link.decide({ fichas: [{ id: 'a', contactName: '+18723640049', vehicleText: '' }], values: { name: 'Dante' } });
  assert.deepEqual([unknown.action, unknown.reason, unknown.conflicts], ['QUEUE', 'FILA_CONTRADICAO', ['nome-desconhecido']]);
  // A Ref code saved as the name is no name either.
  assert.equal(link.decide({ fichas: [{ id: 'a', contactName: 'V5XVS', vehicleText: '' }], values: { name: 'Filiberto' } }).action, 'QUEUE');
  // "Philly" is not "Phillip Fleming": a different name.
  assert.deepEqual(link.decide({ fichas: [ficha('a', 'Philly', '')], values: { name: 'Phillip Fleming' } }).conflicts, ['nome']);
  // A name the ficha already knows from its calculator messages joins.
  assert.equal(link.decide({ fichas: [{ id: 'a', contactName: 'V5XVS', names: ['Filiberto Velazquez'], vehicleText: '' }], values: { name: 'Filiberto Velazquez' } }).action, 'LINK');
  assert.equal(link.decide({ fichas: [ficha('a', 'Tyreek Eazy Thompson', '')], values: { name: 'Tyreek Thompson' } }).action, 'LINK');
  // The same chat as the ficha (its own WhatsApp conversation) with no name on the ficha: nothing to contradict.
  assert.equal(link.decide({ fichas: [{ id: 'a', contactName: '+18723640049', sameChat: true, vehicleText: '' }], values: { name: 'Dante' } }).action, 'LINK');
});

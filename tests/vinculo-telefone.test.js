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

test('nome ou carro diferente com uma ficha só: liga e devolve a diferença só como informação', () => {
  const name = link.decide({ fichas: [ficha('a', 'Ivan Silva', '')], values: { name: 'Maria Souza' } });
  assert.deepEqual([name.action, name.journeyId, name.conflicts], ['LINK', 'a', ['nome']]);
  const car = link.decide({ fichas: [ficha('a', 'Ivan', 'Toyota Camry')], values: { name: 'Ivan', message: 'I want a Dodge Charger' } });
  assert.deepEqual([car.action, car.conflicts], ['LINK', ['carro']]);
  const unknown = link.decide({ fichas: [ficha('a', 'Ivan', '')], values: { name: '', message: 'Dodge' } });
  assert.equal(unknown.action, 'LINK');
  assert.equal(unknown.conflicts, undefined);
});

test('o motivo guarda os candidatos e volta igual', () => {
  const decision = link.decide({ fichas: [ficha('a', 'x', ''), ficha('b', 'x', '')], values: {} });
  assert.deepEqual(link.parse(link.encode(decision)), { code: 'FILA_VARIAS_FICHAS', candidates: ['a', 'b'] });
  assert.deepEqual(link.parse(null), { code: null, candidates: [] });
});

test('telefone igual, nome diferente ou sem como conferir: liga mesmo assim (nada de Confirmar vínculo)', () => {
  // The Dante case: an SMS simulation, a WhatsApp ficha whose contact name is the phone itself.
  const unknown = link.decide({ fichas: [{ id: 'a', contactName: '+18723640049', vehicleText: '' }], values: { name: 'Dante' } });
  assert.deepEqual([unknown.action, unknown.journeyId, unknown.conflicts], ['LINK', 'a', ['nome-desconhecido']]);
  assert.equal(link.decide({ fichas: [{ id: 'a', contactName: 'V5XVS', vehicleText: '' }], values: { name: 'Filiberto' } }).action, 'LINK');
  assert.deepEqual(link.decide({ fichas: [ficha('a', 'Philly', '')], values: { name: 'Phillip Fleming' } }).conflicts, ['nome']);
  // The name check itself is unchanged (still used as information).
  assert.equal(link.nameConflict('Tyreek Thompson', ficha('a', 'Tyreek Eazy Thompson', '')), null);
  assert.equal(link.nameConflict('Dante', { id: 'a', contactName: '+18723640049', sameChat: true }), null);
});

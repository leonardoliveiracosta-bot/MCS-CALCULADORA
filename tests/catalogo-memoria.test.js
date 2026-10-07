'use strict';

// Catálogo de modelos: os resultados que só dependem do texto e do dicionário (apelidos + modelos conhecidos) são
// lembrados por texto e esquecidos quando o dicionário muda. PESQUISAS pergunta os mesmos modelos para 1.000+ pedidos.
const test = require('node:test');
const assert = require('node:assert/strict');
const catalog = require('../vehicle-catalog');

test('caminho comum: mesma resposta de antes, lembrada para o mesmo texto', () => {
  catalog.configureAliases([], [], 'teste-a');
  assert.equal(catalog.recognized('Corolla', 'Toyota'), true);
  assert.equal(catalog.recognized('Corolla', 'Toyota'), true);
  assert.equal(catalog.recognized('Carro Inventado', 'Toyota'), false);
  assert.equal(catalog.inferMake('X5').make, 'BMW');
  assert.equal(catalog.normalizeName('Grand Cherokee'), 'grandcherokee');
  // null and the text "null" are different questions.
  assert.equal(catalog.normalizeName(null), catalog.normalizeName(''));
  assert.equal(catalog.normalizeName('null'), 'null');
});

test('dicionário novo: um apelido ou modelo conhecido novo vale na hora (nada lembrado de antes)', () => {
  catalog.configureAliases([], [], 'teste-b');
  assert.equal(catalog.recognized('Zeta Max', 'Acme'), false);
  assert.equal(catalog.inferMake('Zeta Max').make, '');
  catalog.configureAliases([], [{ make: 'Acme', model: 'Zeta Max' }], 'teste-b');
  assert.equal(catalog.recognized('Zeta Max', 'Acme'), true);
  assert.equal(catalog.inferMake('Zeta Max').make, 'Acme');
  catalog.configureAliases([], [], 'teste-b');
  assert.equal(catalog.recognized('Zeta Max', 'Acme'), false);
});

test('quem recebe a resposta não altera a resposta lembrada', () => {
  catalog.configureAliases([], [], 'teste-c');
  const first = catalog.inferMake('Civic');
  first.candidates.push('Outra');
  first.make = 'Outra';
  const second = catalog.inferMake('Civic');
  assert.equal(second.make, 'Honda');
  assert.deepEqual(second.candidates, ['Honda']);
});

test('ficha de um pedido lido da conversa: índice montado uma vez, refeito quando entra ligação nova', () => {
  const { fichaOf } = require('../panel-search-to-ficha');
  const links = [{ message_id: 'm1', journey_id: 'j1' }, { message_id: 'm2', journey_id: 'j2' }, { message_id: 'm3', journey_id: 'j1', undone_at: '2026-10-01' }];
  const base = { messageLinks: links };
  assert.equal(fichaOf({ evidence: [{ id: 'm1' }] }, base), 'j1');
  assert.equal(fichaOf({ evidence: [{ id: 'm1' }, { id: 'm2' }] }, base), null);
  assert.equal(fichaOf({ evidence: [{ id: 'm3' }] }, base), null);
  links.push({ message_id: 'm4', journey_id: 'j2' });
  assert.equal(fichaOf({ evidence: [{ id: 'm4' }] }, base), 'j2');
  assert.equal(fichaOf({ evidence: [{ id: 'm9' }] }, { messageLinks: undefined }), null);
});

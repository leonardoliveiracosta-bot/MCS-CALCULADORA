'use strict';
// A Ref do fim da mensagem é a prova: liga sempre à ficha dona dela. Nome ou carro diferente do que a ficha já sabe por
// outras fontes fica só anotado (evidence.conflicts), nunca segura a mensagem em "Confirmar vínculo".
const test = require('node:test');
const assert = require('node:assert/strict');
const route = require('../panel-calc-route');
const calcMessage = require('../panel-calc-message');

const text = (name, vehicle, ref) => `Hello! I just ran a simulation on the My Car Scout calculator\n\nName: ${name}\nVehicle: ${vehicle}\nMaximum bid: $20,000\n\nRef: ${ref}`;
const owner = (extra) => ({ id: 'j1', contact_id: 'c1', contactName: '', names: [], vehicleText: '', ...extra });

test('Ref de uma ficha que já conhece o mesmo nome e carro: liga pela Ref', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Ana Souza', 'Honda Civic', 'ABCDE')), refOwners: [owner({ contactName: 'Ana', vehicleText: 'Honda Civic' })], contactId: 'c1' });
  assert.deepEqual([verdict.destination, verdict.journeyId], ['LIGADA_REF', 'j1']);
});

test('Ref de uma ficha com outro nome (caso 4NRJ5: Alic na calculadora, Mirzet na ficha): liga pela Ref, o nome fica anotado', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Alic', 'Porsche Cayenne', '4NRJ5')), refOwners: [owner({ contactName: 'Mirzet' })], contactId: 'c1' });
  assert.deepEqual([verdict.destination, verdict.reason, verdict.journeyId, verdict.link], ['LIGADA_REF', 'REF_ENCONTRADA', 'j1', true]);
  assert.deepEqual(verdict.evidence.conflicts, ['nome']);
  assert.equal(verdict.unlinkAuto, undefined, 'nada é desligado');
});

test('Ref de uma ficha com outro carro: liga pela Ref, o carro fica anotado', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Ana', 'Dodge Charger', 'ABCDE')), refOwners: [owner({ contactName: 'Ana', vehicleText: 'Toyota Camry' })], contactId: 'c1' });
  assert.deepEqual([verdict.destination, verdict.journeyId, verdict.evidence.conflicts], ['LIGADA_REF', 'j1', ['carro']]);
});

test('Ref de ficha de outro contato (raro, 0 vezes na produção): liga pela Ref com a marca para o aviso na ficha', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Ana', 'Honda Civic', 'ABCDE')), refOwners: [owner({ contactName: 'Ana', contact_id: 'c9' })], contactId: 'c1', fichas: [{ id: 'j2', contactName: 'Ana', names: [], vehicleText: '' }] });
  assert.deepEqual([verdict.destination, verdict.journeyId, verdict.evidence.refOutroContato], ['LIGADA_REF', 'j1', true]);
});

test('caminho comum: Ref com o mesmo nome liga direto, sem nada anotado', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Ana Souza', 'Honda Civic', 'ABCDE')), refOwners: [owner({ contactName: 'Ana', vehicleText: 'Honda Civic' })], contactId: 'c1' });
  assert.equal(verdict.destination, 'LIGADA_REF');
  assert.equal(verdict.evidence.conflicts, undefined);
  assert.equal(verdict.evidence.refOutroContato, undefined);
});

test('a mesma Ref em duas fichas (ambígua) continua na fila', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Ana', 'Honda Civic', 'ABCDE')), refOwners: [owner(), owner({ id: 'j2' })], contactId: 'c1' });
  assert.deepEqual([verdict.destination, verdict.reason], ['FILA', 'REF_EM_VARIAS_FICHAS']);
});

test('ficha sem nome nenhum: a Ref é a prova, nada a contradizer', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Dante', 'Chevrolet Corvette', 'ABCDE')), refOwners: [owner({ contactName: '+18723640049' })], contactId: 'c1' });
  assert.equal(verdict.destination, 'LIGADA_REF');
});

test('o nome que a ficha conhece por outra simulação ou mensagem conta', () => {
  const verdict = route.decide({ parsed: calcMessage.parse(text('Filiberto Velazquez', 'Ford F-150', 'ABCDE')), refOwners: [owner({ contactName: 'V5XVS', names: ['Filiberto Velazquez'], vehicleText: 'Ford F-150' })], contactId: 'c1' });
  assert.equal(verdict.destination, 'LIGADA_REF');
});

test('a identidade da ficha ignora esta mensagem e a simulação desta Ref (sempre concordariam consigo mesmas)', async () => {
  const tables = {
    journeys: [{ id: 'j1', reference_code: 'ABCDE', vehicle_text: 'Toyota Camry' }],
    contacts: [{ id: 'c1', display_name: 'Flava' }],
    message_journeys: [{ message_id: 'm-self' }, { message_id: 'm-old' }],
    journey_refs: [{ ref_code: 'ABCDE' }, { ref_code: 'FGHJK' }],
    messages: [{ id: 'm-old', body_text: text('Flavia Lima', 'Toyota Camry', 'FGHJK') }],
    calc_runs: [{ dados: { ref: 'FGHJK', nome: 'Flavia Lima', marca: 'Toyota', modelo: 'Camry' }, is_test: false }]
  };
  const seen = [];
  const read = async (_, table, params) => { seen.push([table, params]); return tables[table] || []; };
  const identity = await route.ownerIdentity({ environment: 'preview' }, { id: 'j1', contact_id: 'c1' }, { message_id: 'm-self' }, 'ABCDE', read);
  assert.equal(identity.contactName, 'Flava');
  assert.deepEqual(identity.names, ['Flavia Lima', 'Flavia Lima']);
  const messageRead = seen.find(([table]) => table === 'messages')[1];
  assert.doesNotMatch(messageRead.id, /m-self/, 'esta mensagem nunca é a prova dela mesma');
  const runRead = seen.find(([table]) => table === 'calc_runs')[1];
  assert.equal(runRead['dados->>ref'], 'in.(FGHJK)', 'a simulação desta Ref não entra');
});

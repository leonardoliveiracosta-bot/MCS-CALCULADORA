'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const parser = require('../painel/parser');

const cases = [
  ['iPhone PT', '[25/09/2026, 14:30:00] MCS: Olá\n[25/09/2026, 14:31:00] Cliente: Oi', 'DMY'],
  ['Android PT', '25/09/2026 14:30 - MCS: Olá\n25/09/2026 14:31 - Cliente: Oi', 'DMY'],
  ['iPhone EN', '[9/25/26, 2:30 PM] MCS: Hello\n[9/25/26, 2:31 PM] Customer: Hi', 'MDY'],
  ['Android EN', '9/25/26, 2:30 PM - MCS: Hello\n9/25/26, 2:31 PM - Customer: Hi', 'MDY']
];

for (const [name, raw, order] of cases) {
  test(`parses ${name}`, () => {
    const result = parser.parseWhatsApp(raw, 'chat.txt', {});
    assert.equal(result.supported, true);
    assert.equal(result.dateOrder, order);
    assert.equal(result.entries.length, 2);
  });
}

test('requires manual date order when DD/MM and MM/DD are both possible', () => {
  const result = parser.parseWhatsApp('[05/09/2026, 14:30] MCS: teste\n[05/09/2026, 14:31] Cliente: teste', 'chat.txt', {});
  assert.equal(result.supported, true);
  assert.equal(result.requiresDateOrder, true);
});

test('marks repeated New York hour uncertain', () => {
  const result = parser.parseWhatsApp('[01/11/2026, 01:30] MCS: teste', 'chat.txt', { dateOrder: 'DMY' });
  assert.equal(result.entries[0].date.timeUncertain, true);
  assert.equal(result.entries[0].date.utc, null);
});

test('marks nonexistent New York hour uncertain', () => {
  const result = parser.parseWhatsApp('[08/03/2026, 02:30] MCS: teste', 'chat.txt', { dateOrder: 'DMY' });
  assert.equal(result.entries[0].date.timeUncertain, true);
  assert.equal(result.entries[0].date.utc, null);
});

test('normal hour has a single UTC instant', () => {
  const result = parser.parseWhatsApp('[08/03/2026, 03:30] MCS: teste', 'chat.txt', { dateOrder: 'DMY' });
  assert.equal(result.entries[0].date.timeUncertain, false);
  assert.match(result.entries[0].date.utc, /Z$/);
});

test('keeps multiline, omitted media, and HTML as plain text', () => {
  const raw = '[25/09/2026, 14:30] MCS: <b>não executar</b>\nsegunda linha\n[25/09/2026, 14:31] Cliente: <Media omitted>';
  const result = parser.parseWhatsApp(raw, 'chat.txt', {});
  assert.equal(result.entries[0].body, '<b>não executar</b>\nsegunda linha');
  assert.equal(result.entries[1].mediaOmitted, true);
});

test('two active participants still require explicit group confirmation', () => {
  const result = parser.parseWhatsApp('[25/09/2026, 14:30] A: um\n[25/09/2026, 14:31] B: dois', 'chat.txt', {});
  assert.equal(result.groupSignal, false);
  assert.equal(result.requiresGroupConfirmation, true);
});

test('explicit group signal is detected even with two active participants', () => {
  const raw = '[25/09/2026, 14:00] A criou o grupo “Teste”\n[25/09/2026, 14:30] A: um\n[25/09/2026, 14:31] B: dois';
  const result = parser.parseWhatsApp(raw, 'chat.txt', {});
  assert.equal(result.groupSignal, true);
});

test('direction comes only from the confirmed MCS sender', () => {
  const parsed = parser.parseWhatsApp('[25/09/2026, 14:30] Loja: um\n[25/09/2026, 14:31] Cliente: dois', 'chat.txt', {});
  const entries = parser.assignDirections(parsed, 'Loja');
  assert.deepEqual(entries.map((entry) => entry.direction), ['MCS', 'CUSTOMER']);
  assert.throws(() => parser.assignDirections(parsed, 'Nome inexistente'), /MCS_SENDER_REQUIRED/);
});

test('extracts only valid five-character Refs', () => {
  assert.deepEqual(parser.extractRefs([{ body: 'Ref: AB2CD' }, { body: 'Ref: IO101' }]), ['AB2CD']);
});

test('unknown format is rejected', () => {
  assert.equal(parser.parseWhatsApp('texto qualquer', 'chat.txt', {}).supported, false);
});

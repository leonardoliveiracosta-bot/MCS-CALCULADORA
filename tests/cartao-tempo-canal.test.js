'use strict';
// Todo tempo no cartão diz o canal e o que mede; sem canal conhecido, o tempo não aparece.
const test = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../panel-groups');

const now = Date.parse('2026-10-03T18:00:00Z');
const ago = (ms) => new Date(now - ms).toISOString();

test('sem resposta: "WhatsApp há 8 dias · sem resposta", e sem canal nada de tempo', () => {
  const facts = { lastCustomerAt: ago(8 * 86400000), lastCustomerChannel: 'WHATSAPP', awaitingReply: true };
  assert.equal(groups.unattendedOf(facts, now).timeLabel, 'WhatsApp há 8 dias · sem resposta');
  assert.equal(groups.unattendedOf({ ...facts, lastCustomerAt: ago(18 * 60000), lastCustomerChannel: 'SMS' }, now).timeLabel, 'SMS há 18 min · sem resposta');
  assert.equal(groups.unattendedOf({ ...facts, lastCustomerChannel: null }, now).timeLabel, null);
});

test('sem ação: mede a nossa última mensagem com o canal dela', () => {
  const facts = { lastMcsAt: ago(9 * 86400000), lastMcsChannel: 'WHATSAPP', awaitingReply: false };
  assert.equal(groups.unattendedOf(facts, now).timeLabel, 'WhatsApp há 9 dias · nossa última mensagem, sem ação depois');
  assert.equal(groups.unattendedOf({ ...facts, lastMcsChannel: null }, now).timeLabel, null);
});

test('o resumo das mensagens guarda o canal da última do cliente e da nossa', () => {
  const s = groups.summaryFromMessages([
    { id: '1', direction: 'CUSTOMER', channel: 'SMS', occurred_at_utc: ago(3600000), body_text: 'oi' },
    { id: '2', direction: 'MCS', channel: 'WHATSAPP', occurred_at_utc: ago(1800000), body_text: 'olá' }
  ]);
  const facts = groups.factsFor({ summary: s });
  assert.equal(facts.lastCustomerChannel, 'SMS');
  assert.equal(facts.lastMcsChannel, 'WHATSAPP');
});

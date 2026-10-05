'use strict';

// "Ordenar" do ENVIAR OPÇÕES: cada ficha diz por onde veio a última mensagem DO CLIENTE (SMS ou WhatsApp)
// e quando. A nossa resposta nunca conta.
const test = require('node:test');
const assert = require('node:assert/strict');
const { contactIndex, decorateContact, messageMedium } = require('../panel-contact');

test('canal da mensagem: pelo canal gravado, ou pela origem quando ele falta', () => {
  assert.equal(messageMedium({ channel: 'SMS', source_kind: 'IMPORT' }), 'SMS');
  assert.equal(messageMedium({ channel: 'WHATSAPP', source_kind: 'WHATSAPP_WEBHOOK' }), 'WHATSAPP');
  assert.equal(messageMedium({ source_kind: 'SMS_SHORTCUT' }), 'SMS');
  assert.equal(messageMedium({ source_kind: 'WHATSAPP_HISTORY' }), 'WHATSAPP');
  assert.equal(messageMedium({ source_kind: 'IMPORT' }), null);
});

test('a ficha traz a data e o canal da última mensagem do cliente, nunca a nossa', () => {
  const messages = [
    { id: 'a', direction: 'CUSTOMER', channel: 'WHATSAPP', source_kind: 'WHATSAPP_WEBHOOK', occurred_at_utc: '2026-10-05T10:00:00Z' },
    { id: 'b', direction: 'CUSTOMER', channel: 'SMS', source_kind: 'SMS_SHORTCUT', occurred_at_utc: '2026-10-05T12:00:00Z' },
    { id: 'c', direction: 'MCS', channel: 'WHATSAPP', source_kind: 'WHATSAPP_WEBHOOK', occurred_at_utc: '2026-10-05T15:00:00Z' }
  ];
  const index = contactIndex({ messages, messageLinks: messages.map((message) => ({ message_id: message.id, journey_id: 'j1' })) });
  const item = decorateContact({ id: 'j1' }, index.facts({ journeyId: 'j1' }), null, null);
  assert.equal(item.contactAt, '2026-10-05T12:00:00.000Z');
  assert.equal(item.contactMedium, 'SMS');
  const none = decorateContact({ id: 'j2' }, index.facts({ journeyId: 'j2' }), null, null);
  assert.deepEqual([none.contactAt, none.contactMedium], [null, null]);
});

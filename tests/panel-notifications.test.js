'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { isEligibleCustomerMessage } = require('../panel-notifications');
const { THROTTLE_MS, canSendForContact, notificationTitle } = require('../panel-push');

test('only live, individual customer WhatsApp messages are eligible', () => {
  const allowed = new Set(['chat-ok']);
  const valid = { channel: 'WHATSAPP', direction: 'CUSTOMER', is_automatic: false, source_kind: 'WHATSAPP_WEBHOOK', chat_id: 'chat-ok' };
  assert.equal(isEligibleCustomerMessage(valid, allowed), true);
  assert.equal(isEligibleCustomerMessage({ ...valid, chat_id: 'group-chat' }, allowed), false);
  assert.equal(isEligibleCustomerMessage({ ...valid, direction: 'MCS' }, allowed), false);
  assert.equal(isEligibleCustomerMessage({ ...valid, is_automatic: true }, allowed), false);
  assert.equal(isEligibleCustomerMessage({ ...valid, source_kind: 'WHATSAPP_HISTORY' }, allowed), false);
});

test('push title includes only name, Ref and requested car', () => {
  assert.equal(notificationTitle({ name: 'Carlos D.', phone: '+14075553310', ref: '3CG5P', vehicle: 'BMW X5 2018–2021' }), 'Carlos D. · Ref 3CG5P · BMW X5 2018–2021');
  assert.equal(notificationTitle({ phone: '(407) 555-3310' }), '(407) 555-3310 · nova mensagem');
  // A ficha sem Ref comprovada da calculadora diz "sem Ref": o código interno nunca aparece como Ref.
  assert.equal(notificationTitle({ name: 'Ana', ref: null, noRef: true, vehicle: 'Honda Civic' }), 'Ana · sem Ref · Honda Civic');
  assert.doesNotMatch(notificationTitle({ name: 'Ana', vehicle: 'Honda', body: 'conteúdo privado' }), /conteúdo privado/);
});

test('five-minute throttle permits a contact only after the full window', () => {
  const now = Date.parse('2026-09-28T03:00:00.000Z');
  assert.equal(canSendForContact(null, now), true);
  assert.equal(canSendForContact(new Date(now - THROTTLE_MS + 1).toISOString(), now), false);
  assert.equal(canSendForContact(new Date(now - THROTTLE_MS).toISOString(), now), true);
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase/migrations/20260928023000_web_push.sql'), 'utf8');
  assert.match(migration, /interval '5 minutes'/);
  assert.match(migration, /on conflict\(environment,contact_id\) do update/);
});

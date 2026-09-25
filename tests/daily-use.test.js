'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('../painel/parser');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('known WhatsApp chat and MCS alias can import without repeated questions', () => {
  const parsed = parser.parseWhatsApp('[25/09/2026, 14:30] MCS: Olá\n[25/09/2026, 14:31] Cliente: Oi', 'Cliente.txt', {});
  const match = parser.automaticImportMatch(parsed,
    [{ chat_id: 'chat-1', alias_text: 'Cliente' }],
    [{ id: 'chat-1', contact_id: 'contact-1', is_group: false }],
    [{ chat_id: 'chat-1', sender_text: 'MCS', direction: 'MCS' }]);
  assert.equal(match.chat.id, 'chat-1');
  assert.equal(match.mcsSender, 'MCS');
});

test('ambiguous date, group, unknown chat or unknown MCS remains in review', () => {
  const ambiguous = parser.parseWhatsApp('[05/09/2026, 14:30] A: um\n[05/09/2026, 14:31] B: dois', 'Cliente.txt', {});
  assert.equal(parser.automaticImportMatch(ambiguous, [], [], []), null);
  const known = parser.parseWhatsApp('[25/09/2026, 14:30] A: um\n[25/09/2026, 14:31] B: dois', 'Cliente.txt', {});
  assert.equal(parser.automaticImportMatch(known, [{ chat_id: 'c', alias_text: 'Cliente' }], [{ id: 'c', contact_id: 'p', is_group: false }], []), null);
});

test('daily-use migration assigns unique operational Ref only to Preview backfill', () => {
  const sql = read('supabase/migrations/20260925161900_panel_daily_use_refs_and_actions.sql');
  assert.match(sql, /reference_code char\(5\)/);
  assert.match(sql, /unique index[\s\S]*environment, reference_code/i);
  assert.match(sql, /where environment = 'preview' and reference_code is null/i);
  assert.doesNotMatch(sql, /where environment = 'production' and reference_code is null/i);
});

test('ficha uses one menu action for field and checklist and remembers conversation sort', () => {
  const client = read('painel/painel.js');
  const server = read('api/panel/actions.js');
  assert.match(client, /action: 'mark_message'/);
  assert.match(server, /MESSAGE_FACT_MARKED/);
  assert.match(server, /journey_checklist/);
  assert.match(server, /journey_declarations/);
  assert.match(client, /mcs_conversation_sort/);
});

test('expired session clears credentials and returns to login', () => {
  const client = read('painel/painel.js');
  assert.match(client, /response\.status === 401[\s\S]*clearSession\(\)[\s\S]*show\('login-view'\)/);
});

test('all navigation counters are refreshed after login', () => {
  const client = read('painel/painel.js');
  assert.match(client, /async function refreshCounters\(\)/);
  assert.match(client, /await refreshCounters\(\)/);
  for (const view of ['entry', 'orders', 'qualification', 'records']) assert.match(client, new RegExp(`setCount\\('${view}'`));
});

test('unique calculator Ref linking fills only blank journey fields', () => {
  const entry = read('api/panel/entry.js');
  assert.match(entry, /matches\.length !== 1/);
  assert.match(entry, /!journey\.vehicle_text/);
  assert.match(entry, /!journey\.budget_cents/);
  assert.match(entry, /!journey\.payment_text/);
});

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

test('a new contact always defaults to a new journey during simplified review', () => {
  const client = read('painel/painel.js');
  assert.match(client, /journeySelect\.replaceChildren[\s\S]*option\(journeySelect, 'Nova jornada', 'new'\)[\s\S]*journeySelect\.value = 'new'/);
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
  const migration = read('supabase/migrations/20260925173500_panel_atomic_message_mark.sql');
  const markAction = server.match(/async function actionMarkMessage[\s\S]*?\n}\n\nasync function actionNote/)[0];
  assert.match(client, /action: 'mark_message'/);
  assert.match(server, /rpc\/panel_mark_message_fact/);
  assert.match(migration, /unique \(environment, journey_id, message_id, kind\)/i);
  assert.match(migration, /on conflict \(environment, journey_id, message_id, kind\) do nothing/i);
  assert.match(migration, /PANEL_SIMULATED_MESSAGE_MARK_FAILURE/);
  assert.match(migration, /exception[\s\S]*rolledBack/i);
  assert.doesNotMatch(markAction, /insert\(ctx|patchRows\(ctx|recordMutation\(ctx/);
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

test('operational cards share compact identity and open a ficha when linked', () => {
  const client = read('painel/painel.js');
  const qualification = read('api/panel/qualification.js');
  assert.match(client, /function identityHeader/);
  assert.match(client, /function makeCardClickable/);
  assert.match(qualification, /contact_phones/);
  assert.match(qualification, /latestMessage/);
});

test('unique calculator Ref linking fills only blank journey fields', () => {
  const entry = read('api/panel/entry.js');
  assert.match(entry, /matches\.length !== 1/);
  assert.match(entry, /!journey\.vehicle_text/);
  assert.match(entry, /!journey\.budget_cents/);
  assert.match(entry, /!journey\.payment_text/);
});

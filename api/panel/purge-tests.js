'use strict';

// Hard delete of the test records approved by the owner (TESTE FIX, LOTE2/3/4, PUB69, TESTE FICTICIO PR20).
// Only the ids listed in public._purge_teste are touched, in small batches, children before parents.
// The active Manheim batch is never touched (only the matches tied to those test fichas, listed there).
const { requirePanel, rows, send, jsonBody, supabase } = require('../../panel-server');

const BATCH = 50;
const CORE = ['contacts', 'chats', 'journeys', 'messages'];
// Tables without an id of their own that point to the core rows: removed by their link column.
const LEAVES = [
  ['panel_identity_state', 'journey_id', 'journeys'], ['panel_conversation_class', 'journey_id', 'journeys'],
  ['panel_calc_message_route', 'journey_id', 'journeys'], ['panel_calc_message_route', 'message_id', 'messages'],
  ['whatsapp_message_ids', 'message_id', 'messages'], ['message_translations', 'message_id', 'messages'],
  ['whatsapp_user_ids', 'contact_id', 'contacts'], ['whatsapp_auto_replies', 'contact_id', 'contacts'],
  ['panel_push_contact_throttle', 'contact_id', 'contacts'], ['panel_push_contact_throttle', 'last_message_id', 'messages'],
  ['conversation_ai_link_state', 'chat_id', 'chats'], ['conversation_ai_link_state', 'journey_id', 'journeys'],
  ['conversation_ai_attempt_state', 'chat_id', 'chats'], ['conversation_ai_attempt_state', 'journey_id', 'journeys'], ['conversation_ai_attempt_state', 'last_customer_message_id', 'messages'],
  ['conversation_pending_resolutions', 'chat_id', 'chats'], ['conversation_pending_resolutions', 'journey_id', 'journeys'], ['conversation_pending_resolutions', 'resolved_message_id', 'messages'],
  ['conversation_pending_insights', 'chat_id', 'chats'], ['conversation_pending_insights', 'journey_id', 'journeys'], ['conversation_pending_insights', 'last_ai_message_id', 'messages'],
  ['conversation_general_read_progress', 'chat_id', 'chats'], ['conversation_general_read_progress', 'journey_id', 'journeys'], ['conversation_general_read_progress', 'snapshot_last_message_id', 'messages']
];
const TABLE = /^[a-z_]{2,60}$/;

const chunks = (list) => { const out = []; for (let index = 0; index < list.length; index += BATCH) out.push(list.slice(index, index + BATCH)); return out; };
const remove = (ctx, table, column, ids) => supabase(ctx.config.url, ctx.config.secretKey, `/rest/v1/${table}?${column}=in.(${ids.join(',')})`, { method: 'DELETE', headers: { prefer: 'return=representation' } });

async function listed(ctx) {
  const all = await rows(ctx, '_purge_teste', { select: 'tbl,id', limit: '5000' }).catch(() => []);
  const byTable = new Map();
  all.filter((row) => TABLE.test(String(row.tbl || ''))).forEach((row) => { if (!byTable.has(row.tbl)) byTable.set(row.tbl, []); byTable.get(row.tbl).push(row.id); });
  return byTable;
}

async function summary(ctx) {
  const byTable = await listed(ctx);
  const contacts = byTable.get('contacts') || [];
  const names = contacts.length ? await rows(ctx, 'contacts', { select: 'display_name,environment', id: `in.(${contacts.join(',')})` }).catch(() => []) : [];
  return { pending: [...byTable.values()].reduce((sum, ids) => sum + ids.length, 0), counts: Object.fromEntries([...byTable].map(([table, ids]) => [table, ids.length])), names: names.map((row) => row.display_name || '(sem nome)').sort() };
}

async function run(ctx) {
  const byTable = await listed(ctx);
  const deleted = {};
  const count = (table, n) => { if (n) deleted[table] = (deleted[table] || 0) + n; };
  for (const [table, column, parent] of LEAVES) {
    for (const ids of chunks(byTable.get(parent) || [])) count(table, ((await remove(ctx, table, column, ids).catch((error) => { if (error.status === 404) return []; throw error; })) || []).length);
  }
  for (const ids of chunks(byTable.get('vehicle_requests') || [])) count('vehicle_request_versions', ((await remove(ctx, 'vehicle_request_versions', 'request_id', ids)) || []).length);
  // Children before parents: a table whose rows are still referenced answers 409 and waits for the next pass.
  const order = [...byTable.keys()].filter((table) => !CORE.includes(table)).concat(['messages', 'journeys', 'chats', 'contacts'].filter((table) => byTable.has(table)));
  let left = new Set(order);
  for (let pass = 0; pass < 15 && left.size; pass += 1) {
    for (const table of [...left]) {
      try {
        for (const ids of chunks(byTable.get(table))) count(table, ((await remove(ctx, table, 'id', ids)) || []).length);
        for (const ids of chunks(byTable.get(table))) await supabase(ctx.config.url, ctx.config.secretKey, `/rest/v1/_purge_teste?tbl=eq.${table}&id=in.(${ids.join(',')})`, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
        left.delete(table);
      } catch (error) { if (error.status !== 409) throw error; }
    }
  }
  return { deleted, left: [...left] };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  if (ctx.panel.role !== 'admin') return send(res, 403, { error: 'PURGE_ADMIN_ONLY' });
  try {
    if (req.method === 'GET') return send(res, 200, await summary(ctx));
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 4096).catch(() => ({}));
    if (body.action !== 'run' || body.confirm !== 'APAGAR TESTES') return send(res, 400, { error: 'PURGE_CONFIRM_REQUIRED' });
    const out = await run(ctx);
    return send(res, out.left.length ? 409 : 200, { ...out, after: await summary(ctx) });
  } catch (error) { return send(res, 500, { error: 'PURGE_FAILED', status: error.status || null }); }
};
module.exports.LEAVES = LEAVES;

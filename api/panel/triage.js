'use strict';

// Triagem da ENTRADA: o que está em REVISAR, o que saiu do funil comercial, a correção manual e o
// desfazer. Nunca chama a OpenAI: a leitura automática roda só no cron, desligada por padrão.
// GET ?estimate=1 conta o acervo e estima tokens e custo sem chamar ninguém.
const { allRows, isUuid, jsonBody, requirePanel, rows, send, supabase } = require('../../panel-server');
const triage = require('../../panel-triage');
const topicStore = require('../../panel-topic');
const { chatGroupIndex } = require('../../panel-chat-groups');

const snippet = (text) => triage.redact(text).slice(0, 160);
// Id lists go in small chunks so the query string never grows with the number of conversations.
async function byIds(ctx, table, select, ids) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += 100) chunks.push(ids.slice(index, index + 100));
  return (await Promise.all(chunks.map((chunk) => rows(ctx, table, { select, environment: 'eq.' + ctx.environment, id: 'in.(' + chunk.join(',') + ')' })))).flat();
}
const stampOf = (message) => Date.parse(message.occurred_at_utc || message.occurred_at_local || message.created_at || '') || 0;

async function conversation(ctx, chatId) {
  const env = 'eq.' + ctx.environment;
  const [messages, links] = await Promise.all([
    allRows(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: env, chat_id: 'eq.' + chatId, order: 'id.asc' }),
    allRows(ctx, 'message_journeys', { select: 'message_id,journey_id', environment: env, undone_at: 'is.null', order: 'message_id.asc' })
  ]);
  const evidence = triage.evidenceFor(messages);
  // The ficha of the most recent message (same rule as the automatic reading).
  const journeyOf = new Map(links.map((link) => [link.message_id, link.journey_id]));
  const journeyId = [...messages].sort((a, b) => stampOf(b) - stampOf(a)).map((message) => journeyOf.get(message.id)).find(Boolean) || null;
  const last = evidence.at(-1);
  return { evidence, journeyId, contentHash: triage.contentHash(evidence), lastMessageAt: last ? new Date(last.at).toISOString() : null };
}

// Fora da MCS candidates waiting for the operator: reason, original sentence and the ficha. Never acted on by the AI.
const OFF_MCS_TRIAGE = { PESSOAL: 'PESSOAL', VENDA_FORA_DO_SISTEMA: 'OUTRO_NEGOCIO', OUTRO_NEGOCIO: 'OUTRO_NEGOCIO' };
const OFF_MCS_LABELS = { PESSOAL: 'Assunto pessoal', VENDA_FORA_DO_SISTEMA: 'Venda fora do sistema', OUTRO_NEGOCIO: 'Outro negócio' };
async function offMcsCandidates(ctx) {
  const env = 'eq.' + ctx.environment;
  const found = await allRows(ctx, 'panel_conversation_class', { select: 'journey_id,offmcs_category,offmcs_reason,offmcs_quote,offmcs_message_id,classified_at', environment: env, offmcs_candidate: 'is.true', offmcs_review: 'is.null', order: 'journey_id.asc' });
  if (!found.length) return [];
  const journeys = await byIds(ctx, 'journeys', 'id,contact_id', found.map((row) => row.journey_id));
  const contacts = await byIds(ctx, 'contacts', 'id,display_name', [...new Set(journeys.map((row) => row.contact_id).filter(Boolean))]);
  const contactOf = new Map(journeys.map((row) => [row.id, row.contact_id])), nameOf = new Map(contacts.map((row) => [row.id, row.display_name]));
  return found.map((row) => ({ journeyId: row.journey_id, name: nameOf.get(contactOf.get(row.journey_id)) || 'Contato sem nome', category: row.offmcs_category, label: OFF_MCS_LABELS[row.offmcs_category] || 'Fora da MCS',
    reason: row.offmcs_reason || '', quote: row.offmcs_quote || '', messageId: row.offmcs_message_id || null, at: row.classified_at || null }));
}
async function reviewOffMcs(ctx, journeyId, review) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_offmcs_review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment, p_journey_id: journeyId, p_review: review, p_actor: ctx.panel.id }) });
}
// The individual conversations of a ficha (a group chat is never triaged).
async function chatsOfJourney(ctx, journeyId) {
  const links = await allRows(ctx, 'message_journeys', { select: 'message_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, undone_at: 'is.null', order: 'message_id.asc' });
  const messages = await byIds(ctx, 'messages', 'id,chat_id', links.map((row) => row.message_id));
  const chats = await byIds(ctx, 'chats', 'id,is_group', [...new Set(messages.map((row) => row.chat_id).filter(Boolean))]);
  return chats.filter((chat) => !chat.is_group).map((chat) => chat.id);
}

async function estimateBacklog(ctx) {
  const env = 'eq.' + ctx.environment;
  const [chats, messages, suggestions] = await Promise.all([
    allRows(ctx, 'chats', { select: 'id,contact_id,is_group', environment: env }),
    allRows(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: env, order: 'id.asc' }),
    allRows(ctx, 'whatsapp_link_suggestions', { select: 'source_chat_id', environment: env, status: 'eq.PENDING', suggestion_kind: 'eq.AI' })
  ]);
  const byChat = new Map();
  messages.forEach((message) => { if (!byChat.has(message.chat_id)) byChat.set(message.chat_id, []); byChat.get(message.chat_id).push(message); });
  const individual = chats.filter((chat) => !chat.is_group && (byChat.get(chat.id) || []).some((message) => message.direction === 'CUSTOMER' && !message.undone_at));
  // Same selection as the separate run: exactly the source chat of each pending AI suggestion.
  const pendingChatIds = new Set(suggestions.map((row) => row.source_chat_id).filter(Boolean));
  const all = individual.map((chat) => triage.evidenceFor(byChat.get(chat.id))).filter((evidence) => evidence.length);
  const needsYou = individual.filter((chat) => pendingChatIds.has(chat.id)).map((chat) => triage.evidenceFor(byChat.get(chat.id))).filter((evidence) => evidence.length);
  return Object.fromEntries(triage.APPROVED_MODELS.map((modelId) => [modelId, { todas: triage.estimate(all, modelId), precisaDeVoce: triage.estimate(needsYou, modelId) }]));
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') {
      if (String(req.query?.estimate || '') === '1') return send(res, 200, { ruleVersion: triage.RULE_VERSION, state: triage.status(), estimate: await estimateBacklog(ctx) });
      const [active, topic] = await Promise.all([triage.activeRows(ctx), topicStore.loadTopic(ctx).catch(() => null)]);
      // Adendo: a conversation that never discussed cars has its own group (fora do assunto) and
      // leaves "Precisa de você" and "Fora do funil" (one group per contact; nothing is deleted).
      const groupsByChat = await chatGroupIndex(ctx, { topic }).catch(() => new Map());
      const offTopicIds = new Set([...groupsByChat].filter(([, entry]) => entry.group && entry.group.key === 'FORA_DO_ASSUNTO').map(([chatId]) => chatId));
      const shown = active.filter((row) => row.decision !== 'FUNIL' && !offTopicIds.has(row.chat_id));
      const offTopicReadings = new Map((topic ? topic.offTopicChats() : []).map((entry) => [entry.chatId, entry]));
      const chatIds = [...new Set(shown.map((row) => row.chat_id).concat([...offTopicIds]))];
      const chats = await byIds(ctx, 'chats', 'id,contact_id', chatIds);
      const contactIds = [...new Set(chats.map((chat) => chat.contact_id).filter(Boolean))];
      const contacts = await byIds(ctx, 'contacts', 'id,display_name', contactIds);
      const evidenceIds = [...new Set(shown.flatMap((row) => row.evidence_message_ids || []))];
      const quotes = await byIds(ctx, 'messages', 'id,body_text', evidenceIds);
      const contactOf = new Map(chats.map((chat) => [chat.id, chat.contact_id]));
      const nameOf = new Map(contacts.map((contact) => [contact.id, contact.display_name]));
      const quoteOf = new Map(quotes.map((message) => [message.id, snippet(message.body_text)]));
      const items = shown.map((row) => ({
        id: row.id, chatId: row.chat_id, journeyId: row.journey_id, source: row.source, category: row.category, label: triage.LABELS[row.category], decision: row.decision,
        reason: row.reason, errorCode: row.error_code, model: row.model, createdAt: row.created_at, name: nameOf.get(contactOf.get(row.chat_id)) || 'Contato sem nome',
        evidence: (row.evidence_message_ids || []).map((id) => quoteOf.get(id)).filter(Boolean).slice(0, 3),
        group: groupsByChat.get(row.chat_id)?.group || null, lastCustomerMessage: groupsByChat.get(row.chat_id)?.lastCustomerMessage || null
      })).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const offTopic = [...offTopicIds].map((chatId) => { const reading = offTopicReadings.get(chatId) || {}; const entry = groupsByChat.get(chatId) || {};
        return { chatId, journeyId: entry.journeyId || reading.journeyId || null, name: nameOf.get(contactOf.get(chatId)) || 'Contato sem nome', source: reading.source || 'AI', reason: reading.reason || '', overrideId: reading.overrideId || null, group: entry.group || null, lastCustomerMessage: entry.lastCustomerMessage || null };
      }).sort((a, b) => Date.parse(b.lastCustomerMessage?.at || 0) - Date.parse(a.lastCustomerMessage?.at || 0));
      const offMcs = await offMcsCandidates(ctx).catch(() => null);
      return send(res, 200, {
        state: triage.status(), ruleVersion: triage.RULE_VERSION, labels: triage.LABELS, offMcs,
        review: items.filter((item) => item.decision === 'PENDENTE'), out: items.filter((item) => item.decision === 'FORA_DO_FUNIL'), offTopic
      });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 4096);
    if (body.action === 'set') {
      if (!isUuid(body.chatId)) return send(res, 400, { error: 'CHAT_ID_INVALID' });
      if (!triage.CATEGORIES.includes(body.category)) return send(res, 400, { error: 'TRIAGE_CATEGORY_INVALID' });
      const current = await conversation(ctx, body.chatId);
      const result = await triage.record(ctx, { chatId: body.chatId, journeyId: current.journeyId, source: 'MANUAL', category: body.category,
        reason: body.category === 'REVISAR' ? 'Mantido pendente pelo operador' : 'Decisão manual', evidence: current.evidence.map((item) => item.id).slice(-3),
        lastMessageAt: current.lastMessageAt, contentHash: current.contentHash, actorId: ctx.panel.id });
      return send(res, 200, { ...result, category: body.category, decision: triage.decisionOf(body.category) });
    }
    // Owner-authorized, separate run: only the conversations in "Precisa de você" (never the rest
    // of the backlog). Needs the triage switched on; admin only.
    if (body.action === 'run_pending') {
      if (ctx.panel.role !== 'admin') return send(res, 403, { error: 'TRIAGE_ADMIN_ONLY' });
      if (triage.status() !== 'LIGADA') return send(res, 200, { skipped: triage.status(), processed: 0 });
      return send(res, 200, await triage.runPending(ctx, { deadlineAt: Date.now() + 50000 }));
    }
    // Adendo: your correction of "fora do assunto" (per conversation, or every conversation of a
    // ficha). It is stored, wins over the AI and has "Desfazer". Nothing is deleted or sent.
    if (body.action === 'topic') {
      if (typeof body.aboutCar !== 'boolean') return send(res, 400, { error: 'TOPIC_VALUE_INVALID' });
      if (!isUuid(body.chatId) && !isUuid(body.journeyId)) return send(res, 400, { error: 'TOPIC_CHAT_REQUIRED' });
      return send(res, 200, await topicStore.correct(ctx, { chatId: isUuid(body.chatId) ? body.chatId : null, journeyId: isUuid(body.journeyId) ? body.journeyId : null, aboutCar: body.aboutCar }));
    }
    // Fora da MCS: only the operator takes a conversation out (every conversation of the ficha, through the triage); "É da MCS"
    // keeps it; "Desfazer" brings it back. Nothing is deleted or sent.
    if (['offmcs_confirm', 'offmcs_reject', 'offmcs_undo'].includes(body.action)) {
      if (!isUuid(body.journeyId)) return send(res, 400, { error: 'OFFMCS_JOURNEY_REQUIRED' });
      if (body.action === 'offmcs_reject') { await reviewOffMcs(ctx, body.journeyId, 'REJEITADO'); return send(res, 200, { journeyId: body.journeyId, review: 'REJEITADO' }); }
      if (body.action === 'offmcs_undo') {
        const ids = (Array.isArray(body.triageIds) ? body.triageIds : []).filter(isUuid).slice(0, 20);
        for (const id of ids) await triage.undo(ctx, id, ctx.panel.id);
        await reviewOffMcs(ctx, body.journeyId, null);
        return send(res, 200, { journeyId: body.journeyId, undone: ids.length });
      }
      const [entry] = await rows(ctx, 'panel_conversation_class', { select: 'journey_id,offmcs_candidate,offmcs_category,offmcs_reason', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + body.journeyId, limit: '1' });
      if (!entry || !entry.offmcs_candidate) return send(res, 409, { error: 'OFFMCS_NOT_A_CANDIDATE' });
      const chatIds = await chatsOfJourney(ctx, body.journeyId);
      if (!chatIds.length) return send(res, 409, { error: 'OFFMCS_NO_CONVERSATION' });
      const triageIds = [];
      for (const chatId of chatIds) {
        const current = await conversation(ctx, chatId);
        const result = await triage.record(ctx, { chatId, journeyId: body.journeyId, source: 'MANUAL', category: OFF_MCS_TRIAGE[entry.offmcs_category] || 'OUTRO_NEGOCIO',
          reason: 'Fora da MCS (confirmado): ' + String(entry.offmcs_reason || '').slice(0, 200), evidence: current.evidence.map((item) => item.id).slice(-3),
          lastMessageAt: current.lastMessageAt, contentHash: current.contentHash, actorId: ctx.panel.id });
        if (result && result.id) triageIds.push(result.id);
      }
      await reviewOffMcs(ctx, body.journeyId, 'CONFIRMADO');
      return send(res, 200, { journeyId: body.journeyId, review: 'CONFIRMADO', triageIds });
    }
    if (body.action === 'topic_undo') return send(res, 200, await topicStore.undoCorrection(ctx, body.ids));
    if (body.action === 'undo') {
      if (!isUuid(body.triageId)) return send(res, 400, { error: 'TRIAGE_ID_INVALID' });
      return send(res, 200, await triage.undo(ctx, body.triageId, ctx.panel.id));
    }
    return send(res, 400, { error: 'TRIAGE_ACTION_INVALID' });
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error?.code || '')) ? error.code : 'PANEL_TRIAGE_ERROR';
    return send(res, code === 'PANEL_TRIAGE_ERROR' ? 500 : 409, { error: code });
  }
};

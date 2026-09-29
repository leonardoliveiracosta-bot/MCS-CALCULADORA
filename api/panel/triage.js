'use strict';

// Triagem da ENTRADA: o que está em REVISAR, o que saiu do funil comercial, a correção manual e o
// desfazer. Nunca chama a OpenAI: a leitura automática roda só no cron, desligada por padrão.
// GET ?estimate=1 conta o acervo e estima tokens e custo sem chamar ninguém.
const { allRows, isUuid, jsonBody, requirePanel, rows, send } = require('../../panel-server');
const triage = require('../../panel-triage');

const snippet = (text) => triage.redact(text).slice(0, 160);

async function conversation(ctx, chatId) {
  const env = 'eq.' + ctx.environment;
  const [messages, links] = await Promise.all([
    allRows(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: env, chat_id: 'eq.' + chatId, order: 'id.asc' }),
    allRows(ctx, 'message_journeys', { select: 'message_id,journey_id', environment: env, undone_at: 'is.null', order: 'message_id.asc' })
  ]);
  const evidence = triage.evidenceFor(messages);
  const ids = new Set(messages.map((message) => message.id));
  const journeyId = links.filter((link) => ids.has(link.message_id)).map((link) => link.journey_id).at(-1) || null;
  const last = evidence.at(-1);
  return { evidence, journeyId, contentHash: triage.contentHash(evidence), lastMessageAt: last ? new Date(last.at).toISOString() : null };
}

async function estimateBacklog(ctx) {
  const env = 'eq.' + ctx.environment;
  const [chats, messages, suggestions] = await Promise.all([
    allRows(ctx, 'chats', { select: 'id,contact_id,is_group', environment: env }),
    allRows(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: env, order: 'id.asc' }),
    allRows(ctx, 'whatsapp_link_suggestions', { select: 'source_contact_id', environment: env, status: 'eq.PENDING' })
  ]);
  const byChat = new Map();
  messages.forEach((message) => { if (!byChat.has(message.chat_id)) byChat.set(message.chat_id, []); byChat.get(message.chat_id).push(message); });
  const individual = chats.filter((chat) => !chat.is_group && (byChat.get(chat.id) || []).some((message) => message.direction === 'CUSTOMER' && !message.undone_at));
  const pendingContacts = new Set(suggestions.map((row) => row.source_contact_id));
  const all = individual.map((chat) => triage.evidenceFor(byChat.get(chat.id))).filter((evidence) => evidence.length);
  const needsYou = individual.filter((chat) => pendingContacts.has(chat.contact_id)).map((chat) => triage.evidenceFor(byChat.get(chat.id))).filter((evidence) => evidence.length);
  return Object.fromEntries(triage.APPROVED_MODELS.map((modelId) => [modelId, { todas: triage.estimate(all, modelId), precisaDeVoce: triage.estimate(needsYou, modelId) }]));
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') {
      if (String(req.query?.estimate || '') === '1') return send(res, 200, { ruleVersion: triage.RULE_VERSION, state: triage.status(), estimate: await estimateBacklog(ctx) });
      const active = await triage.activeRows(ctx);
      const shown = active.filter((row) => row.decision !== 'FUNIL');
      const chatIds = [...new Set(shown.map((row) => row.chat_id))];
      const chats = chatIds.length ? await rows(ctx, 'chats', { select: 'id,contact_id', environment: 'eq.' + ctx.environment, id: 'in.(' + chatIds.join(',') + ')' }) : [];
      const contactIds = [...new Set(chats.map((chat) => chat.contact_id).filter(Boolean))];
      const contacts = contactIds.length ? await rows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment, id: 'in.(' + contactIds.join(',') + ')' }) : [];
      const evidenceIds = [...new Set(shown.flatMap((row) => row.evidence_message_ids || []))];
      const quotes = evidenceIds.length ? await rows(ctx, 'messages', { select: 'id,body_text', environment: 'eq.' + ctx.environment, id: 'in.(' + evidenceIds.slice(0, 200).join(',') + ')' }) : [];
      const contactOf = new Map(chats.map((chat) => [chat.id, chat.contact_id]));
      const nameOf = new Map(contacts.map((contact) => [contact.id, contact.display_name]));
      const quoteOf = new Map(quotes.map((message) => [message.id, snippet(message.body_text)]));
      const items = shown.map((row) => ({
        id: row.id, chatId: row.chat_id, journeyId: row.journey_id, source: row.source, category: row.category, label: triage.LABELS[row.category], decision: row.decision,
        reason: row.reason, errorCode: row.error_code, model: row.model, createdAt: row.created_at, name: nameOf.get(contactOf.get(row.chat_id)) || 'Contato sem nome',
        evidence: (row.evidence_message_ids || []).map((id) => quoteOf.get(id)).filter(Boolean).slice(0, 3)
      })).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      return send(res, 200, {
        state: triage.status(), ruleVersion: triage.RULE_VERSION, labels: triage.LABELS,
        review: items.filter((item) => item.decision === 'PENDENTE'), out: items.filter((item) => item.decision === 'FORA_DO_FUNIL')
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

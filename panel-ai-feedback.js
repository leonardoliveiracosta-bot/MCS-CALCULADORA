'use strict';

// Passive measurement of the existing sale suggestions. No messages, prompts or customer
// text are stored here, no external service is contacted and nothing can trigger a send.
const crypto = require('node:crypto');
const { allRows, insert, isUuid, rows } = require('./panel-server');
const EVENTS = new Set(['PICKED', 'SENT', 'OPENED_WHATSAPP', 'OPENED_SMS']);
const digest = (text) => crypto.createHash('sha256').update(String(text || '').trim()).digest('hex');

async function generated(ctx, { provider, journeyId, text, latencyMs, promptVersion }, services = {}) {
  const id = crypto.randomUUID();
  try {
    await (services.insert || insert)(ctx, 'audit_log', { environment: ctx.environment, actor_user_id: ctx.panel.id,
      entity_type: 'ai_sale_suggestion', entity_id: id, action: 'GENERATED', after_json: {
        provider, journeyId: isUuid(journeyId) ? journeyId : null, textHash: digest(text), originalLength: String(text || '').trim().length,
        latencyMs: Math.max(0, Math.round(latencyMs)), promptVersion
      } }, false);
    return id;
  } catch (_) { return null; } // the suggestion is still usable if measurement fails
}

async function feedback(ctx, body, services = {}) {
  if (!isUuid(body.suggestionId) || !EVENTS.has(body.event) || typeof body.text !== 'string' || body.text.length > 4000) return { error: 'AI_FEEDBACK_INVALID' };
  const [source] = await (services.rows || rows)(ctx, 'audit_log', { select: 'after_json', environment: 'eq.' + ctx.environment,
    actor_user_id: 'eq.' + ctx.panel.id, entity_type: 'eq.ai_sale_suggestion', entity_id: 'eq.' + body.suggestionId, action: 'eq.GENERATED', limit: '1' });
  if (!source) return { error: 'AI_SUGGESTION_NOT_FOUND' };
  const original = source.after_json || {}, text = body.text.trim();
  const editDistance = Number(body.editDistance);
  await (services.insert || insert)(ctx, 'audit_log', { environment: ctx.environment, actor_user_id: ctx.panel.id,
    entity_type: 'ai_sale_feedback', entity_id: body.suggestionId, action: body.event, after_json: {
      provider: original.provider, edited: digest(text) !== original.textHash, finalLength: text.length,
      originalLength: original.originalLength, editDistance: Number.isInteger(editDistance) && editDistance >= 0 && editDistance <= 4000 ? editDistance : null
    } }, false);
  return { ok: true };
}

async function metrics(ctx, services = {}) {
  const since = new Date(Date.now() - 30 * 86400000).toISOString();
  const data = await (services.allRows || allRows)(ctx, 'audit_log', { select: 'entity_type,entity_id,action,after_json', environment: 'eq.' + ctx.environment,
    entity_type: 'in.(ai_sale_suggestion,ai_sale_feedback)', created_at: 'gte.' + since, order: 'created_at.asc' });
  const result = ['OpenAI', 'Claude'].map((provider) => {
    const generatedRows = data.filter((row) => row.entity_type === 'ai_sale_suggestion' && row.after_json?.provider === provider);
    const ids = new Set(generatedRows.map((row) => row.entity_id));
    const feedbackRows = data.filter((row) => row.entity_type === 'ai_sale_feedback' && ids.has(row.entity_id));
    const unique = (actions) => new Set(feedbackRows.filter((row) => actions.includes(row.action)).map((row) => row.entity_id)).size;
    const chosen = new Map();
    for (const row of feedbackRows) if (['PICKED', 'SENT', 'OPENED_WHATSAPP', 'OPENED_SMS'].includes(row.action)) chosen.set(row.entity_id, row.after_json);
    const used = [...chosen.values()];
    return { provider, generated: generatedRows.length, chosen: unique(['PICKED']), sentByPanel: unique(['SENT']),
      openedWhatsApp: unique(['OPENED_WHATSAPP']), openedSms: unique(['OPENED_SMS']), edited: used.filter((row) => row.edited).length,
      meanLatencyMs: generatedRows.length ? Math.round(generatedRows.reduce((sum, row) => sum + Number(row.after_json?.latencyMs || 0), 0) / generatedRows.length) : null,
      meanEditDistance: used.some((row) => Number.isInteger(row.editDistance)) ? Math.round(used.filter((row) => Number.isInteger(row.editDistance)).reduce((sum, row) => sum + row.editDistance, 0) / used.filter((row) => Number.isInteger(row.editDistance)).length) : null };
  });
  return { periodDays: 30, since, providers: result, note: 'Abrir WhatsApp ou SMS não comprova envio. Escolha e edição medem uso da sugestão, não conversão em venda. Ainda não há comparação conclusiva quando a amostra é pequena.' };
}
module.exports = { generated, feedback, metrics };

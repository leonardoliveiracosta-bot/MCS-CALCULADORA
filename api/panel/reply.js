'use strict';

// Resposta pelo painel: o texto em português vira inglês pela IA, eu reviso e envio pelo 360dialog.
// O servidor decide o destino (nunca o navegador): o único chat WhatsApp individual do contato,
// com telefone atual. A janela de 24 h conta só mensagens do cliente e é conferida de novo no envio.
const crypto = require('node:crypto');
const { anthropicJson } = require('../../panel-ai');
const { undash } = require('../../text-dash');
const { insert, isUuid, jsonBody, patchRows, requirePanel, rows, send, supabase } = require('../../panel-server');

const MAX_TEXT = 4000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const PHONE = /^\+[1-9][0-9]{6,14}$/;
const sending = new Set();

async function resolveTarget(ctx, journeyId, services) {
  if (!isUuid(journeyId)) return null;
  const [journey] = await services.rows(ctx, 'journeys', { select: 'id,contact_id,reference_code', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' });
  if (!journey || !isUuid(journey.contact_id)) return null;
  const chats = await services.rows(ctx, 'chats', { select: 'id,contact_id,channel,is_group,canonical_key', environment: 'eq.' + ctx.environment, contact_id: 'eq.' + journey.contact_id, channel: 'eq.WHATSAPP' });
  // Without WhatsApp, the same composer hands the message to the phone's SMS app.
  // This target is read-only: it is never sent or recorded by 360dialog.
  if (!chats.length) {
    const phones = await services.rows(ctx, 'contact_phones', { select: 'phone_e164,is_primary', environment: 'eq.' + ctx.environment, contact_id: 'eq.' + journey.contact_id, is_current: 'is.true', retired_at: 'is.null' });
    const current = phones.filter((row) => PHONE.test(String(row.phone_e164 || '')));
    const phone = current.find((row) => row.is_primary)?.phone_e164 || (current.length === 1 ? current[0].phone_e164 : null);
    if (!phone) return null;
    const [contact] = await services.rows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id, limit: '1' });
    return { journey, phone, contactId: journey.contact_id, name: contact?.display_name || phone, channel: 'SMS' };
  }
  if (chats.length !== 1 || chats[0].is_group !== false) return null;
  const chat = chats[0];
  // o registro do envio cai no chat 'wa:<telefone>'; só aceito quando é este mesmo chat
  const phone = String(chat.canonical_key || '').replace(/^wa:/, '');
  if (!String(chat.canonical_key || '').startsWith('wa:') || !PHONE.test(phone)) return null;
  const holders = await services.rows(ctx, 'contact_phones', { select: 'contact_id', environment: 'eq.' + ctx.environment, phone_e164: 'eq.' + phone, is_current: 'is.true', retired_at: 'is.null' });
  const owners = new Set(holders.map((row) => row.contact_id));
  if (owners.size !== 1 || !owners.has(journey.contact_id)) return null;
  const [contact] = await services.rows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id, limit: '1' });
  return { journey, chat, phone, contactId: journey.contact_id, name: contact?.display_name || phone };
}

async function windowState(ctx, chatId, services, now = Date.now()) {
  const [last] = await services.rows(ctx, 'messages', { select: 'occurred_at_utc', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chatId, direction: 'eq.CUSTOMER', undone_at: 'is.null', occurred_at_utc: 'not.is.null', order: 'occurred_at_utc.desc', limit: '1' });
  const lastAt = Date.parse(last?.occurred_at_utc || '');
  if (!Number.isFinite(lastAt)) return { allowed: false };
  const openUntil = lastAt + WINDOW_MS;
  return { allowed: now < openUntil, openUntil: new Date(openUntil).toISOString(), lastCustomerAt: new Date(lastAt).toISOString() };
}

const TRANSLATE_SYSTEM = 'Você traduz mensagens da My Car Scout (serviço que compra carros em leilão nos EUA para o cliente; não é revendedora) para clientes. Responda SOMENTE JSON válido, sem texto fora do JSON: {"en":"...","pt_back":"..."}. ' +
  '"en": tradução fiel do texto em português para inglês americano natural e informal, como uma mensagem de WhatsApp; não acrescente nem remova informação; não use travessão (em-dash). ' +
  '"pt_back": tradução de volta do "en" para o português, para conferência.';

async function translate(text, services, ctx = null) {
  const source = String(text || '').trim();
  if (!source) return { status: 400, error: 'TEXT_REQUIRED' };
  if (source.length > MAX_TEXT) return { status: 400, error: 'TEXT_TOO_LONG' };
  let result;
  try { result = await services.anthropicJson(TRANSLATE_SYSTEM, source, fetch, ctx ? { ctx, feature: 'TRADUCAO_RESPOSTA', subject: 'resposta' } : null); } catch (error) { return error && error.code === 'AI_BALANCE_LIMIT' ? { status: 402, error: 'AI_BALANCE_LIMIT' } : { status: 502, error: 'AI_UNAVAILABLE' }; }
  const en = typeof result?.en === 'string' ? undash(result.en).trim() : '';
  const ptBack = typeof result?.pt_back === 'string' ? result.pt_back.trim() : '';
  if (!en || !ptBack || en.length > MAX_TEXT) return { status: 502, error: 'AI_UNAVAILABLE' };
  return { status: 200, en, pt_back: ptBack };
}

async function d360Send(phone, text, fetchImpl = fetch) {
  // Última trava: fora de produção a chamada real nunca sai, mesmo que alguém chame esta função.
  if (process.env.VERCEL_ENV !== 'production' && fetchImpl === fetch) return { error: 'D360_BLOCKED_OUTSIDE_PRODUCTION' };
  const key = process.env.D360_API_KEY;
  if (!key) return { error: 'D360_KEY_MISSING' };
  let response;
  try {
    response = await fetchImpl('https://waba-v2.360dialog.io/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'D360-API-KEY': key },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone.replace(/^\+/, ''), type: 'text', text: { body: text } }) });
  } catch (_) { return { error: 'D360_NETWORK_ERROR' }; }
  if (!response.ok) return { error: 'D360_HTTP_' + response.status };
  const payload = await response.json().catch(() => null);
  const messageId = payload?.messages?.[0]?.id;
  return typeof messageId === 'string' && messageId.length >= 2 ? { messageId } : { error: 'D360_RESPONSE_INVALID' };
}

async function recordSent(ctx, target, text, messageId, services, now = Date.now()) {
  const [raw] = await services.insert(ctx, 'whatsapp_raw_events', { environment: ctx.environment, event_key: 'panel-send:' + crypto.randomUUID(), event_type: 'PANEL_SEND', payload_json: {}, status: 'DONE' });
  return services.applyMessage(ctx, raw.id, { messageId, phone: target.phone, name: target.name, forceContactId: target.contactId,
    direction: 'MCS', body: text, timestamp: String(Math.floor(now / 1000)), refs: target.journey.reference_code ? [target.journey.reference_code] : [], source_kind: 'PANEL' });
}

async function applyMessage(ctx, rawId, item) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_whatsapp_apply_message', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_environment: ctx.environment, p_raw: rawId, p_item: item }) });
}

// SMS goes out from the phone (the panel only opens the message ready): the tap on "Enviar por SMS" is recorded in the
// conversation as a message from MCS, so the panel knows the client was answered. Desfazer removes it (the SMS was not sent).
const normalizedBody = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
const SMS_UNDO_MS = 30 * 60 * 1000;

// The client's current phone (the primary one, or the only one), whatever channel the conversation started on.
async function smsTarget(ctx, journeyId, services) {
  if (!isUuid(journeyId)) return null;
  const [journey] = await services.rows(ctx, 'journeys', { select: 'id,contact_id,stage,status', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' });
  if (!journey || !isUuid(journey.contact_id)) return null;
  const phones = await services.rows(ctx, 'contact_phones', { select: 'phone_e164,is_primary', environment: 'eq.' + ctx.environment, contact_id: 'eq.' + journey.contact_id, is_current: 'is.true', retired_at: 'is.null' });
  const current = phones.filter((row) => PHONE.test(String(row.phone_e164 || '')));
  const phone = current.find((row) => row.is_primary)?.phone_e164 || (current.length === 1 ? current[0].phone_e164 : null);
  return phone ? { journey, phone, contactId: journey.contact_id } : null;
}

async function recordSms(ctx, body, services, now = Date.now()) {
  const text = String(body?.text || '').trim();
  if (!text) return { status: 400, error: 'TEXT_REQUIRED' };
  if (text.length > MAX_TEXT) return { status: 400, error: 'TEXT_TOO_LONG' };
  const target = await smsTarget(ctx, String(body?.journeyId || ''), services);
  if (!target) return { status: 400, error: 'REPLY_NOT_ELIGIBLE' };
  // Outside production nothing is written (the same rule as the WhatsApp send).
  if (services.patchRows === patchRows && process.env.VERCEL_ENV !== 'production') return { status: 200, recorded: false, simulated: true };
  const key = 'sms:' + target.phone, nowIso = new Date(now).toISOString(), norm = normalizedBody(text);
  const findChat = async () => (await services.rows(ctx, 'chats', { select: 'id,contact_id', environment: 'eq.' + ctx.environment, canonical_key: 'eq.' + key, limit: '1' }))[0] || null;
  let chat = await findChat();
  // The number already belongs to another contact's SMS conversation: never mixed.
  if (chat && chat.contact_id && chat.contact_id !== target.contactId) return { status: 409, error: 'SMS_CHAT_OTHER_CONTACT' };
  if (chat) {
    // A second tap on the same text in the same minutes is the same SMS.
    const same = await services.rows(ctx, 'messages', { select: 'id', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chat.id, direction: 'eq.MCS', undone_at: 'is.null', body_normalized: 'eq.' + norm, occurred_at_utc: 'gte.' + new Date(now - 5 * 60 * 1000).toISOString(), limit: '1' });
    if (same.length) return { status: 200, recorded: true, duplicate: true, messageId: same[0].id };
  } else {
    try {
      [chat] = await services.insert(ctx, 'chats', { environment: ctx.environment, channel: 'SMS', contact_id: target.contactId, canonical_key: key, resolution_status: 'RESOLVED', is_group: false, first_seen_at: nowIso, last_seen_at: nowIso, created_at: nowIso, updated_at: nowIso });
    } catch (_) {
      chat = await findChat();
      if (!chat || (chat.contact_id && chat.contact_id !== target.contactId)) return { status: 409, error: 'SMS_CHAT_OTHER_CONTACT' };
    }
  }
  const [message] = await services.insert(ctx, 'messages', { environment: ctx.environment, chat_id: chat.id, channel: 'SMS', direction: 'MCS', body_text: text, body_normalized: norm,
    occurred_at_utc: nowIso, time_uncertain: false, signature_base: 'PANEL_SMS:' + crypto.randomUUID(), occurrence_index: 1, source_kind: 'PANEL_SMS', created_at: nowIso });
  const journey = target.journey;
  await services.insert(ctx, 'message_journeys', { environment: ctx.environment, message_id: message.id, journey_id: journey.id, association_source: 'PANEL_SMS', associated_at: nowIso }, false);
  await services.insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, message_id: message.id, type: 'OUTBOUND_MESSAGE', occurred_at: nowIso, created_at: nowIso }, false);
  // The same as a message sent by WhatsApp: the client was answered (Novo becomes Respondido).
  if (journey.status !== 'ENCERRADO') await services.patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { ...(journey.stage === 'NOVO' ? { stage: 'RESPONDIDO' } : {}), last_effective_contact_at: nowIso, updated_at: nowIso });
  await services.patchRows(ctx, 'chats', { environment: 'eq.' + ctx.environment, id: 'eq.' + chat.id }, { last_seen_at: nowIso, updated_at: nowIso });
  return { status: 201, recorded: true, messageId: message.id };
}

// Desfazer: only an SMS recorded by the panel, of this ficha, in the last 30 minutes.
async function undoSms(ctx, body, services, now = Date.now()) {
  const messageId = String(body?.messageId || ''), journeyId = String(body?.journeyId || '');
  if (!isUuid(messageId) || !isUuid(journeyId)) return { status: 400, error: 'MESSAGE_ID_INVALID' };
  const [message] = await services.rows(ctx, 'messages', { select: 'id,source_kind,created_at,undone_at', environment: 'eq.' + ctx.environment, id: 'eq.' + messageId, limit: '1' });
  const [link] = message ? await services.rows(ctx, 'message_journeys', { select: 'message_id', environment: 'eq.' + ctx.environment, message_id: 'eq.' + messageId, journey_id: 'eq.' + journeyId, limit: '1' }) : [];
  if (!message || !link || message.source_kind !== 'PANEL_SMS') return { status: 404, error: 'MESSAGE_NOT_FOUND' };
  if (message.undone_at) return { status: 200, undone: true };
  if (now - Date.parse(message.created_at) > SMS_UNDO_MS) return { status: 409, error: 'UNDO_EXPIRED' };
  const at = new Date(now).toISOString();
  await services.patchRows(ctx, 'messages', { environment: 'eq.' + ctx.environment, id: 'eq.' + messageId }, { undone_at: at });
  await services.patchRows(ctx, 'message_journeys', { environment: 'eq.' + ctx.environment, message_id: 'eq.' + messageId }, { undone_at: at });
  return { status: 200, undone: true };
}

const defaultServices = { rows, insert, patchRows, applyMessage, anthropicJson, d360Send };

async function handle(ctx, body, services = defaultServices, now = Date.now()) {
  const action = String(body?.action || '');
  if (action === 'translate') return translate(body.text, services, ctx);
  if (action === 'sms_sent') return recordSms(ctx, body, services, now);
  if (action === 'sms_undo') return undoSms(ctx, body, services, now);
  if (action !== 'window' && action !== 'send') return { status: 400, error: 'ACTION_INVALID' };
  const journeyId = String(body?.journeyId || '');
  if (action === 'send') {
    const text = String(body?.textEn || '').trim();
    if (!text) return { status: 400, error: 'TEXT_REQUIRED' };
    if (text.length > MAX_TEXT) return { status: 400, error: 'TEXT_TOO_LONG' };
    if (sending.has(journeyId)) return { status: 409, error: 'SEND_IN_PROGRESS' };
    sending.add(journeyId);
    try {
      const target = await resolveTarget(ctx, journeyId, services);
      if (!target || target.channel === 'SMS') return { status: 400, error: 'REPLY_NOT_ELIGIBLE' };
      const state = await windowState(ctx, target.chat.id, services, now);
      if (!state.allowed) return { status: 400, error: 'WINDOW_CLOSED' };
      // Fora de produção (Preview, desenvolvimento, teste) o 360dialog real nunca é chamado: o envio
      // é simulado e nenhuma mensagem é gravada na conversa (o Preview usa o banco de produção).
      if (services.d360Send === d360Send && process.env.VERCEL_ENV !== 'production') return { status: 200, ok: true, simulated: true, messageId: 'simulated-' + crypto.randomUUID() };
      const sent = await services.d360Send(target.phone, text);
      if (sent.error) return { status: 502, error: sent.error };
      // já saiu para o cliente: se o registro falhar, digo isso para não reenviar às cegas
      try { await recordSent(ctx, target, text, sent.messageId, services, now); } catch (_) { return { status: 500, error: 'SENT_NOT_RECORDED', messageId: sent.messageId }; }
      return { status: 200, ok: true, messageId: sent.messageId };
    } finally { sending.delete(journeyId); }
  }
  const target = await resolveTarget(ctx, journeyId, services);
  if (!target) return { status: 400, error: 'REPLY_NOT_ELIGIBLE' };
  if (target.channel === 'SMS') return { status: 200, channel: 'SMS', allowed: false, name: target.name, phone: target.phone };
  const state = await windowState(ctx, target.chat.id, services, now);
  // The destination too, so the composer shows "Para NOME · FONE" and the phone path when the window is closed.
  const who = { name: target.name, phone: target.phone, whatsappBase: 'https://wa.me/' + target.phone.replace(/^\+/, '') };
  return state.openUntil ? { status: 200, allowed: state.allowed, openUntil: state.openUntil, ...who } : { status: 200, allowed: false, ...who };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const { status, ...out } = await handle(ctx, await jsonBody(req));
    return send(res, status, out);
  } catch (_) {
    return send(res, 500, { error: 'REPLY_UNAVAILABLE' });
  }
};
module.exports.handle = handle;
module.exports.resolveTarget = resolveTarget;
module.exports.windowState = windowState;
module.exports.translate = translate;
module.exports.MAX_TEXT = MAX_TEXT;
module.exports.d360Send = d360Send;
module.exports.recordSent = recordSent;
module.exports.applyMessage = applyMessage;
module.exports.recordSms = recordSms;
module.exports.undoSms = undoSms;

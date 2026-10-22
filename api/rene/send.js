'use strict';

// Respostas do agente RENE (n8n do Rene), autorizadas pelo Leo: o mesmo envio do painel (d360Send) e o mesmo
// registro na conversa, marcado como RENE. Quando não deve enviar, responde 200 com { skipped: motivo } e não grava nada.
// Só responde à mensagem do cliente que chegou nas últimas 24 h, nunca depois de uma pessoa ter respondido,
// nunca a quem pediu para parar, uma vez por mensagem e no máximo 3 vezes por contato em 24 h.
const crypto = require('node:crypto');
const { SERVER_ENVIRONMENT, configuration, insert, isUuid, jsonBody, patchRows, rows, send } = require('../../panel-server');
const { normalizePhone } = require('../../panel-phone');
const { optOutOf } = require('../../panel-opt-out');
const reply = require('../panel/reply');

const MAX_TEXT = 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PER_DAY = 3;
const SOURCE = 'RENE';
// O pedido de envio fica em whatsapp_raw_events (chave única por mensagem do cliente): é a trava contra repetir.
// status DONE para a manutenção nunca pegar; o estado do envio vai em error_code.
const SENDING = 'RENE_SENDING', FAILED = 'RENE_SEND_FAILED', UNCERTAIN = 'RENE_SEND_UNCERTAIN', LIMITED = 'RENE_RATE_LIMIT';
const RETRYABLE = new Set([FAILED, LIMITED]);
const skip = (reason) => ({ status: 200, skipped: reason });
const claimKey = (phone, waId) => 'rene-send:' + phone + ':' + waId;

function authorized(req) {
  const expected = String(process.env.RENE_FORWARD_SECRET || '').trim();
  const supplied = req.headers && req.headers['x-mcs-secret'];
  if (!expected || typeof supplied !== 'string' || Buffer.byteLength(supplied) > 256) return false;
  const digest = (value) => crypto.createHash('sha256').update(value).digest();
  return crypto.timingSafeEqual(digest(supplied), digest(expected));
}

// A mensagem do cliente (pelo id do WhatsApp) e o chat dela, que precisa ser o chat individual deste número
// e de um único contato (a mesma regra do painel para escolher o destino).
async function inboundOf(ctx, phone, waId, services, now) {
  if (!phone || !waId || waId.length > 256) return null;
  const env = 'eq.' + ctx.environment;
  const [link] = await services.rows(ctx, 'whatsapp_message_ids', { select: 'message_id', environment: env, wa_message_id: 'eq.' + waId, limit: '1' });
  if (!link || !isUuid(link.message_id)) return null;
  const [message] = await services.rows(ctx, 'messages', { select: 'id,chat_id,direction,occurred_at_utc,undone_at', environment: env, id: 'eq.' + link.message_id, limit: '1' });
  const at = Date.parse(message?.occurred_at_utc || '');
  if (!message || message.direction !== 'CUSTOMER' || message.undone_at || !Number.isFinite(at) || now - at > WINDOW_MS || at - now > 5 * 60 * 1000) return null;
  const [chat] = await services.rows(ctx, 'chats', { select: 'id,contact_id,channel,is_group,canonical_key', environment: env, id: 'eq.' + message.chat_id, limit: '1' });
  if (!chat || chat.channel !== 'WHATSAPP' || chat.is_group !== false || chat.canonical_key !== 'wa:' + phone || !isUuid(chat.contact_id)) return null;
  const holders = await services.rows(ctx, 'contact_phones', { select: 'contact_id', environment: env, phone_e164: 'eq.' + phone, is_current: 'is.true', retired_at: 'is.null' });
  const owners = new Set(holders.map((row) => row.contact_id));
  if (owners.size > 1 || (owners.size === 1 && !owners.has(chat.contact_id))) return null;
  const [journeyLink] = await services.rows(ctx, 'message_journeys', { select: 'journey_id', environment: env, message_id: 'eq.' + message.id, undone_at: 'is.null', limit: '1' });
  const [journey] = journeyLink ? await services.rows(ctx, 'journeys', { select: 'id,reference_code', environment: env, id: 'eq.' + journeyLink.journey_id, limit: '1' }) : [];
  return { message, at, chat, contactId: chat.contact_id, journey: journey || null };
}

// Todas as mensagens das conversas deste contato (WhatsApp e SMS), para o pedido de parar e a resposta de uma pessoa.
async function contactMessages(ctx, contactId, services) {
  const env = 'eq.' + ctx.environment;
  const chats = await services.rows(ctx, 'chats', { select: 'id', environment: env, contact_id: 'eq.' + contactId });
  if (!chats.length) return [];
  return services.rows(ctx, 'messages', { select: 'id,direction,body_text,occurred_at_utc,created_at,undone_at,is_automatic,source_kind', environment: env, chat_id: 'in.(' + chats.map((chat) => chat.id).join(',') + ')' });
}

// Envios do RENE para este número nas últimas 24 h (os que falharam antes de sair não contam).
async function sentToday(ctx, phone, services, now) {
  const claims = await services.rows(ctx, 'whatsapp_raw_events', { select: 'event_key,error_code,received_at', environment: 'eq.' + ctx.environment, event_key: 'like.' + claimKey(phone, '*') });
  return claims.filter((row) => !RETRYABLE.has(row.error_code) && now - Date.parse(row.received_at) < WINDOW_MS);
}

const setClaim = (ctx, id, fields, services) => services.patchRows(ctx, 'whatsapp_raw_events', { environment: 'eq.' + ctx.environment, id: 'eq.' + id }, fields);

async function claim(ctx, key, existing, services, now) {
  const at = new Date(now).toISOString();
  if (existing) {
    const [row] = await services.patchRows(ctx, 'whatsapp_raw_events', { environment: 'eq.' + ctx.environment, id: 'eq.' + existing.id, error_code: 'eq.' + existing.error_code }, { error_code: SENDING, received_at: at }, true) || [];
    return row || null;
  }
  try {
    const [row] = await services.insert(ctx, 'whatsapp_raw_events', { environment: ctx.environment, event_key: key, event_type: 'RENE_SEND', payload_json: {}, status: 'DONE', error_code: SENDING, received_at: at });
    return row || null;
  } catch (error) {
    if (error && error.status === 409) return null;
    throw error;
  }
}

const defaultServices = { rows, insert, patchRows, applyMessage: reply.applyMessage, d360Send: reply.d360Send };

async function handle(ctx, body, services = defaultServices, now = Date.now()) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TEXT) return skip('TEXT_INVALID');
  const phone = normalizePhone(body?.to);
  const waId = typeof body?.in_reply_to === 'string' ? body.in_reply_to.trim() : '';
  const inbound = await inboundOf(ctx, phone, waId, services, now);
  if (!inbound) return skip('NOT_RECENT_CUSTOMER_MESSAGE');
  const messages = await contactMessages(ctx, inbound.contactId, services);
  if (optOutOf(messages)) return skip('OPTED_OUT');
  // Uma pessoa respondeu depois: pelo painel (WhatsApp, V1, SMS) ou pelo celular. O bot (automáticas) e o próprio RENE não contam.
  const human = messages.some((message) => message.direction === 'MCS' && !message.undone_at && !message.is_automatic && message.source_kind !== SOURCE
    && Date.parse(message.occurred_at_utc || message.created_at || '') > inbound.at);
  if (human) return skip('HUMAN_REPLIED');
  const key = claimKey(phone, waId);
  const [existing] = await services.rows(ctx, 'whatsapp_raw_events', { select: 'id,error_code', environment: 'eq.' + ctx.environment, event_key: 'eq.' + key, limit: '1' });
  if (existing && !RETRYABLE.has(existing.error_code)) return skip('ALREADY_REPLIED');
  if ((await sentToday(ctx, phone, services, now)).filter((row) => row.event_key !== key).length >= MAX_PER_DAY) return skip('RATE_LIMIT');
  // Fora de produção (Preview usa o banco de produção) nada sai e nada é gravado, como no painel.
  if (services.d360Send === reply.d360Send && process.env.VERCEL_ENV !== 'production') return { status: 200, ok: true, simulated: true, messageId: 'simulated-' + crypto.randomUUID() };
  const row = await claim(ctx, key, existing, services, now);
  if (!row) return skip('ALREADY_REPLIED');
  // Dois pedidos ao mesmo tempo para mensagens diferentes: quem passar do limite desiste.
  if ((await sentToday(ctx, phone, services, now)).length > MAX_PER_DAY) { await setClaim(ctx, row.id, { error_code: LIMITED }, services); return skip('RATE_LIMIT'); }
  const sent = await services.d360Send(phone, text);
  if (sent.error) {
    // Recusado pelo 360dialog: pode tentar de novo. Sem resposta clara: talvez tenha saído, então não repete.
    await setClaim(ctx, row.id, { error_code: /^D360_(HTTP_|KEY_MISSING)/.test(sent.error) ? FAILED : UNCERTAIN }, services).catch(() => null);
    return { status: 502, error: sent.error };
  }
  await setClaim(ctx, row.id, { error_code: null, payload_json: { messageId: sent.messageId } }, services).catch(() => null);
  try {
    await services.applyMessage(ctx, row.id, { messageId: sent.messageId, phone, forceContactId: inbound.contactId, direction: 'MCS', body: text,
      timestamp: String(Math.floor(now / 1000)), refs: inbound.journey?.reference_code ? [inbound.journey.reference_code] : [], source_kind: SOURCE });
  } catch (_) { return { status: 500, error: 'SENT_NOT_RECORDED', messageId: sent.messageId }; }
  return { status: 200, ok: true, messageId: sent.messageId };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED' });
  const config = configuration();
  if (!config || !SERVER_ENVIRONMENT) return send(res, 503, { error: 'RENE_SEND_UNAVAILABLE' });
  try {
    const { status, ...out } = await handle({ config, environment: SERVER_ENVIRONMENT }, await jsonBody(req, 64 * 1024));
    return send(res, status, out);
  } catch (_) {
    return send(res, 500, { error: 'RENE_SEND_UNAVAILABLE' });
  }
};
module.exports.handle = handle;
module.exports.MAX_TEXT = MAX_TEXT;
module.exports.MAX_PER_DAY = MAX_PER_DAY;

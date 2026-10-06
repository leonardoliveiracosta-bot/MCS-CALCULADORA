'use strict';

// SMS recebido no iPhone e repassado por uma automação do app Atalhos.
// Portão de privacidade: só guarda quando o remetente é, sem ambiguidade, um contato conhecido
// (telefone, nome exato ou Ref no texto). O resto é descartado sem gravar e sem registrar o texto.
// Com o segredo certo a resposta é sempre 200: o endpoint nunca revela se um número é cliente.
const crypto = require('node:crypto');
const { waitUntil } = require('@vercel/functions');
const { SERVER_ENVIRONMENT, allRows, configuration, insert, jsonBody, patchRows, rows, send } = require('../../panel-server');
const { normalizePhone } = require('../../panel-phone');
const { calcRefOfJourney, notificationTitle, sendPanelPush } = require('../../panel-push');
const calcMessage = require('../../panel-calc-message');
const calcRoute = require('../../panel-calc-route');

// Long messages are kept (the calculator model never comes near this); only absurd payloads are refused.
const MAX_TEXT = 25000;
const REF = /\b[A-HJ-NP-Z2-9]{5}\b/g;
const MIN_DATE = Date.parse('2009-01-01T00:00:00Z');

function secretMatches(supplied, expected) {
  if (!expected || typeof supplied !== 'string' || !supplied) return false;
  const given = Buffer.from(supplied), wanted = Buffer.from(expected);
  // timingSafeEqual lança erro com tamanhos diferentes: tamanho diferente já é 401
  if (given.length !== wanted.length) return false;
  return crypto.timingSafeEqual(given, wanted);
}

async function deviceTokenMatches(ctx, supplied, services) {
  if (!ctx || typeof supplied !== 'string' || !supplied) return false;
  const suppliedHash = crypto.createHash('sha256').update(supplied, 'utf8').digest();
  let tokens;
  try {
    tokens = await services.rows(ctx, 'sms_device_tokens', {
      select: 'token_hash', environment: 'eq.' + ctx.environment, revoked_at: 'is.null'
    });
  } catch (_) {
    return false;
  }
  let matched = false;
  for (const token of tokens || []) {
    if (!/^[0-9a-f]{64}$/.test(String(token?.token_hash || ''))) continue;
    const storedHash = Buffer.from(token.token_hash, 'hex');
    matched = crypto.timingSafeEqual(suppliedHash, storedHash) || matched;
  }
  return matched;
}

const plainName = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const normalizedBody = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();

function messageDate(value, now = Date.now()) {
  const stamp = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value.trim()) ? Date.parse(value.trim()) : NaN;
  return Number.isFinite(stamp) && stamp >= MIN_DATE && stamp <= now + 86400000 ? stamp : now;
}

async function contactByPhone(ctx, phone, services) {
  const found = await services.rows(ctx, 'contact_phones', { select: 'contact_id', environment: 'eq.' + ctx.environment, phone_e164: 'eq.' + phone, is_current: 'is.true', retired_at: 'is.null' });
  const ids = [...new Set(found.map((row) => row.contact_id))];
  return ids.length === 1 ? ids[0] : null;
}

async function contactByName(ctx, name, services) {
  const wanted = plainName(name);
  if (!wanted) return null;
  const contacts = await services.allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment });
  const matches = contacts.filter((contact) => plainName(contact.display_name) === wanted);
  return matches.length === 1 ? matches[0].id : null;
}

async function journeyByRef(ctx, text, services) {
  const tokens = [...new Set(String(text || '').match(REF) || [])].slice(0, 20);
  for (const ref of tokens) {
    const [journey] = await services.rows(ctx, 'journeys', { select: 'id,contact_id,reference_code,vehicle_text,status,created_at', environment: 'eq.' + ctx.environment, reference_code: 'eq.' + ref, limit: '1' });
    if (journey) return journey;
    const [link] = await services.rows(ctx, 'journey_refs', { select: 'journey_id', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref, limit: '1' });
    if (link) {
      const [linked] = await services.rows(ctx, 'journeys', { select: 'id,contact_id,reference_code,vehicle_text,status,created_at', environment: 'eq.' + ctx.environment, id: 'eq.' + link.journey_id, limit: '1' });
      if (linked) return linked;
    }
  }
  return null;
}

async function latestJourney(ctx, contactId, services) {
  const list = await services.rows(ctx, 'journeys', { select: 'id,contact_id,reference_code,vehicle_text,status,created_at', environment: 'eq.' + ctx.environment, contact_id: 'eq.' + contactId, order: 'created_at.desc' });
  return list.find((journey) => journey.status !== 'ENCERRADO') || list[0] || null;
}

async function findChat(ctx, key, services) {
  const [chat] = await services.rows(ctx, 'chats', { select: 'id,contact_id', environment: 'eq.' + ctx.environment, channel: 'eq.SMS', canonical_key: 'eq.' + key, limit: '1' });
  return chat || null;
}

// The iPhone Shortcut may name the fields its own way: the usual names are accepted.
const pick = (body, names) => { for (const name of names) { const value = body && body[name]; if (typeof value === 'string' && value.trim()) return value; if (typeof value === 'number') return String(value); } return ''; };
const TEXT_FIELDS = ['text', 'message', 'body', 'content', 'texto', 'mensagem'];
const SENDER_FIELDS = ['sender', 'from', 'phone', 'number', 'remetente', 'telefone'];
const NAME_FIELDS = ['senderName', 'name', 'contact', 'nome', 'contato'];
// Format problems only (never a privacy-gate discard): the field NAMES, never a value.
const formatWarning = (what, body) => console.warn('[sms-inbound] formato ' + what, { campos: Object.keys(body && typeof body === 'object' ? body : {}).slice(0, 12) });

async function receive(ctx, body, services, now = Date.now()) {
  const text = pick(body, TEXT_FIELDS).trim();
  if (!text) { formatWarning('sem texto', body); return { stored: false }; }
  if (text.length > MAX_TEXT) return { stored: false };
  const phone = normalizePhone(pick(body, SENDER_FIELDS));
  const senderName = pick(body, NAME_FIELDS).slice(0, 160);
  if (!phone && !senderName.trim()) { formatWarning('sem remetente', body); return { stored: false }; }

  // 1. portão de privacidade, nesta ordem
  let contactId = null, journey = null;
  if (phone) contactId = await contactByPhone(ctx, phone, services);
  else if (senderName.trim()) {
    // (b) sem telefone: o nome precisa bater com exatamente um contato; 0 ou 2+ descarta
    contactId = await contactByName(ctx, senderName, services);
    if (!contactId) return { stored: false };
  }
  const refJourney = await journeyByRef(ctx, text, services);
  if (!contactId && refJourney) contactId = refJourney.contact_id;
  // A message in the calculator model is a lead by itself: from a new phone it is kept (new contact) and routed like every other
  // calculator message (Ref -> phone -> new ficha -> queue). Anything else from an unknown sender is still dropped (privacy gate).
  const calculator = calcMessage.isCalculator(text);
  let newContact = false;
  if (!contactId && calculator && phone) {
    const [contact] = await services.insert(ctx, 'contacts', { environment: ctx.environment, display_name: (calcMessage.parse(text).name || senderName || phone).slice(0, 160), source: 'SMS_DIRECT', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
    await services.insert(ctx, 'contact_phones', { environment: ctx.environment, contact_id: contact.id, phone_raw: phone, phone_e164: phone, is_current: true, is_primary: true, created_at: new Date(now).toISOString() }, false);
    contactId = contact.id; newContact = true;
  }
  if (!contactId) return { stored: false };
  // Calculator messages are not attached to "the latest ficha": the router decides (one ficha and no contradiction, or the queue).
  journey = refJourney && refJourney.contact_id === contactId ? refJourney : calculator ? null : await latestJourney(ctx, contactId, services);
  if (!journey && !calculator) return { stored: false };

  // 2. chat SMS do remetente; se o número já é de outro contato, não mistura
  const key = phone ? 'sms:' + phone : 'sms:name:' + contactId;
  let chat = await findChat(ctx, key, services);
  if (chat && chat.contact_id && chat.contact_id !== contactId) return { stored: false };

  // 3. duplicado: mesmo chat, mesmo texto, mesmo minuto
  const at = messageDate(body?.date, now), norm = normalizedBody(text);
  if (chat) {
    const minute = Math.floor(at / 60000) * 60000;
    const same = await services.rows(ctx, 'messages', { select: 'id', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chat.id, body_normalized: 'eq.' + norm, and: `(occurred_at_utc.gte.${new Date(minute).toISOString()},occurred_at_utc.lt.${new Date(minute + 60000).toISOString()})`, limit: '1' });
    if (same.length) return { stored: false, duplicate: true };
  }

  // 4. grava
  const stamp = new Date(at).toISOString(), nowIso = new Date(now).toISOString();
  if (!chat) {
    try {
      [chat] = await services.insert(ctx, 'chats', { environment: ctx.environment, channel: 'SMS', contact_id: contactId, canonical_key: key, resolution_status: 'RESOLVED', is_group: false, first_seen_at: stamp, last_seen_at: nowIso, created_at: nowIso, updated_at: nowIso });
    } catch (_) {
      chat = await findChat(ctx, key, services); // criado ao mesmo tempo por outra chamada
      if (!chat || (chat.contact_id && chat.contact_id !== contactId)) return { stored: false };
    }
  }
  const [message] = await services.insert(ctx, 'messages', { environment: ctx.environment, chat_id: chat.id, channel: 'SMS', direction: 'CUSTOMER', body_text: text, body_normalized: norm,
    occurred_at_utc: stamp, time_uncertain: true, signature_base: 'SMS_SHORTCUT:' + crypto.randomUUID(), occurrence_index: 1, source_kind: 'SMS_SHORTCUT', created_at: nowIso });
  if (journey) {
    await services.insert(ctx, 'message_journeys', { environment: ctx.environment, message_id: message.id, journey_id: journey.id, association_source: 'SMS_SHORTCUT', associated_at: nowIso }, false);
    await services.insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, message_id: message.id, type: 'INBOUND_MESSAGE', occurred_at: stamp, created_at: nowIso }, false);
  }
  // Every calculator message gets its destination now (the cron repeats it if this step fails: nothing is lost).
  if (calculator) {
    const routed = !services.route ? null : await Promise.resolve().then(() => services.route(ctx, { message_id: message.id, chat_id: chat.id, channel: 'SMS', body_text: text, contact_id: contactId, linked_journeys: journey ? [journey.id] : [] })).catch(() => null);
    if (!journey && routed && routed.result && routed.result.journeyId) journey = { id: routed.result.journeyId, reference_code: routed.ref || null, vehicle_text: null };
  }
  if (!journey) return { stored: true, queued: true, newContact };
  await services.patchRows(ctx, 'chats', { id: 'eq.' + chat.id, environment: 'eq.' + ctx.environment }, { last_seen_at: nowIso, updated_at: nowIso });

  // 5. aviso no celular
  const [contact] = await services.rows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment, id: 'eq.' + contactId, limit: '1' });
  // "Ref" only for the calculator Ref proven for the ficha; its internal code never shows as Ref.
  const calcRef = services.calcRef ? await services.calcRef(ctx, journey).catch(() => null) : null;
  const title = notificationTitle({ name: contact?.display_name, phone, ref: calcRef, noRef: true, vehicle: journey.vehicle_text });
  const push = services.push(ctx, { contactId, messageId: message.id, payload: { type: 'customer-message', messageId: message.id, journeyId: journey.id, title } });
  return { stored: true, push };
}

const defaultServices = { rows, allRows, insert, patchRows, push: sendPanelPush, calcRef: calcRefOfJourney, route: (ctx, message) => calcRoute.routeOne(ctx, message) };

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const config = configuration();
  const ctx = config && SERVER_ENVIRONMENT ? { config, environment: SERVER_ENVIRONMENT } : null;
  const supplied = req.headers['x-sms-secret'];
  const authorized = secretMatches(supplied, process.env.SMS_INBOUND_SECRET)
    || await deviceTokenMatches(ctx, supplied, module.exports.services);
  if (!authorized) return send(res, 401, { error: 'UNAUTHORIZED' });
  if (!ctx) return send(res, 200, { stored: false });
  try {
    const body = await jsonBody(req, 64 * 1024);
    const result = await receive(ctx, body, module.exports.services);
    if (result.push) (typeof req.waitUntil === 'function' ? req.waitUntil : waitUntil)(Promise.resolve(result.push).catch(() => null));
    return send(res, 200, result.duplicate ? { stored: false, duplicate: true } : { stored: Boolean(result.stored) });
  } catch (_) {
    // nenhum dado da mensagem nem do erro vai para log: remetente, nome, texto e corpo ficam fora
    console.error('[sms-inbound] falha ao processar');
    return send(res, 200, { stored: false });
  }
};
module.exports.services = defaultServices;
module.exports.receive = receive;
module.exports.secretMatches = secretMatches;
module.exports.deviceTokenMatches = deviceTokenMatches;
module.exports.messageDate = messageDate;
module.exports.plainName = plainName;

'use strict';

// Envio manual da V1 pelo 360dialog, sempre por clique do operador (nunca ao gerar a V1).
//  POST prepare  destino (telefone da ficha, decidido aqui), texto sugerido pela origem da busca,
//                janela de 24 h, modo de envio e o último envio desta V1
//  POST send     envia depois da confirmação; uma chave por confirmação, um envio em andamento por V1
// Modo: fora de produção é sempre simulado (nenhuma mensagem real sai de Preview ou de teste). Em
// produção só envia com V1_DIRECT_SEND_ENABLED=1; sem ela o envio direto fica desligado.
// Sem confirmação inequívoca do 360dialog o envio fica "Não confirmado", nunca "Enviado", e nada é
// tentado de novo sozinho. O navegador nunca recebe segredo nem resposta bruta do provedor.
const crypto = require('node:crypto');
const { insert, isUuid, jsonBody, patchRows, requirePanel, rows, send } = require('../../panel-server');
const reply = require('./reply');

const MAX_TEXT = reply.MAX_TEXT;
const TIMEOUT_MS = 15000;
const inFlight = new Set();

const TEMPLATES = {
  VALOR: (name, link) => `Hi ${name},\n\nI put together a first look at what the current auction market supports within the range we are working with\n\nYou can view it here: ${link}\n\nThis is a practical reference point for what is realistic right now\n\nIf an option makes sense, we can review the details before deciding whether to pursue it`,
  CARRO: (name, link) => `Hi ${name},\n\nI reviewed the current auction listings against the vehicle details you provided and pulled together the options that match\n\nYou can view them here: ${link}\n\nThis reflects what is available right now\n\nThe next step is to review each vehicle individually before any decision is made`
};

function sendMode(env = process.env) {
  if (env.VERCEL_ENV !== 'production') return 'SIMULATED';
  return env.V1_DIRECT_SEND_ENABLED === '1' ? 'LIVE' : 'OFF';
}
// First name only when the ficha has a real one (never a phone number).
function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return /\p{L}/u.test(first) && !/\d/.test(first) ? first.slice(0, 40) : '';
}
// The origin of the search decides the model; unknown origin gets no model.
function originOf(demandKey, journeyId) {
  const match = /^journey:([0-9a-f-]{36}):(VALOR|CARRO)$/.exec(String(demandKey || ''));
  return match && match[1] === journeyId ? match[2] : null;
}
function suggestedText(origin, name, link) {
  if (!origin) return '';
  return TEMPLATES[origin](firstName(name) || 'there', link);
}
const baseUrlOf = (value) => { const text = String(value || ''); return /^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(text) ? text.replace(/\/$/, '') : null; };
const waLink = (phone, text) => 'https://wa.me/' + phone.replace(/^\+/, '') + '?text=' + encodeURIComponent(text);
const missingTable = (error) => error && (error.status === 404 || /PGRST205|PGRST202|42P01/.test(String(error.code || '') + String(error.message || '')));
const sendOut = (row) => row ? { status: row.status, at: row.updated_at || row.created_at, simulated: row.simulated === true, resend: row.resend === true, errorCode: row.error_code || null } : null;

async function vitrineFor(ctx, token, services) {
  if (!/^[A-Za-z0-9_-]{16,80}$/.test(String(token || ''))) return null;
  const [vitrine] = await services.rows(ctx, 'vitrines', { select: 'id,token,journey_id,version', environment: 'eq.' + ctx.environment, token: 'eq.' + token, limit: '1' });
  return vitrine && vitrine.version === 'V1' && isUuid(vitrine.journey_id) ? vitrine : null;
}
async function lastSend(ctx, vitrineId, services) {
  const [row] = await services.rows(ctx, 'v1_sends', { select: 'id,status,simulated,resend,error_code,created_at,updated_at', environment: 'eq.' + ctx.environment, vitrine_id: 'eq.' + vitrineId, order: 'created_at.desc', limit: '1' });
  return row || null;
}

async function prepare(ctx, body, services, env) {
  const vitrine = await vitrineFor(ctx, body.token, services);
  if (!vitrine) return { status: 404, error: 'VITRINE_NOT_FOUND' };
  const base = baseUrlOf(body.baseUrl);
  if (!base) return { status: 400, error: 'V1_SEND_INVALID' };
  const previous = await lastSend(ctx, vitrine.id, services);
  const link = base + '/v/' + vitrine.token;
  const target = await reply.resolveTarget(ctx, vitrine.journey_id, services);
  const mode = sendMode(env);
  if (!target) return { status: 200, eligible: false, reason: 'NO_VALID_PHONE', mode, link, last: sendOut(previous) };
  const origin = originOf(body.demandKey, vitrine.journey_id);
  const text = suggestedText(origin, target.name, link);
  const window = await reply.windowState(ctx, target.chat.id, services);
  return { status: 200, eligible: true, mode, name: target.name, phone: target.phone, origin, text, link, windowOpen: window.allowed === true,
    whatsappLink: waLink(target.phone, text || link), last: sendOut(previous) };
}

// One call to the 360dialog with a time limit. Only a message id is a confirmation.
async function deliver(phone, text, services, timeoutMs = TIMEOUT_MS) {
  if (services.d360Send !== reply.d360Send) return services.d360Send(phone, text);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const result = await reply.d360Send(phone, text, (url, options) => fetch(url, { ...options, signal: controller.signal }));
    return timedOut ? { error: 'D360_TIMEOUT' } : result;
  } finally { clearTimeout(timer); }
}
// Refused by the provider (4xx) or never tried: failed. Anything else without an id: not confirmed.
const failedFor = (code) => /^D360_HTTP_4\d\d$/.test(code) || code === 'D360_KEY_MISSING';

async function sendV1(ctx, body, services, env, now) {
  const text = String(body.text || '').replace(/\r\n/g, '\n').trim();
  if (!text) return { status: 400, error: 'TEXT_REQUIRED' };
  if (text.length > MAX_TEXT) return { status: 400, error: 'TEXT_TOO_LONG' };
  if (!isUuid(body.requestKey) || body.confirmed !== true) return { status: 400, error: 'V1_SEND_CONFIRM_REQUIRED' };
  const vitrine = await vitrineFor(ctx, body.token, services);
  if (!vitrine) return { status: 404, error: 'VITRINE_NOT_FOUND' };
  // The message always carries this V1's link.
  if (!text.includes('/v/' + vitrine.token)) return { status: 400, error: 'V1_LINK_MISSING' };
  const mode = sendMode(env);
  if (mode === 'OFF') return { status: 409, error: 'V1_DIRECT_SEND_DISABLED' };
  if (inFlight.has(vitrine.id)) return { status: 409, error: 'SEND_IN_PROGRESS' };
  inFlight.add(vitrine.id);
  try {
    const previous = await lastSend(ctx, vitrine.id, services);
    if (previous && previous.status === 'SENDING') return { status: 409, error: 'SEND_IN_PROGRESS' };
    if (previous && ['SENT', 'UNCONFIRMED'].includes(previous.status) && body.resend !== true) return { status: 409, error: 'V1_ALREADY_SENT', last: sendOut(previous) };
    const target = await reply.resolveTarget(ctx, vitrine.journey_id, services);
    if (!target) return { status: 400, error: 'NO_VALID_PHONE' };
    const window = await reply.windowState(ctx, target.chat.id, services, now);
    // Outside the WhatsApp window nothing is tried: the operator opens WhatsApp with the text ready.
    if (!window.allowed) return { status: 409, error: 'WINDOW_CLOSED', whatsappLink: waLink(target.phone, text) };
    let row;
    try {
      [row] = await services.insert(ctx, 'v1_sends', { environment: ctx.environment, vitrine_id: vitrine.id, journey_id: vitrine.journey_id, chat_id: target.chat.id,
        contact_id: target.contactId, phone_e164: target.phone, origin: originOf(body.demandKey, vitrine.journey_id), body_text: text,
        body_sha256: crypto.createHash('sha256').update(text, 'utf8').digest('hex'), request_key: body.requestKey, status: 'SENDING',
        simulated: mode === 'SIMULATED', resend: body.resend === true, created_by: ctx.panel.id });
    } catch (error) {
      // Unique key (the same confirmation twice, or another send of this V1 in progress).
      if (error && error.status === 409) return { status: 409, error: 'SEND_IN_PROGRESS' };
      throw error;
    }
    const finish = (patch) => services.patchRows(ctx, 'v1_sends', { environment: 'eq.' + ctx.environment, id: 'eq.' + row.id }, { ...patch, updated_at: new Date(now).toISOString() });
    if (mode === 'SIMULATED') {
      await finish({ status: 'SENT', provider_message_id: 'simulated-' + row.id });
      return { status: 200, sendStatus: 'SENT', simulated: true, at: new Date(now).toISOString() };
    }
    const sent = await deliver(target.phone, text, services);
    if (sent.error) {
      const status = failedFor(sent.error) ? 'FAILED' : 'UNCONFIRMED';
      await finish({ status, error_code: sent.error });
      return { status: 200, sendStatus: status, errorCode: sent.error, at: new Date(now).toISOString() };
    }
    await finish({ status: 'SENT', provider_message_id: sent.messageId });
    // Already with the customer: a failure to record it in the conversation does not undo "sent".
    await reply.recordSent(ctx, target, text, sent.messageId, services, now).catch(() => null);
    return { status: 200, sendStatus: 'SENT', simulated: false, at: new Date(now).toISOString() };
  } finally { inFlight.delete(vitrine.id); }
}

const defaultServices = { rows, insert, patchRows, applyMessage: reply.applyMessage, d360Send: reply.d360Send };

async function handle(ctx, body, services = defaultServices, env = process.env, now = Date.now()) {
  const action = String(body && body.action || '');
  try {
    if (action === 'prepare') return await prepare(ctx, body, services, env);
    if (action === 'send') return await sendV1(ctx, body, services, env, now);
    return { status: 400, error: 'ACTION_INVALID' };
  } catch (error) {
    if (missingTable(error)) return { status: 503, error: 'V1_SEND_PENDING' };
    throw error;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const { status, ...out } = await handle(ctx, await jsonBody(req, 32 * 1024));
    return send(res, status, out);
  } catch (_) {
    return send(res, 500, { error: 'V1_SEND_UNAVAILABLE' });
  }
};
module.exports.handle = handle;
module.exports.sendMode = sendMode;
module.exports.suggestedText = suggestedText;
module.exports.firstName = firstName;

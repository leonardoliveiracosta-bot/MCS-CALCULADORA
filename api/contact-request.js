'use strict';
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { SERVER_ENVIRONMENT, configuration, jsonBody, isUuid, supabase, send } = require('../panel-server');
const { normalizePhone } = require('../panel-phone');

function inputOf(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const name = typeof body.name === 'string' ? body.name.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
  const raw = typeof body.phone === 'string' ? body.phone.trim() : '';
  const digits = raw.replace(/\D/g, '');
  const phone = /^[+\d\s().-]+$/.test(raw) && (raw.startsWith('+') || digits.length === 10 || (digits.length === 11 && digits[0] === '1')) ? normalizePhone(raw) : null;
  if (name.length < 2 || name.length > 80 || /[\u0000-\u001f<>]/.test(name) || !phone || digits.length < 8 || !isUuid(body.requestId) || !['SMS', 'WHATSAPP', 'CALL'].includes(body.channel) || !['en', 'pt', 'es'].includes(body.language) || !['footer', 'contact-menu'].includes(body.source) || body.consent !== true) return null;
  return { name, phone, channel: body.channel, language: body.language, source: body.source, requestId: body.requestId };
}
function originAllowed(req) {
  try {
    const origin = new URL(req.headers?.origin || '');
    if (origin.protocol !== 'https:') return false;
    if (SERVER_ENVIRONMENT === 'production') return /^(www\.)?mycarscout\.net$/.test(origin.hostname);
    return origin.host === String(req.headers?.host || '').toLowerCase() && origin.hostname.endsWith('.vercel.app');
  } catch (_) { return false; }
}
function ipHash(req, key) {
  const candidate = String(req.headers?.['x-vercel-forwarded-for'] || req.headers?.['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',').at(-1).trim();
  return crypto.createHmac('sha256', key).update(isIP(candidate) ? candidate : 'unknown').digest('hex');
}
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  if (!originAllowed(req) || !/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type'] || '')) return send(res, 403, { error: 'REQUEST_NOT_ALLOWED' });
  const config = configuration();
  if (!config) return send(res, 503, { error: 'CONTACT_UNAVAILABLE' });
  try {
    const body = await jsonBody(req, 4096);
    if (typeof body.website === 'string' && body.website.trim()) return send(res, 200, { ok: true });
    const input = inputOf(body);
    if (!input) return send(res, 400, { error: 'CONTACT_INVALID' });
    await supabase(config.url, config.secretKey, '/rest/v1/rpc/site_contact_request_create', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_environment: SERVER_ENVIRONMENT, p_request_key: input.requestId, p_name: input.name, p_phone: input.phone, p_channel: input.channel, p_language: input.language, p_source: input.source, p_ip_hash: ipHash(req, config.secretKey) })
    });
    return send(res, 200, { ok: true });
  } catch (error) {
    if (error.code === 'CONTACT_RATE_LIMIT') return send(res, 429, { error: 'CONTACT_RATE_LIMIT' });
    if (error.code === 'CONTACT_KEY_CONFLICT') return send(res, 409, { error: 'CONTACT_KEY_CONFLICT' });
    if (error.message === 'PAYLOAD_TOO_LARGE' || error instanceof SyntaxError) return send(res, 400, { error: 'CONTACT_INVALID' });
    return send(res, 503, { error: 'CONTACT_UNAVAILABLE' });
  }
};
module.exports.inputOf = inputOf;
module.exports.originAllowed = originAllowed;

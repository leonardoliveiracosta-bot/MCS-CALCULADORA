'use strict';

// Dreno de logs da Vercel -> panel_server_logs, para a auditoria do assistente ("erros do servidor nas
// últimas 24 h"). A Vercel assina cada envio com HMAC-SHA1 do corpo (x-vercel-signature) usando o
// segredo do dreno (LOG_DRAIN_SECRET). Guarda só erro de função ou resposta 5xx, com a mensagem cortada;
// o resto é descartado. Nunca responde erro para a Vercel não desligar o dreno por falha nossa.
const crypto = require('node:crypto');

const MAX_BODY = 4 * 1024 * 1024;
const environmentOf = (value) => (value === 'production' || value === 'preview' ? value : process.env.VERCEL_ENV === 'preview' ? 'preview' : 'production');

// O corpo cru (a assinatura é sobre os bytes): lido do fluxo antes de qualquer acesso a req.body, que na
// Vercel é calculado só quando lido.
async function rawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) break; chunks.push(Buffer.from(chunk)); }
  return Buffer.concat(chunks);
}

function signed(secret, body, signature) {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac('sha1', secret).update(body).digest('hex');
  const given = String(signature);
  return given.length === expected.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function entries(body) {
  const text = body.toString('utf8').trim();
  if (!text) return [];
  try { const parsed = JSON.parse(text); return Array.isArray(parsed) ? parsed : [parsed]; }
  catch (_) { return text.split('\n').map((line) => { try { return JSON.parse(line); } catch (_) { return null; } }).filter(Boolean); }
}

function keep(entry) {
  const status = Number(entry.statusCode || (entry.proxy && entry.proxy.statusCode)) || null;
  const level = String(entry.level || '').toLowerCase();
  return level === 'error' || level === 'fatal' || (status !== null && status >= 500);
}

function rowOf(entry) {
  const proxy = entry.proxy || {};
  const status = Number(entry.statusCode || proxy.statusCode) || null;
  const at = Number(entry.timestamp) ? new Date(Number(entry.timestamp)).toISOString() : null;
  return {
    environment: environmentOf(entry.environment), logged_at: at, level: String(entry.level || '').slice(0, 20) || null, status_code: status,
    path: String(entry.path || proxy.path || '').split('?')[0].slice(0, 200) || null, source: String(entry.source || '').slice(0, 20) || null,
    request_id: String(entry.requestId || '').slice(0, 80) || null, deployment_id: String(entry.deploymentId || '').slice(0, 80) || null,
    message: String(entry.message || '').replace(/\s+/g, ' ').slice(0, 500) || null
  };
}

module.exports = async (req, res) => {
  const verify = process.env.LOG_DRAIN_VERIFY;
  if (verify) res.setHeader('x-vercel-verify', verify);
  if (req.method !== 'POST') { res.statusCode = 200; return res.end('ok'); }
  const body = await rawBody(req).catch(() => Buffer.alloc(0));
  if (!signed(process.env.LOG_DRAIN_SECRET, body, req.headers['x-vercel-signature'])) { res.statusCode = 403; return res.end('forbidden'); }
  const rows = entries(body).filter(keep).slice(0, 200).map(rowOf);
  const url = String(process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SECRET_KEY;
  if (rows.length && url && key) {
    await fetch(url + '/rest/v1/panel_server_logs', {
      method: 'POST', headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(rows)
    }).catch(() => null);
  }
  res.statusCode = 200;
  return res.end('ok');
};
module.exports.signed = signed;
module.exports.keep = keep;
module.exports.rowOf = rowOf;

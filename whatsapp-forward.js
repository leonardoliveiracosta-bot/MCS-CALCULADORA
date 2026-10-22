'use strict';
// Cópia das mensagens do WhatsApp para o sistema do Rene (n8n), autorizada pelo Leo.
// Só copia: nada aqui muda a resposta do webhook, o bot ou o envio. Roda em segundo plano (waitUntil),
// desiste em 3 segundos e qualquer falha vira só um console.error curto. Sem as duas variáveis, não faz nada.
const TIMEOUT_MS = 3000;

function target() {
  const url = String(process.env.RENE_FORWARD_URL || '').trim();
  const secret = String(process.env.RENE_FORWARD_SECRET || '').trim();
  return url && secret ? { url, secret } : null;
}

async function post(body, fetchImpl = fetch) {
  const to = target();
  if (!to) return { skipped: true };
  // Limite explícito (AbortSignal.timeout não segura a função viva sozinho): em 3 segundos a cópia desiste.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('timeout', 'TimeoutError')), TIMEOUT_MS);
  try {
    const response = await fetchImpl(to.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mcs-secret': to.secret },
      body: JSON.stringify(body), signal: controller.signal });
    if (!response.ok) console.error('[rene-forward] HTTP ' + response.status);
    return { ok: Boolean(response.ok) };
  } catch (error) {
    console.error('[rene-forward] ' + String((error && (error.name || error.message)) || 'erro').slice(0, 60));
    return { ok: false };
  } finally { clearTimeout(timer); }
}

// O pedido segue sem esperar a cópia; a função só termina depois dela (ou dos 3 segundos).
function background(task, req) {
  try { (req && typeof req.waitUntil === 'function' ? req.waitUntil : require('@vercel/functions').waitUntil)(task); } catch (_) {}
  return task;
}

// Evento recebido do 360dialog, já autenticado e guardado, com o mesmo JSON que chegou.
function forwardInbound(payload, req, fetchImpl) {
  if (!target()) return null;
  return background(post(payload, fetchImpl), req);
}

// Mensagem que o painel acabou de enviar (resposta, V1, resposta automática, opções automáticas).
function forwardOutbound({ to, type = 'text', text, messageId, sentAt = new Date() } = {}, fetchImpl) {
  if (!target()) return null;
  return background(post({ mcs_outbound: { to: String(to || '').replace(/^\+/, ''), type, text: String(text ?? ''), message_id: String(messageId || ''), sent_at: new Date(sentAt).toISOString() } }, fetchImpl));
}

module.exports = { TIMEOUT_MS, forwardInbound, forwardOutbound };

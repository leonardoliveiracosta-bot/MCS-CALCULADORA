'use strict';

// "Enviar para meu celular": manda o link wa.me (com o texto) como aviso para os aparelhos com os avisos do painel ativos.
const { requirePanel, send, jsonBody } = require('../../panel-server');
const { vapidDetails, subscriptionsFor, deliverToSubscriptions } = require('../../panel-push');

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  const subscriptions = vapidDetails() ? await subscriptionsFor(ctx, ctx.panel.id).catch(() => []) : [];
  if (req.method === 'GET') return send(res, 200, { available: subscriptions.length > 0 });
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const body = await jsonBody(req, 16 * 1024).catch(() => ({}));
  const url = String(body.url || '');
  if (!/^https:\/\/wa\.me\/\d{6,16}(\?text=[^\s]*)?$/.test(url) || url.length > 3000) return send(res, 400, { error: 'HANDOFF_URL_INVALID' });
  if (!subscriptions.length) return send(res, 409, { error: 'PUSH_NOT_ACTIVE' });
  const result = await deliverToSubscriptions(ctx, subscriptions, { kind: 'WA_HANDOFF', title: 'Enviar no WhatsApp', body: 'Toque para abrir a conversa com o texto pronto', url });
  return send(res, 201, { accepted: result.accepted || 0, failed: result.failed || 0 });
};

'use strict';

// Sugestões de resposta e fila de conversas antigas (painel/sugestoes). Nada aqui envia mensagem:
// GET  fila de conversas antigas, das mais antigas para as mais novas, e as excluídas com o motivo
// POST { action: 'suggest', journeyId, mode? }  sugestão editável, com tradução e fatos
const { jsonBody, requirePanel, send } = require('../../panel-server');
const suggestions = require('../../panel-reply-suggest');

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') return send(res, 200, await suggestions.queue(ctx, { minDays: req.query && req.query.minDays }));
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 8 * 1024);
    if (body.action !== 'suggest') return send(res, 400, { error: 'ACTION_INVALID' });
    const { status, ...out } = await suggestions.suggest(ctx, body);
    return send(res, status, out);
  } catch (_) {
    return send(res, 500, { error: 'SUGGESTION_UNAVAILABLE' });
  }
};

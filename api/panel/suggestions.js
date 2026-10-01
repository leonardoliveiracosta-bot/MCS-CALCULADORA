'use strict';

// Sugestões de resposta e fila de conversas antigas (painel/sugestoes). Nada aqui envia mensagem:
// GET  fila de conversas antigas, das mais antigas para as mais novas, e as excluídas com o motivo
// POST { action: 'suggest', journeyId, mode? }  sugestão editável, com tradução e fatos
// POST { action: 'guided', journeyId, guidance }  resposta a partir do que o operador quer transmitir
// POST { action: 'translations', journeyId }     traduções já guardadas da conversa (sem custo)
// POST { action: 'translate', journeyId, messageIds }  traduz as mensagens pedidas que faltam (com cache)
const { jsonBody, requirePanel, send } = require('../../panel-server');
const suggestions = require('../../panel-reply-suggest');
const guided = require('../../panel-reply-guided');

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') return send(res, 200, await suggestions.queue(ctx, { minDays: req.query && req.query.minDays }));
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 8 * 1024);
    const run = { suggest: suggestions.suggest, guided: guided.guided, translations: guided.translations, translate: guided.translate }[body.action];
    if (!run) return send(res, 400, { error: 'ACTION_INVALID' });
    const { status, ...out } = await run(ctx, body);
    return send(res, status, out);
  } catch (_) {
    return send(res, 500, { error: 'SUGGESTION_UNAVAILABLE' });
  }
};

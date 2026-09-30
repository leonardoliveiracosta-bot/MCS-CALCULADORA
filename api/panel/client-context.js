'use strict';

// Contexto do caso para qualquer cartão do painel (HOJE, ENTRADA, CLIENTES, PESQUISAS, OPÇÕES):
// recebe ids de ficha, Refs e contatos e devolve o resumo de cada um. Só leitura.
const { buildContexts, MAX_IDS } = require('../../panel-client-context');
const { jsonBody, requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const body = await jsonBody(req, 32 * 1024);
    const sizes = ['journeyIds', 'refs', 'contactIds'].map((key) => Array.isArray(body[key]) ? body[key].length : 0);
    if (sizes.some((size) => size > MAX_IDS)) return send(res, 400, { error: 'TOO_MANY_IDS', max: MAX_IDS });
    if (!sizes.some(Boolean)) return send(res, 400, { error: 'IDS_REQUIRED' });
    return send(res, 200, await buildContexts(ctx, body));
  } catch (error) {
    if (error && error.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    return send(res, 500, { error: 'CLIENT_CONTEXT_FAILED' });
  }
};

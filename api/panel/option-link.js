'use strict';

// Link de opções para o cliente: POST { key } devolve o código do link do pedido (sempre o mesmo para o mesmo
// pedido). O painel monta o endereço /o/<código> e copia. Nada é enviado ao cliente aqui.
// GET ?key=... diz se o link existe, quantas vezes foi aberto e a última vez (só leitura).
const { jsonBody, requirePanel, send } = require('../../panel-server');
const { linkFor, linkOpens } = require('../../panel-option-links');

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  if (req.method === 'GET') {
    try {
      const out = await linkOpens(ctx, String(req.query && req.query.key || ''));
      return out ? send(res, 200, out) : send(res, 400, { error: 'OPTION_LINK_KEY_INVALID' });
    } catch (_) { return send(res, 503, { error: 'OPTION_LINK_UNAVAILABLE' }); }
  }
  try {
    const body = await jsonBody(req, 4096);
    const code = await linkFor(ctx, String(body.key || ''), ctx.panel && ctx.panel.id);
    return send(res, 200, { code, path: '/o/' + code });
  } catch (error) {
    if (error && error.code === 'OPTION_LINK_KEY_INVALID') return send(res, 400, { error: 'OPTION_LINK_KEY_INVALID' });
    console.error('[option-link]', { message: String(error && error.message || 'UNKNOWN') });
    return send(res, 503, { error: 'OPTION_LINK_UNAVAILABLE' });
  }
};

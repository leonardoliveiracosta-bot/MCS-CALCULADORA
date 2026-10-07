'use strict';

// Página pública /o/<código>: os carros do pedido no lote ativo, sem valor, sem nome do leilão, VIN sem os 6 últimos.
const { SERVER_ENVIRONMENT, configuration, send } = require('../panel-server');
const { publicView } = require('../panel-option-links');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const config = configuration();
  if (!config || !SERVER_ENVIRONMENT) return send(res, 503, { error: 'SERVICE_UNAVAILABLE' });
  try {
    const view = await publicView({ config, environment: SERVER_ENVIRONMENT }, String(req.query && req.query.code || ''));
    if (!view) return send(res, 404, { error: 'NOT_FOUND' });
    return send(res, 200, view);
  } catch (error) {
    console.error('[option-link-public]', { message: String(error && error.message || 'UNKNOWN') });
    return send(res, 503, { error: 'SERVICE_UNAVAILABLE' });
  }
};

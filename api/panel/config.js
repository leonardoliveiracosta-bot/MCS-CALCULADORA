'use strict';
const { SERVER_ENVIRONMENT, configuration, send } = require('../../panel-server');

module.exports = (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const config = configuration();
  if (!config || !SERVER_ENVIRONMENT) return send(res, 503, { error: 'PANEL_NOT_CONFIGURED' });
  return send(res, 200, { url: config.url, publishableKey: config.publishableKey, environment: SERVER_ENVIRONMENT });
};

'use strict';
const { requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requirePanel(req, res);
    if (!session) return;
    return send(res, 200, { environment: session.environment, items: [] });
  } catch (error) {
    return send(res, 500, { error: 'PANEL_TODAY_ERROR' });
  }
};

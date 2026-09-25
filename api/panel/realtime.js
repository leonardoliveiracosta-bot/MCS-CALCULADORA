'use strict';

const { requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  // No signing secret is introduced in this execution. The frozen specification
  // explicitly permits this safe two-minute API refresh fallback.
  return send(res, 200, { environment: ctx.environment, enabled: false, refreshSeconds: 120 });
};

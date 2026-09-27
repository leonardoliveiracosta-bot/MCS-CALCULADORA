'use strict';
const { requirePanel, rows, send } = require('../../panel-server');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res); if (!ctx) return;
  try { const data = await rows(ctx, 'panel_capture_checks', { select: 'checked_at,missing_count,missing_refs,error_code,failed_at', environment: 'eq.' + ctx.environment, limit: '1' }); return send(res, 200, { check: data[0] || null }); }
  catch (_) { return send(res, 503, { error: 'CAPTURE_CHECK_UNAVAILABLE' }); }
};

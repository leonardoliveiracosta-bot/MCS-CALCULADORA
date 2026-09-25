'use strict';
const { buildTodayItems } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
const { panelMeta, requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requirePanel(req, res);
    if (!session) return;
    const [data, meta] = await Promise.all([operational(session), panelMeta(session)]);
    return send(res, 200, { environment: session.environment, items: buildTodayItems(data), meta });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_TODAY_ERROR' });
  }
};

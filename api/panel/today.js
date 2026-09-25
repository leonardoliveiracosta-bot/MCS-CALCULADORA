'use strict';
const { buildTodayItems, buildTodayOrderItems, consolidateCalcRuns } = require('../../panel-domain');
const { operational } = require('../../panel-read-model');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requirePanel(req, res);
    if (!session) return;
    const [data, calcRuns, links, meta] = await Promise.all([
      operational(session),
      allRows(session, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados', order: 'created_at.asc' }),
      allRows(session, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + session.environment }),
      panelMeta(session)
    ]);
    const journeyItems = buildTodayItems(data);
    const orderItems = buildTodayOrderItems(consolidateCalcRuns(calcRuns, links));
    const items = journeyItems.concat(orderItems).sort((left, right) => right.waitMs - left.waitMs || right.budgetCents - left.budgetCents || left.id.localeCompare(right.id));
    return send(res, 200, { environment: session.environment, items, meta });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_TODAY_ERROR' });
  }
};

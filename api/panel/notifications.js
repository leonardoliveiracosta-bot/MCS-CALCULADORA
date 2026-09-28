'use strict';

const { requirePanel, send } = require('../../panel-server');
const { customerMessageNotifications, notificationCursor } = require('../../panel-notifications');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  const after = notificationCursor(req.query?.after);
  if (!after) return send(res, 400, { error: 'NOTIFICATION_CURSOR_INVALID' });
  try {
    const items = await customerMessageNotifications(ctx, after);
    const cursor = items.at(-1)?.created_at || after;
    return send(res, 200, { items: items.map((item) => ({ id: item.id, createdAt: item.created_at })), cursor });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_NOTIFICATIONS_ERROR' });
  }
};

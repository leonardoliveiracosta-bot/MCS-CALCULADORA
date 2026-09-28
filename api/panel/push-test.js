'use strict';

const { requirePanel, send } = require('../../panel-server');
const { sendTestPush, vapidDetails } = require('../../panel-push');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  if (!vapidDetails()) return send(res, 503, { error: 'PUSH_NOT_CONFIGURED' });
  const result = await sendTestPush(ctx).catch(() => ({ accepted: 0, failed: 1 }));
  if (!result.accepted) return send(res, 409, { error: 'PUSH_TEST_NOT_DELIVERED', failed: result.failed || 0 });
  return send(res, 201, { accepted: result.accepted, failed: result.failed || 0 });
};

'use strict';

const { requirePanel, send } = require('../../panel-server');
const { vapidDetails } = require('../../panel-push');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  const vapid = vapidDetails();
  if (!vapid) return send(res, 503, { error: 'PUSH_NOT_CONFIGURED' });
  return send(res, 200, { publicKey: vapid.publicKey });
};

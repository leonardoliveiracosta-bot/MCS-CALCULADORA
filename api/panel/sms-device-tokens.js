'use strict';

const crypto = require('node:crypto');
const { allRows, isUuid, jsonBody, patchRows, requirePanel, rpc, safeText, send } = require('../../panel-server');

const publicItem = (row) => ({
  id: row.id,
  deviceName: row.device_name,
  createdAt: row.created_at,
  status: row.revoked_at ? 'REVOKED' : 'ACTIVE'
});

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') {
      const items = await allRows(ctx, 'sms_device_tokens', {
        select: 'id,device_name,created_at,revoked_at',
        environment: 'eq.' + ctx.environment,
        order: 'created_at.desc'
      });
      return send(res, 200, { items: items.map(publicItem) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 4096);
    if (body.action === 'generate') {
      const deviceName = safeText(body.deviceName || 'iPhone', 120, true);
      if (!deviceName) return send(res, 400, { error: 'SMS_DEVICE_NAME_INVALID' });
      const code = crypto.randomBytes(32).toString('base64url');
      const tokenHash = crypto.createHash('sha256').update(code, 'utf8').digest('hex');
      const generated = await rpc(ctx, 'panel_sms_device_token_generate', {
        p_environment: ctx.environment,
        p_token_hash: tokenHash,
        p_device_name: deviceName
      });
      const row = Array.isArray(generated) ? generated[0] : generated;
      if (!row) throw new Error('SMS_DEVICE_TOKEN_NOT_CREATED');
      return send(res, 201, { code, item: publicItem(row) });
    }
    if (body.action === 'revoke' && isUuid(body.id)) {
      await patchRows(ctx, 'sms_device_tokens', {
        id: 'eq.' + body.id,
        environment: 'eq.' + ctx.environment,
        revoked_at: 'is.null'
      }, { revoked_at: new Date().toISOString() });
      return send(res, 200, { ok: true });
    }
    return send(res, 400, { error: 'SMS_DEVICE_ACTION_INVALID' });
  } catch (_) {
    return send(res, 500, { error: 'SMS_DEVICE_TOKENS_FAILED' });
  }
};

module.exports.publicItem = publicItem;

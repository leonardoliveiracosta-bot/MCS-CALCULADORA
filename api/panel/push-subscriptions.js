'use strict';

const { jsonBody, requirePanel, safeText, send, supabase } = require('../../panel-server');

function subscriptionFrom(body) {
  const endpoint = safeText(body && body.endpoint, 2048, true);
  const p256dh = safeText(body && body.keys && body.keys.p256dh, 512, true);
  const auth = safeText(body && body.keys && body.keys.auth, 512, true);
  if (!endpoint || !p256dh || !auth || endpoint.length < 16 || p256dh.length < 16 || auth.length < 8) return null;
  try {
    if (new URL(endpoint).protocol !== 'https:') return null;
  } catch (_) { return null; }
  return { endpoint, p256dh, auth };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const subscription = subscriptionFrom(await jsonBody(req, 16 * 1024));
    if (!subscription) return send(res, 400, { error: 'PUSH_SUBSCRIPTION_INVALID' });
    const records = await supabase(ctx.config.url, ctx.config.secretKey,
      '/rest/v1/panel_push_subscriptions?on_conflict=environment,endpoint', {
        method: 'POST',
        headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify({
          environment: ctx.environment, panel_user_id: ctx.panel.id, ...subscription,
          updated_at: new Date().toISOString(), failure_count: 0, last_failure_at: null, last_failure_status: null
        })
      });
    return send(res, 201, { id: records && records[0] && records[0].id || null });
  } catch (_) {
    return send(res, 400, { error: 'PUSH_SUBSCRIPTION_INVALID' });
  }
};

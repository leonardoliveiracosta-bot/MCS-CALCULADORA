'use strict';
const { requirePanel, send, supabase } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requirePanel(req, res, { allowPasswordChange: true });
    if (!session) return;
    await supabase(session.config.url, session.config.secretKey,
      '/rest/v1/panel_users?id=eq.' + encodeURIComponent(session.panel.id)
        + '&environment=eq.' + encodeURIComponent(session.environment), {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          prefer: 'return=minimal'
        },
        body: JSON.stringify({ must_change_password: false, updated_at: new Date().toISOString() })
      });
    return send(res, 200, { ok: true });
  } catch (error) {
    return send(res, 500, { error: 'PASSWORD_CHANGE_CONFIRMATION_ERROR' });
  }
};

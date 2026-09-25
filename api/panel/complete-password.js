'use strict';
const { requirePanel, send, supabase, bearer } = require('../../panel-server');

const json = async (req) => {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const session = await requirePanel(req, res, { allowPasswordChange: true });
    if (!session) return;
    if (!session.panel.must_change_password) return send(res, 409, { error: 'PASSWORD_CHANGE_NOT_PENDING' });
    const input = await json(req);
    const password = String(input.newPassword || '');
    if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
      return send(res, 400, { error: 'PASSWORD_REQUIREMENTS_NOT_MET' });
    }
    const authResponse = await fetch(session.config.url + '/auth/v1/user', {
      method: 'PUT',
      headers: {
        apikey: session.config.publishableKey,
        authorization: 'Bearer ' + bearer(req),
        'content-type': 'application/json'
      },
      body: JSON.stringify({ password })
    });
    if (!authResponse.ok) return send(res, 400, { error: 'PASSWORD_AUTH_UPDATE_FAILED' });
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
  } catch (_) {
    return send(res, 500, { error: 'PASSWORD_CHANGE_CONFIRMATION_ERROR' });
  }
};

'use strict';

const SERVER_ENVIRONMENT = process.env.VERCEL_ENV === 'preview'
  ? 'preview'
  : process.env.VERCEL_ENV === 'production'
    ? 'production'
    : null;

function send(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(payload);
}

function configuration() {
  const url = process.env.SUPABASE_URL;
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!SERVER_ENVIRONMENT || !url || !publishableKey || !secretKey) return null;
  return { url: url.replace(/\/$/, ''), publishableKey, secretKey };
}

function bearer(req) {
  const value = req.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7) : null;
}

async function supabase(url, key, path, options = {}) {
  const response = await fetch(url + path, {
    ...options,
    headers: {
      apikey: key,
      authorization: 'Bearer ' + key,
      accept: 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error('Supabase request failed (' + response.status + '): ' + detail.slice(0, 300));
  }
  if (response.status === 204) return null;
  return response.json();
}

async function verifiedUser(config, accessToken) {
  if (!accessToken) return null;
  const response = await fetch(config.url + '/auth/v1/user', {
    headers: { apikey: config.publishableKey, authorization: 'Bearer ' + accessToken }
  });
  if (!response.ok) return null;
  return response.json();
}

async function panelUser(config, authUserId) {
  const query = '/rest/v1/panel_users?select=id,email,role,active,must_change_password'
    + '&environment=eq.' + encodeURIComponent(SERVER_ENVIRONMENT)
    + '&auth_user_id=eq.' + encodeURIComponent(authUserId)
    + '&active=is.true&limit=1';
  const rows = await supabase(config.url, config.secretKey, query);
  return rows[0] || null;
}

async function requirePanel(req, res, options = {}) {
  const config = configuration();
  if (!config) {
    send(res, 503, { error: 'PANEL_NOT_CONFIGURED' });
    return null;
  }
  if (!SERVER_ENVIRONMENT) {
    send(res, 403, { error: 'PANEL_ENVIRONMENT_NOT_ALLOWED' });
    return null;
  }
  const user = await verifiedUser(config, bearer(req));
  if (!user) {
    send(res, 401, { error: 'AUTHENTICATION_REQUIRED' });
    return null;
  }
  const panel = await panelUser(config, user.id);
  if (!panel) {
    send(res, 403, { error: 'PANEL_ACCESS_DENIED' });
    return null;
  }
  if (panel.must_change_password && !options.allowPasswordChange) {
    send(res, 403, { error: 'PASSWORD_CHANGE_REQUIRED' });
    return null;
  }
  return { config, user, panel, environment: SERVER_ENVIRONMENT };
}

module.exports = { SERVER_ENVIRONMENT, configuration, requirePanel, send, supabase };

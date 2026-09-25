'use strict';

const SERVER_ENVIRONMENT = process.env.VERCEL_ENV === 'preview'
  ? 'preview'
  : process.env.VERCEL_ENV === 'production'
    ? 'production'
    : null;

function send(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
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

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
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
    await response.text().catch(() => '');
    const failure = new Error('SUPABASE_REQUEST_FAILED');
    failure.status = response.status;
    throw failure;
  }
  if (response.status === 204) return null;
  const raw = await response.text();
  return raw ? JSON.parse(raw) : null;
}

function query(params) {
  return new URLSearchParams(params).toString();
}

async function rows(ctx, table, params) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table + '?' + query(params));
}

async function allRows(ctx, table, params, pageSize = 1000) {
  const result = [];
  let offset = 0;
  for (;;) {
    const page = await rows(ctx, table, { ...params, limit: String(pageSize), offset: String(offset) });
    result.push(...page);
    if (page.length < pageSize) return result;
    offset += pageSize;
  }
}

async function jsonBody(req, maximum = 128 * 1024) {
  if (typeof req.body === 'object' && req.body !== null) {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > maximum) throw new Error('PAYLOAD_TOO_LARGE');
    return req.body;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (Buffer.byteLength(raw, 'utf8') > maximum) throw new Error('PAYLOAD_TOO_LARGE');
  }
  return raw ? JSON.parse(raw) : {};
}

function safeText(value, maximum, required = false) {
  const output = String(value || '').normalize('NFC').trim();
  if ((required && !output) || output.length > maximum) return null;
  return output;
}

async function insert(ctx, table, payload, representation = true) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table, {
    method: 'POST',
    headers: { 'content-type': 'application/json', prefer: representation ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify(payload)
  });
}

async function patchRows(ctx, table, filters, payload, representation = false) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table + '?' + query(filters), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', prefer: representation ? 'return=representation' : 'return=minimal' },
    body: JSON.stringify(payload)
  });
}

async function panelMeta(ctx) {
  const latest = await rows(ctx, 'import_jobs', {
    select: 'completed_at', environment: 'eq.' + ctx.environment,
    channel: 'eq.WHATSAPP', completed_at: 'not.is.null', order: 'completed_at.desc', limit: '1'
  });
  return { dataUpdatedAt: new Date().toISOString(), lastWhatsAppImportAt: latest[0] ? latest[0].completed_at : null };
}

async function recordMutation(ctx, input) {
  const at = input.at || new Date().toISOString();
  await insert(ctx, 'activity_log', {
    environment: ctx.environment,
    journey_id: input.journeyId || null,
    contact_id: input.contactId || null,
    chat_id: input.chatId || null,
    activity_type: input.activityType,
    summary: input.summary,
    metadata: input.metadata || {},
    occurred_at: at,
    actor_user_id: ctx.panel.id
  }, false);
  await insert(ctx, 'audit_log', {
    environment: ctx.environment,
    actor_user_id: ctx.panel.id,
    entity_type: input.entityType,
    entity_id: input.entityId || null,
    action: input.action,
    before_json: input.before || null,
    after_json: input.after || null,
    created_at: at
  }, false);
  await insert(ctx, 'panel_notifications', {
    environment: ctx.environment,
    topic: input.topic || 'panel.updated',
    entity_type: input.entityType,
    entity_id: input.entityId || null,
    created_at: at
  }, false);
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

module.exports = {
  SERVER_ENVIRONMENT, allRows, bearer, configuration, insert, isUuid, jsonBody,
  panelMeta, patchRows, query, recordMutation, requirePanel, rows, safeText, send,
  supabase
};

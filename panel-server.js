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
  const value = req?.headers?.authorization || '';
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
    const detail = await response.text().catch(() => '');
    const failure = new Error('SUPABASE_REQUEST_FAILED');
    failure.status = response.status;
    // A RAISE inside an RPC arrives as {"code":"P0001","message":"JOURNEY_FROZEN"}: keep only
    // that business code (never the body) so handlers can answer with it.
    try { const parsed = JSON.parse(detail); if (/^[A-Z][A-Z0-9_]{2,60}$/.test(String(parsed?.message || ''))) failure.code = parsed.message; } catch (_) {}
    throw failure;
  }
  if (response.status === 204) return null;
  const raw = await response.text();
  return raw ? JSON.parse(raw) : null;
}

function query(params) {
  return new URLSearchParams(params).toString();
}

// A print of SMS without its original date (no Ref, or a Ref the calculator never recorded) has no moment at all: the
// time it was confirmed is never its date. Every read of messages that falls back to created_at gets it empty instead,
// so the message is never "recent" (not the latest, not in HOJE, no "há X min"); date_unknown says why on screen.
const UNKNOWN_DATE_TEXT = 'data original desconhecida';
const DATE_FIELDS = ['source_kind', 'occurred_at_utc', 'original_datetime_text'];
function messageDateParams(params) {
  const fields = params && params.select ? topLevelFields(params.select) : ['*'];
  if (fields.includes('*') || !fields.includes('created_at')) return { params, added: [] };
  const added = DATE_FIELDS.filter((field) => !fields.includes(field));
  return { params: added.length ? { ...params, select: fields.concat(added).join(',') } : params, added };
}
function maskUnknownDates(list, added) {
  if (!Array.isArray(list)) return list;
  list.forEach((row) => {
    if (row && row.source_kind === 'SMS_PRINT' && !row.occurred_at_utc && row.original_datetime_text === UNKNOWN_DATE_TEXT && 'created_at' in row) { row.created_at = null; row.date_unknown = true; }
    added.forEach((field) => { if (row) delete row[field]; });
  });
  return list;
}

async function rows(ctx, table, params) {
  if (table === 'messages') { const shaped = messageDateParams(params); return maskUnknownDates(await readRows(ctx, table, shaped.params), shaped.added); }
  return readRows(ctx, table, params);
}
async function readRows(ctx, table, params) {
  const path = '/rest/v1/' + table + '?' + query(params);
  // Abertura rápida: inside one /api/panel/boot call, the same read (same table, filters and page) is done once in the
  // database and shared by every list; each caller gets its own copy, so no list changes another's rows.
  if (ctx.readCache) {
    if (!ctx.readCache.has(path)) ctx.readCache.set(path, supabase(ctx.config.url, ctx.config.secretKey, path).catch((error) => { ctx.readCache.delete(path); throw error; }));
    return ctx.readCache.get(path).then((value) => structuredClone(value));
  }
  return supabase(ctx.config.url, ctx.config.secretKey, path);
}

// Stable paging. Offset pages over an unordered (or updatable) sort can skip or repeat rows when
// something changes between pages. Pages are walked by the immutable key instead (id > last id),
// so updates, deletes and the page size never change what was already read; the order the caller
// asked for is applied afterwards, with id as the tiebreak, exactly as the database would.
// Tables without an id column are small state tables keyed by their primary key, which never
// changes: they are paged in primary-key order.
const PAGE_KEYS = {
  conversation_ai_attempt_state: ['environment', 'journey_id', 'chat_id'],
  panel_identity_state: ['environment', 'journey_id'],
  panel_conversation_class: ['environment', 'journey_id'],
  conversation_ai_link_state: ['environment', 'journey_id', 'chat_id'],
  conversation_general_read_progress: ['environment', 'journey_id', 'chat_id'],
  conversation_pending_insights: ['environment', 'journey_id', 'chat_id'],
  conversation_pending_resolutions: ['environment', 'journey_id', 'chat_id'],
  whatsapp_user_ids: ['environment', 'bsuid'],
  whatsapp_address_book: ['environment', 'phone_e164'],
  whatsapp_message_ids: ['environment', 'wa_message_id'],
  manheim_demand_syncs: ['environment', 'upload_id', 'demand_key', 'criteria_hash']
};
function topLevelFields(select) {
  const fields = [];
  let depth = 0, current = '';
  for (const char of String(select)) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) { fields.push(current.trim()); current = ''; } else current += char;
  }
  if (current.trim()) fields.push(current.trim());
  return fields;
}
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
// The database collation is ICU en-US (checked in production), the same as this collator.
const collator = new Intl.Collator('en-US');
function compareValues(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  const left = String(a), right = String(b);
  if (ISO_STAMP.test(left) && ISO_STAMP.test(right)) {
    const difference = Date.parse(left.replace(' ', 'T')) - Date.parse(right.replace(' ', 'T'));
    if (difference) return difference;
    // Same millisecond: compare the sub-millisecond digits the database keeps.
    const fraction = (value) => (value.match(/\.(\d+)/)?.[1] || '').padEnd(6, '0');
    return fraction(left) < fraction(right) ? -1 : fraction(left) > fraction(right) ? 1 : 0;
  }
  if (/^-?\d+(?:\.\d+)?$/.test(left) && /^-?\d+(?:\.\d+)?$/.test(right)) return Number(left) - Number(right);
  return collator.compare(left, right);
}
// PostgREST order syntax: "col.desc.nullslast,other.asc". Postgres puts nulls last when ascending
// and first when descending unless told otherwise.
function orderComparator(order, keys) {
  const terms = String(order || '').split(',').map((part) => part.trim()).filter(Boolean).map((part) => {
    const [column, ...flags] = part.split('.');
    const desc = flags.includes('desc');
    return { column, desc, nullsFirst: flags.includes('nullsfirst') || (desc && !flags.includes('nullslast')) };
  });
  keys.filter((key) => !terms.some((term) => term.column === key)).forEach((key) => terms.push({ column: key, desc: false, nullsFirst: false }));
  return (a, b) => {
    for (const term of terms) {
      const left = a[term.column], right = b[term.column];
      const leftNull = left === null || left === undefined, rightNull = right === null || right === undefined;
      if (leftNull || rightNull) {
        if (leftNull && rightNull) continue;
        return leftNull === term.nullsFirst ? -1 : 1;
      }
      const result = compareValues(left, right);
      if (result) return term.desc ? -result : result;
    }
    return 0;
  };
}
async function allRows(ctx, table, params = {}, pageSize = 1000) {
  const { order, ...filters } = params;
  const keys = PAGE_KEYS[table] || ['id'];
  const fields = filters.select ? topLevelFields(filters.select) : ['*'];
  // The order columns are read too (then removed), so the sort never runs on absent values.
  const orderColumns = String(order || '').split(',').map((part) => part.trim().split('.')[0]).filter(Boolean);
  const missing = fields.includes('*') ? [] : [...new Set([...keys, ...orderColumns])].filter((key) => !fields.includes(key));
  const select = missing.length ? fields.concat(missing).join(',') : filters.select;
  const request = { ...filters, ...(select ? { select } : {}) };
  const result = [];
  if (keys.length === 1) {
    const [key] = keys;
    let last = null;
    for (;;) {
      // A caller filter on the key itself (never used today) is kept: the cursor then goes in "and".
      const cursor = last === null ? {} : key in request ? { and: '(' + key + '.gt.' + last + ')' } : { [key]: 'gt.' + last };
      const page = await rows(ctx, table, { ...request, ...cursor, order: key + '.asc', limit: String(pageSize) });
      result.push(...page);
      if (page.length < pageSize) break;
      last = page[page.length - 1][key];
    }
  } else {
    for (let offset = 0; ; offset += pageSize) {
      const page = await rows(ctx, table, { ...request, order: keys.map((key) => key + '.asc').join(','), limit: String(pageSize), offset: String(offset) });
      result.push(...page);
      if (page.length < pageSize) break;
    }
  }
  if (order) result.sort(orderComparator(order, keys));
  if (missing.length) result.forEach((row) => missing.forEach((key) => { delete row[key]; }));
  return result;
}

// One database function (RPC), with the service key. Business errors keep their code.
async function rpc(ctx, name, args) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/' + name, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args || {})
  });
}
// A read that is the same for every list: inside one /api/panel/boot call it runs once and serves every list (each
// caller gets its own copy), like readRows. Outside a boot it simply runs.
function memoRead(ctx, key, load) {
  if (!ctx.readCache) return load();
  if (!ctx.readCache.has(key)) ctx.readCache.set(key, load().catch((error) => { ctx.readCache.delete(key); throw error; }));
  return ctx.readCache.get(key).then((value) => structuredClone(value));
}
// A read-only database function, shared inside one boot (same name and arguments = one call).
const readRpc = (ctx, name, args) => memoRead(ctx, 'rpc:' + name + ':' + JSON.stringify(args || {}), () => rpc(ctx, name, args));

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
  const [latestImport,latestMessage] = await Promise.all([rows(ctx, 'import_jobs', {
    select: 'completed_at', environment: 'eq.' + ctx.environment,
    channel: 'eq.WHATSAPP', completed_at: 'not.is.null', order: 'completed_at.desc', limit: '1'
  }),rows(ctx,'messages',{
    select:'occurred_at_utc,created_at',environment:'eq.'+ctx.environment,channel:'eq.WHATSAPP',
    source_kind:'in.(WHATSAPP_ZIP,WHATSAPP_TXT,WHATSAPP_HISTORY,WHATSAPP_WEBHOOK,IMPORT)',order:'occurred_at_utc.desc',limit:'1'
  })]);
  // The prepaid balance of each AI (no internal ceiling): the header warns at 20% left or when the
  // provider said there is no balance.
  const [openai,anthropic]=await Promise.all(['OPENAI','ANTHROPIC'].map((provider)=>rpc(ctx,'panel_ai_balance_state',{p_environment:ctx.environment,p_provider:provider}).catch(()=>null)));
  const brief=(state)=>state?{balanceUsd:state.balance===null||state.balance===undefined?null:Number(state.balance),spentUsd:Math.round(Number(state.spent||0)*1e4)/1e4,
    remainingUsd:state.remaining===null||state.remaining===undefined?null:Math.round(Number(state.remaining)*1e4)/1e4,warn:Boolean(state.warn),warnAtUsd:state.warnAt===undefined||state.warnAt===null?null:Number(state.warnAt),exhausted:Boolean(state.exhausted),informed:Boolean(state.informed),sinceStart:Boolean(state.sinceStart),priorUnknown:Boolean(state.priorUnknown),priorCalls:state.priorCalls===undefined||state.priorCalls===null?null:Number(state.priorCalls),priorFrom:state.priorFrom||null,priorTo:state.priorTo||null}:null;
  return { dataUpdatedAt: new Date().toISOString(), lastWhatsAppImportAt: latestImport[0] ? latestImport[0].completed_at : null,
    lastWhatsAppMessageAt:latestMessage[0]&&(latestMessage[0].occurred_at_utc||latestMessage[0].created_at)||null,
    ai: openai||anthropic?{ openai:brief(openai), anthropic:brief(anthropic) }:null };
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
  // A list called from inside /api/panel/boot reuses the session already checked there (and its shared reads).
  if (req && req.__mcsCtx) return req.__mcsCtx;
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
  SERVER_ENVIRONMENT, allRows, orderComparator, bearer, configuration, insert, isUuid, jsonBody,
  memoRead, panelMeta, patchRows, query, readRpc, recordMutation, requirePanel, rows, rpc, safeText, send,
  supabase
};

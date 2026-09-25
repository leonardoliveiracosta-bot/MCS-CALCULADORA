'use strict';

const crypto = require('crypto');
const { requirePanel, send, supabase } = require('../../panel-server');

const json = async (req) => {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const now = () => new Date().toISOString();
const query = (params) => new URLSearchParams(params).toString();

async function rows(ctx, table, params) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table + '?' + query(params));
}

async function createJob(ctx, body) {
  const sourceKind = ['WHATSAPP_ZIP', 'WHATSAPP_TXT', 'SMS_PASTE'].includes(body.sourceKind) ? body.sourceKind : null;
  const chat = body.chat || {};
  if (!sourceKind || !['WHATSAPP', 'SMS'].includes(chat.channel) || !String(chat.canonicalKey || '').trim()) {
    return send(ctx.res, 400, { error: 'IMPORT_METADATA_INVALID' });
  }
  let contactId = chat.contactId || null;
  if (chat.newContactName && !contactId) {
    const name = String(chat.newContactName).trim();
    if (!name) return send(ctx.res, 400, { error: 'CONTACT_NAME_REQUIRED' });
    const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({ environment: ctx.environment, display_name: name, source: 'SMS_DIRECT', created_at: now(), updated_at: now(), created_by: ctx.panel.id, updated_by: ctx.panel.id })
    });
    contactId = created[0].id;
  }
  if (contactId) {
    const contacts = await rows(ctx, 'contacts', { select: 'id', environment: 'eq.' + ctx.environment, id: 'eq.' + contactId, limit: '1' });
    if (!contacts[0]) return send(ctx.res, 400, { error: 'CONTACT_NOT_FOUND' });
  }
  const isGroup = Boolean(chat.isGroup);
  const newChat = {
    environment: ctx.environment, channel: chat.channel, canonical_key: String(chat.canonicalKey).trim(),
    contact_id: contactId, resolution_status: isGroup ? 'GROUP' : contactId ? 'RESOLVED' : 'UNIDENTIFIED',
    is_group: isGroup, first_seen_at: now(), last_seen_at: now(), created_at: now(), updated_at: now()
  };
  let chatRows = await supabase(ctx.config.url, ctx.config.secretKey,
    '/rest/v1/chats?on_conflict=environment,channel,canonical_key', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(newChat)
    });
  if (!chatRows[0]) chatRows = await rows(ctx, 'chats', {
    select: 'id,contact_id,resolution_status,is_group', environment: 'eq.' + ctx.environment,
    channel: 'eq.' + chat.channel, canonical_key: 'eq.' + newChat.canonical_key, limit: '1'
  });
  const storedChat = chatRows[0];
  if (!storedChat) return send(ctx.res, 500, { error: 'CHAT_CREATE_FAILED' });
  const job = {
    environment: ctx.environment, channel: chat.channel, source_kind: sourceKind,
    source_filename: String(body.sourceFilename || '').slice(0, 255) || null,
    source_sha256: String(body.sourceSha256 || '').slice(0, 128) || null,
    status: isGroup ? 'REVIEW' : 'PROCESSING', selected_file_count: 1,
    review_reason: isGroup ? 'grupo do WhatsApp exige revisão' : null, created_by: ctx.panel.id
  };
  const jobs = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(job)
  });
  return send(ctx.res, 201, { importJobId: jobs[0].id, chatId: storedChat.id, resolutionStatus: storedChat.resolution_status });
}

async function createReview(ctx, body) {
  const sourceKind = ['WHATSAPP_ZIP', 'WHATSAPP_TXT'].includes(body.sourceKind) ? body.sourceKind : null;
  if (!sourceKind) return send(ctx.res, 400, { error: 'IMPORT_METADATA_INVALID' });
  const jobs = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ environment: ctx.environment, channel: 'WHATSAPP', source_kind: sourceKind, source_filename: String(body.sourceFilename || '').slice(0, 255) || null, source_sha256: String(body.sourceSha256 || '').slice(0, 128) || null, status: 'REVIEW', message_count: 0, review_reason: 'formato não suportado', created_by: ctx.panel.id, completed_at: now() })
  });
  return send(ctx.res, 201, { importJobId: jobs[0].id, status: 'REVIEW' });
}

async function receiveBatch(ctx, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (!messages.length || messages.length > 500 || bytes > 1024 * 1024) return send(ctx.res, 400, { error: 'IMPORT_BATCH_LIMIT' });
  const payload = {
    p_environment: ctx.environment, p_import_job_id: body.importJobId,
    p_batch_number: Number(body.batchNumber),
    p_payload_sha256: crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'), p_messages: messages
  };
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_reconcile_import_batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  return send(ctx.res, 200, { inserted: result[0] ? result[0].inserted_count : 0, alreadyPresent: result[0] ? result[0].already_present_count : 0 });
}

async function finishJob(ctx, body) {
  const jobs = await rows(ctx, 'import_jobs', { select: 'id', id: 'eq.' + body.importJobId, environment: 'eq.' + ctx.environment, limit: '1' });
  if (!jobs[0]) return send(ctx.res, 404, { error: 'IMPORT_JOB_NOT_FOUND' });
  const chats = await supabase(ctx.config.url, ctx.config.secretKey,
    '/rest/v1/messages?select=chat:chats(resolution_status)&environment=eq.' + encodeURIComponent(ctx.environment) + '&import_job_id=eq.' + encodeURIComponent(body.importJobId));
  const pending = chats.some((item) => item.chat && ['UNIDENTIFIED', 'REVIEW', 'GROUP'].includes(item.chat.resolution_status));
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs?id=eq.' + encodeURIComponent(body.importJobId), {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ status: pending ? 'REVIEW' : 'COMPLETED', completed_at: now(), review_reason: pending ? 'conversa exige identificação ou revisão' : null })
  });
  return send(ctx.res, 200, { pending, destination: pending ? 'ENTRADA' : 'HOJE' });
}

async function queue(ctx, res) {
  const chats = await rows(ctx, 'chats', {
    select: 'id,channel,canonical_key,resolution_status,is_group,last_seen_at,contact:contacts(display_name)', environment: 'eq.' + ctx.environment,
    or: '(resolution_status.eq.UNIDENTIFIED,resolution_status.eq.REVIEW,resolution_status.eq.GROUP)', order: 'last_seen_at.desc', limit: '100'
  });
  const messages = await rows(ctx, 'messages', { select: 'chat_id', environment: 'eq.' + ctx.environment, limit: '10000' });
  const counts = messages.reduce((all, message) => { all[message.chat_id] = (all[message.chat_id] || 0) + 1; return all; }, {});
  const contacts = await rows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment, order: 'display_name.asc', limit: '1000' });
  const reviews = await rows(ctx, 'import_jobs', { select: 'id,source_filename,review_reason', environment: 'eq.' + ctx.environment, status: 'eq.REVIEW', review_reason: 'eq.formato não suportado', order: 'created_at.desc', limit: '100' });
  return send(res, 200, { chats: chats.map((chat) => ({ ...chat, newMessageCount: counts[chat.id] || 0 })), reviews, contacts });
}

async function resolveChat(ctx, body) {
  const chatId = String(body.chatId || '');
  let contactId = body.contactId || null;
  if (body.resolution === 'new') {
    const name = String(body.displayName || '').trim();
    if (!name) return send(ctx.res, 400, { error: 'CONTACT_NAME_REQUIRED' });
    const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({ environment: ctx.environment, display_name: name, source: 'WHATSAPP_DIRECT', created_at: now(), updated_at: now(), created_by: ctx.panel.id, updated_by: ctx.panel.id })
    });
    contactId = created[0].id;
  }
  if (body.resolution === 'existing' && !contactId) return send(ctx.res, 400, { error: 'CONTACT_REQUIRED' });
  if (body.resolution === 'discard') {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats?id=eq.' + encodeURIComponent(chatId) + '&environment=eq.' + ctx.environment, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ resolution_status: 'REVIEW', updated_at: now() })
    });
    return send(ctx.res, 200, { status: 'REVIEW' });
  }
  const allowed = await rows(ctx, 'contacts', { select: 'id', id: 'eq.' + contactId, environment: 'eq.' + ctx.environment, limit: '1' });
  if (!allowed[0]) return send(ctx.res, 400, { error: 'CONTACT_NOT_FOUND' });
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats?id=eq.' + encodeURIComponent(chatId) + '&environment=eq.' + ctx.environment, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ contact_id: contactId, resolution_status: 'RESOLVED', updated_at: now() })
  });
  if (body.aliasText) {
    const alias = String(body.aliasText).trim();
    if (alias) await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chat_aliases?on_conflict=environment,chat_id,alias_normalized', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ environment: ctx.environment, chat_id: chatId, alias_text: alias, alias_normalized: alias.normalize('NFC').toLocaleLowerCase('pt-BR'), first_seen_at: now(), last_seen_at: now(), confirmed_at: now(), confirmed_by: ctx.panel.id, created_at: now() })
    });
  }
  return send(ctx.res, 200, { status: 'RESOLVED' });
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  try {
    if (req.method === 'GET') return queue(ctx, res);
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await json(req);
    if (body.action === 'start') return createJob(ctx, body);
    if (body.action === 'review') return createReview(ctx, body);
    if (body.action === 'batch') return receiveBatch(ctx, body);
    if (body.action === 'finish') return finishJob(ctx, body);
    if (body.action === 'resolve') return resolveChat(ctx, body);
    return send(res, 400, { error: 'IMPORT_ACTION_INVALID' });
  } catch (error) {
    console.error('panel entry request failed', { code: error.message.slice(0, 80) });
    return send(res, 500, { error: 'IMPORT_REQUEST_FAILED' });
  }
};

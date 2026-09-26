'use strict';

const crypto = require('crypto');
const { requirePanel, send, supabase, isUuid } = require('../../panel-server');
const BUCKET = 'mcs-panel-attachments';
const MAX_BYTES = 10 * 1024 * 1024;

const body = async (req) => {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const safeName = (value) => String(value || 'arquivo').normalize('NFC').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'arquivo';
const pathForApi = (value) => String(value).split('/').map(encodeURIComponent).join('/');

function detectAttachment(name, declaredMime, size, head) {
  const lower = safeName(name).toLowerCase();
  if (size < 1 || size > MAX_BYTES || /\.svg$|\.html?$/.test(lower) || /svg|html/i.test(declaredMime || '')) return null;
  const bytes = Buffer.isBuffer(head) ? head : Buffer.from(head || '', 'base64');
  if (/\.jpe?g$/.test(lower) && declaredMime === 'image/jpeg' && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (/\.png$/.test(lower) && declaredMime === 'image/png' && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (/\.webp$/.test(lower) && declaredMime === 'image/webp' && bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (/\.pdf$/.test(lower) && declaredMime === 'application/pdf' && bytes.length >= 5 && bytes.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  return null;
}

async function removeObject(ctx, storagePath) {
  if (!storagePath) return;
  await supabase(ctx.config.url, ctx.config.secretKey, '/storage/v1/object/' + BUCKET + '/' + pathForApi(storagePath), { method: 'DELETE' }).catch(() => null);
}

async function validateRelation(ctx, table, id) {
  if (id == null || id === '') return null;
  if (!isUuid(id)) return false;
  const rows = await supabase(ctx.config.url, ctx.config.secretKey,
    '/rest/v1/' + table + '?select=id&id=eq.' + encodeURIComponent(id) + '&environment=eq.' + encodeURIComponent(ctx.environment) + '&limit=1');
  return rows[0] ? id : false;
}

async function handler(req, res) {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  let quarantinePath = null;
  let canonicalPath = null;
  let moved = false;
  try {
    const input = await body(req);
    if (input.action === 'download') {
      if (!isUuid(input.attachmentId)) return send(res, 400, { error: 'ATTACHMENT_ID_INVALID' });
      const found = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/attachments?select=id,bucket_name,storage_path,journey_id,contact_id&id=eq.' + encodeURIComponent(input.attachmentId) + '&environment=eq.' + encodeURIComponent(ctx.environment) + '&limit=1');
      if (!found[0]) return send(res, 404, { error: 'ATTACHMENT_NOT_FOUND' });
      const signed = await supabase(ctx.config.url, ctx.config.secretKey, '/storage/v1/object/sign/' + found[0].bucket_name + '/' + pathForApi(found[0].storage_path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expiresIn: 300 }) });
      return send(res, 200, { url: ctx.config.url + '/storage/v1' + signed.signedURL, expiresIn: 300 });
    }
    if (input.action === 'sign') {
      const detected = detectAttachment(input.filename, input.mimeType, Number(input.byteSize), input.magicBase64);
      if (!detected) return send(res, 400, { error: 'ATTACHMENT_REJECTED' });
      const id = crypto.randomUUID();
      const filename = safeName(input.filename);
      quarantinePath = `quarantine/${ctx.environment}/${id}/${filename}`;
      const signed = await supabase(ctx.config.url, ctx.config.secretKey,
        '/storage/v1/object/upload/sign/' + BUCKET + '/' + pathForApi(quarantinePath), {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
        });
      const uploadUrl=signed.url.startsWith('http')?signed.url:ctx.config.url+'/storage/v1'+signed.url;
      return send(res, 201, { attachmentId: id, filename, quarantinePath, uploadUrl, token: signed.token });
    }
    if (input.action !== 'finalize') return send(res, 400, { error: 'ATTACHMENT_ACTION_INVALID' });
    if (!isUuid(input.attachmentId)) return send(res, 400, { error: 'ATTACHMENT_ID_INVALID' });
    const filename = safeName(input.filename);
    quarantinePath = `quarantine/${ctx.environment}/${input.attachmentId}/${filename}`;
    if (String(input.quarantinePath || '') !== quarantinePath) {
      await removeObject(ctx, quarantinePath);
      return send(res, 400, { error: 'ATTACHMENT_PATH_INVALID' });
    }

    const relationSpecs = [['contacts', input.contactId], ['chats', input.chatId], ['journeys', input.journeyId], ['messages', input.messageId]];
    const validated = {};
    for (const [table, id] of relationSpecs) {
      const value = await validateRelation(ctx, table, id);
      if (value === false) {
        await removeObject(ctx, quarantinePath);
        return send(res, 400, { error: 'ATTACHMENT_RELATION_INVALID' });
      }
      validated[table] = value;
    }
    if (!validated.contacts && !validated.journeys) {
      await removeObject(ctx, quarantinePath);
      return send(res, 400, { error: 'ATTACHMENT_LEAD_REQUIRED' });
    }
    if (validated.contacts && validated.journeys) {
      const relation = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/journeys?select=id&id=eq.' + encodeURIComponent(validated.journeys) + '&contact_id=eq.' + encodeURIComponent(validated.contacts) + '&environment=eq.' + encodeURIComponent(ctx.environment) + '&limit=1');
      if (!relation[0]) { await removeObject(ctx, quarantinePath); return send(res, 400, { error: 'ATTACHMENT_RELATION_INVALID' }); }
    }

    const object = await fetch(ctx.config.url + '/storage/v1/object/' + BUCKET + '/' + pathForApi(quarantinePath), {
      headers: { apikey: ctx.config.secretKey, authorization: 'Bearer ' + ctx.config.secretKey }
    });
    if (!object.ok) {
      await removeObject(ctx, quarantinePath);
      return send(res, 400, { error: 'ATTACHMENT_UPLOAD_NOT_FOUND' });
    }
    const bytes = Buffer.from(await object.arrayBuffer());
    const actualMime = detectAttachment(filename, input.mimeType, bytes.length, bytes.subarray(0, 64));
    if (!actualMime) {
      await removeObject(ctx, quarantinePath);
      return send(res, 400, { error: 'ATTACHMENT_REJECTED' });
    }

    canonicalPath = `panel/${ctx.environment}/${input.attachmentId}/${filename}`;
    await supabase(ctx.config.url, ctx.config.secretKey, '/storage/v1/object/move', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bucketId: BUCKET, sourceKey: quarantinePath, destinationKey: canonicalPath })
    });
    moved = true;
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const stored = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/attachments', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({
        id: input.attachmentId, environment: ctx.environment, kind: actualMime === 'application/pdf' ? 'PDF' : 'IMAGE', bucket_name: BUCKET,
        storage_path: canonicalPath, original_filename: filename, mime_type: actualMime,
        byte_size: bytes.length, sha256: digest, verified_at: new Date().toISOString(),
        created_at: new Date().toISOString(), created_by: ctx.panel.id,
        chat_id: validated.chats, contact_id: validated.contacts,
        journey_id: validated.journeys, message_id: validated.messages
      })
    });
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/activity_log', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ environment: ctx.environment, journey_id: validated.journeys, contact_id: validated.contacts, activity_type: 'ATTACHMENT_ADDED', summary: 'Anexo adicionado: ' + filename, metadata: { attachmentId: stored[0].id }, occurred_at: new Date().toISOString(), actor_user_id: ctx.panel.id })
    });
    return send(res, 201, { attachmentId: stored[0].id });
  } catch (_) {
    await removeObject(ctx, moved ? canonicalPath : quarantinePath);
    return send(res, 500, { error: 'ATTACHMENT_REQUEST_FAILED' });
  }
}

module.exports = handler;
module.exports.validateAttachment = detectAttachment;
module.exports.safeName = safeName;
module.exports.pathForApi = pathForApi;

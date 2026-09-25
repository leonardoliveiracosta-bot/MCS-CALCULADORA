'use strict';

const crypto = require('crypto');
const { requirePanel, send, supabase } = require('../../panel-server');
const BUCKET = 'mcs-panel-attachments';
const MAX_BYTES = 10 * 1024 * 1024;

const body = async (req) => {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  let raw = ''; for await (const chunk of req) raw += chunk; return raw ? JSON.parse(raw) : {};
};
const safeName = (value) => String(value || 'arquivo').normalize('NFC').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'arquivo';
function allowed(name, mime, size, head) {
  const lower = safeName(name).toLowerCase();
  if (size < 1 || size > MAX_BYTES || /\.svg$|\.html?$/.test(lower) || /svg|html/i.test(mime)) return false;
  const bytes = Buffer.from(head || '', 'base64');
  if (mime === 'image/jpeg') return /\.jpe?g$/.test(lower) && bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return /\.png$/.test(lower) && bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return /\.webp$/.test(lower) && bytes.length >= 12 && bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP';
  return false;
}

async function handler(req, res) {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const input = await body(req);
    if (input.action === 'sign') {
      if (!allowed(input.filename, input.mimeType, Number(input.byteSize), input.magicBase64)) return send(res, 400, { error: 'ATTACHMENT_REJECTED' });
      const id = crypto.randomUUID(); const filename = safeName(input.filename);
      const quarantinePath = 'quarantine/' + ctx.environment + '/' + id + '/' + filename;
      const signed = await supabase(ctx.config.url, ctx.config.secretKey, '/storage/v1/object/upload/sign/' + BUCKET + '/' + encodeURIComponent(quarantinePath), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
      });
      return send(res, 201, { attachmentId: id, filename, quarantinePath, uploadUrl: signed.url, token: signed.token });
    }
    if (input.action !== 'finalize') return send(res, 400, { error: 'ATTACHMENT_ACTION_INVALID' });
    const filename = safeName(input.filename); const quarantinePath = String(input.quarantinePath || '');
    const prefix = 'quarantine/' + ctx.environment + '/' + input.attachmentId + '/';
    if (!quarantinePath.startsWith(prefix)) return send(res, 400, { error: 'ATTACHMENT_PATH_INVALID' });
    const object = await fetch(ctx.config.url + '/storage/v1/object/' + BUCKET + '/' + quarantinePath, { headers: { apikey: ctx.config.secretKey, authorization: 'Bearer ' + ctx.config.secretKey } });
    const bytes = Buffer.from(await object.arrayBuffer());
    const actualMime = object.headers.get('content-type') || input.mimeType;
    if (!object.ok || !allowed(filename, actualMime, bytes.length, bytes.subarray(0, 64).toString('base64'))) {
      await supabase(ctx.config.url, ctx.config.secretKey, '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(quarantinePath), { method: 'DELETE' }).catch(() => null);
      return send(res, 400, { error: 'ATTACHMENT_REJECTED' });
    }
    const storagePath = 'panel/' + ctx.environment + '/' + input.attachmentId + '/' + filename;
    await supabase(ctx.config.url, ctx.config.secretKey, '/storage/v1/object/move', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bucketId: BUCKET, sourceKey: quarantinePath, destinationKey: storagePath })
    });
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const stored = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/attachments', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({ id: input.attachmentId, environment: ctx.environment, kind: 'IMAGE', bucket_name: BUCKET, storage_path: storagePath, original_filename: filename, mime_type: actualMime, byte_size: bytes.length, sha256: digest, verified_at: new Date().toISOString(), created_at: new Date().toISOString(), created_by: ctx.panel.id, chat_id: input.chatId || null, contact_id: input.contactId || null })
    });
    return send(res, 201, { attachmentId: stored[0].id });
  } catch (error) {
    console.error('panel attachment request failed', { code: error.message.slice(0, 80) });
    return send(res, 500, { error: 'ATTACHMENT_REQUEST_FAILED' });
  }
}

module.exports = handler;
module.exports.validateAttachment = allowed;

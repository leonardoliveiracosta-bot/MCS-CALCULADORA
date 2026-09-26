'use strict';
const crypto = require('node:crypto');
function digest(secret, ref, note, items) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify([ref, note, items])).digest('hex');
}
function verified(secret, ref, note, items, signature) {
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest(secret, ref, note, items)));
}
function validItems(note, items) {
  const types = new Set(['call_result','checklist','budget','payment','deadline','wishlist','phone','promise','return','stage','disable']);
  return (Array.isArray(items) ? items : []).slice(0, 30).filter((item) => item && types.has(item.type)
    && typeof item.evidence === 'string' && item.evidence.trim().length >= 2 && note.includes(item.evidence));
}
module.exports = { digest, verified, validItems };

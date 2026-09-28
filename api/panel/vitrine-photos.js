'use strict';

// Fotos da V2. O navegador reduz para ~1600px JPEG e envia uma foto por vez, em ordem
// (a primeira vira a capa). Guarda em vitrine-photos/<vitrine_id>/<uuid>.jpg e anexa em photo_paths.
const crypto = require('node:crypto');
const { isUuid, patchRows, requirePanel, rows, send } = require('../../panel-server');

const BUCKET = 'vitrine-photos';
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_PHOTOS = 12;

function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function readBody(req, maximum = MAX_BYTES) {
  if (Buffer.isBuffer(req.body)) { if (req.body.length > maximum) throw Object.assign(Error('PHOTO_TOO_LARGE'), { status: 413 }); return req.body; }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maximum) throw Object.assign(Error('PHOTO_TOO_LARGE'), { status: 413 });
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function upload(ctx, path, buffer, contentType) {
  const response = await fetch(ctx.config.url + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: ctx.config.secretKey, authorization: 'Bearer ' + ctx.config.secretKey, 'content-type': contentType, 'x-upsert': 'false' },
    body: buffer
  });
  if (!response.ok) throw Error('PHOTO_UPLOAD_FAILED');
}

async function savePhoto(ctx, { vitrineId, carId, buffer }, services = { rows, patchRows, upload }) {
  if (!isUuid(vitrineId) || !isUuid(carId)) return { status: 400, error: 'PHOTO_TARGET_INVALID' };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { status: 400, error: 'PHOTO_EMPTY' };
  if (buffer.length > MAX_BYTES) return { status: 413, error: 'PHOTO_TOO_LARGE' };
  const type = imageType(buffer);
  if (!type) return { status: 415, error: 'PHOTO_NOT_IMAGE' };
  // o carro precisa pertencer a esta vitrine, no ambiente do painel
  const [car] = await services.rows(ctx, 'vitrine_cars', { select: 'id,vitrine_id,photo_paths', environment: 'eq.' + ctx.environment, id: 'eq.' + carId, vitrine_id: 'eq.' + vitrineId, limit: '1' });
  if (!car) return { status: 404, error: 'PHOTO_TARGET_NOT_FOUND' };
  const current = Array.isArray(car.photo_paths) ? car.photo_paths : [];
  if (current.length >= MAX_PHOTOS) return { status: 409, error: 'PHOTO_LIMIT_REACHED' };
  const path = vitrineId + '/' + crypto.randomUUID() + '.jpg';
  await services.upload(ctx, path, buffer, type);
  const photoPaths = [...current, path];
  await services.patchRows(ctx, 'vitrine_cars', { id: 'eq.' + car.id, environment: 'eq.' + ctx.environment, vitrine_id: 'eq.' + vitrineId }, { photo_paths: photoPaths });
  return { status: 201, path, photoCount: photoPaths.length };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const buffer = await readBody(req);
    const out = await savePhoto(ctx, { vitrineId: String(req.query?.vitrineId || ''), carId: String(req.query?.carId || ''), buffer });
    return out.error ? send(res, out.status, { error: out.error }) : send(res, 201, { path: out.path, photoCount: out.photoCount });
  } catch (error) {
    return send(res, error.status === 413 ? 413 : 500, { error: error.status === 413 ? 'PHOTO_TOO_LARGE' : 'PHOTO_UNAVAILABLE' });
  }
};
module.exports.imageType = imageType;
module.exports.savePhoto = savePhoto;
module.exports.MAX_BYTES = MAX_BYTES;

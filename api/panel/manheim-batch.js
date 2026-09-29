'use strict';

// Importação do Manheim em alto volume: todos os CSVs selecionados juntos formam UM lote,
// enviado em blocos e ativado só no fim.
//  GET                     o último lote ativo (só o tamanho), para a confirmação de lote menor
//  POST start              cria ou retoma o lote (mesma seleção de arquivos = mesmo lote)
//  POST chunk              um bloco de até 500 carros de um arquivo; reenviar não duplica
//  POST status             blocos já confirmados, para retomar do ponto em que parou
//  POST finalize           ativa o lote inteiro de uma vez (nunca pela metade)
//  POST cancel             cancela um lote ainda em montagem (nada é apagado)
// Nenhuma chamada paga e nenhuma mensagem saem daqui.
const crypto = require('node:crypto');
const { isUuid, jsonBody, requirePanel, rows, rpc, send } = require('../../panel-server');
const { batchSupported, latestActiveUpload } = require('../../panel-manheim-state');
const { loadMatchTargets } = require('../../panel-buscas-view');
const batch = require('../../panel-manheim-batch');

const BODY_LIMIT = 1500 * 1024;
const text = (value, max) => String(value === null || value === undefined ? '' : value).normalize('NFC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

function startInput(body) {
  const files = Array.isArray(body.files) ? body.files : null;
  const vehicleCount = Number(body.vehicleCount);
  const clientKey = String(body.clientKey || '');
  if (!files || !files.length || files.length > 20 || !/^[0-9a-f]{16,64}$/.test(clientKey) || !Number.isInteger(vehicleCount) || vehicleCount < 0 || vehicleCount > 100000) return null;
  const cleanFiles = files.map((file) => ({
    name: text(file && file.name, 200), size: Math.max(0, Math.round(Number(file && file.size) || 0)),
    rowCount: Math.max(0, Math.round(Number(file && file.rowCount) || 0)), vehicleCount: Math.max(0, Math.round(Number(file && file.vehicleCount) || 0)),
    chunkCount: Math.round(Number(file && file.chunkCount))
  }));
  if (cleanFiles.some((file) => !file.name || !Number.isInteger(file.chunkCount) || file.chunkCount < 0 || file.chunkCount > 1000 || file.vehicleCount > file.chunkCount * batch.CHUNK_VEHICLES)) return null;
  const headers = Array.isArray(body.headers) ? body.headers.map((group) => Array.isArray(group) ? group.map((entry) => text(entry, 160)).filter(Boolean).slice(0, 100) : []).filter((group) => group.length).slice(0, 20) : [];
  const headerMap = body.headerMap && typeof body.headerMap === 'object' && !Array.isArray(body.headerMap) ? body.headerMap : {};
  if (!headers.length || Buffer.byteLength(JSON.stringify(headerMap), 'utf8') > 64 * 1024) return null;
  return { files: cleanFiles, vehicleCount, clientKey, headers, headerMap };
}

async function actionStart(ctx, body) {
  const input = startInput(body);
  if (!input) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  // One snapshot of today's demands for every block of this batch (the same criterion for all).
  const targets = batch.snapshotTargets(await loadMatchTargets(ctx));
  const hash = batch.targetsHash(targets);
  const result = await rpc(ctx, 'panel_manheim_batch_start', {
    p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_client_key: input.clientKey, p_source_file_count: input.files.length,
    p_vehicle_count: input.vehicleCount, p_headers: input.headers, p_header_map: input.headerMap, p_files: input.files, p_targets: targets, p_targets_hash: hash
  });
  return send(ctx.res, result && result.resumed ? 200 : 201, { ...result, targetCount: targets.length });
}

async function stagingUpload(ctx, uploadId) {
  const [upload] = await rows(ctx, 'manheim_uploads', { select: 'id,activated_at,canceled_at,undone_at,files_json,targets_json', environment: 'eq.' + ctx.environment, id: 'eq.' + uploadId, created_by: 'eq.' + ctx.panel.id, limit: '1' });
  return upload || null;
}

// Parsed targets of a batch, kept for a few minutes per warm function (blocks come in sequence).
const targetCache = new Map();
function targetIndex(upload) {
  const cached = targetCache.get(upload.id);
  if (cached) return cached;
  const targets = Array.isArray(upload.targets_json) ? upload.targets_json : [];
  const value = { targets, index: batch.indexTargets(targets) };
  targetCache.set(upload.id, value);
  if (targetCache.size > 20) targetCache.delete(targetCache.keys().next().value);
  return value;
}

async function actionChunk(ctx, body) {
  const fileIndex = Number(body.fileIndex), chunkIndex = Number(body.chunkIndex);
  const vehicles = Array.isArray(body.vehicles) ? body.vehicles : null;
  if (!isUuid(body.uploadId) || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 19 || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 999
      || !vehicles || vehicles.length > batch.CHUNK_VEHICLES) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const upload = await stagingUpload(ctx, body.uploadId);
  if (!upload) return send(ctx.res, 404, { error: 'MANHEIM_UPLOAD_NOT_FOUND' });
  if (upload.canceled_at || upload.undone_at) return send(ctx.res, 409, { error: 'MANHEIM_BATCH_CANCELED' });
  const entries = vehicles.map(batch.sanitizeVehicle);
  const valid = entries.filter(Boolean);
  const { targets, index } = targetIndex(upload);
  const matches = batch.matchChunk(valid, targets, index);
  const result = await rpc(ctx, 'panel_manheim_batch_chunk', {
    p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: upload.id, p_file_index: fileIndex, p_chunk_index: chunkIndex,
    p_vehicles: valid.map((entry) => ({ fingerprint: entry.fingerprint, makeKey: entry.makeKey, mmrCents: entry.mmrCents, vehicle: entry.vehicle })), p_matches: matches
  });
  return send(ctx.res, 200, { ...result, ignored: entries.length - valid.length, withoutMmr: valid.filter((entry) => !entry.mmrCents).length });
}

async function actionStatus(ctx, body) {
  if (!isUuid(body.uploadId)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const upload = await stagingUpload(ctx, body.uploadId);
  if (!upload) return send(ctx.res, 404, { error: 'MANHEIM_UPLOAD_NOT_FOUND' });
  const chunks = await rows(ctx, 'manheim_upload_chunks', { select: 'file_index,chunk_index,stored_vehicle_count,match_count,discarded_count', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + upload.id, order: 'file_index.asc,chunk_index.asc', limit: '2000' });
  const files = (Array.isArray(upload.files_json) ? upload.files_json : []).map((file, fileIndex) => {
    const own = chunks.filter((chunk) => chunk.file_index === fileIndex);
    return { name: file.name, chunkCount: file.chunkCount, received: own.length, vehicles: own.reduce((sum, chunk) => sum + chunk.stored_vehicle_count, 0), matches: own.reduce((sum, chunk) => sum + chunk.match_count, 0) };
  });
  return send(ctx.res, 200, {
    uploadId: upload.id, state: upload.canceled_at ? 'CANCELED' : upload.activated_at ? 'ACTIVE' : 'STAGING', files,
    received: chunks.map((chunk) => [chunk.file_index, chunk.chunk_index]),
    discarded: chunks.reduce((sum, chunk) => sum + chunk.discarded_count, 0)
  });
}

async function actionFinalize(ctx, body) {
  if (!isUuid(body.uploadId)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const upload = await stagingUpload(ctx, body.uploadId);
  if (!upload) return send(ctx.res, 404, { error: 'MANHEIM_UPLOAD_NOT_FOUND' });
  const result = await rpc(ctx, 'panel_manheim_batch_finalize', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: upload.id });
  targetCache.delete(upload.id);
  const chunks = await rows(ctx, 'manheim_upload_chunks', { select: 'discarded_count', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + upload.id, limit: '2000' });
  return send(ctx.res, 200, { ...result, discarded: chunks.reduce((sum, chunk) => sum + chunk.discarded_count, 0) });
}

async function actionCancel(ctx, body) {
  if (!isUuid(body.uploadId)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const upload = await stagingUpload(ctx, body.uploadId);
  if (!upload) return send(ctx.res, 404, { error: 'MANHEIM_UPLOAD_NOT_FOUND' });
  targetCache.delete(upload.id);
  return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_batch_cancel', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: upload.id }));
}

const ACTIONS = { start: actionStart, chunk: actionChunk, status: actionStatus, finalize: actionFinalize, cancel: actionCancel };

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  try {
    if (!(await batchSupported(ctx, { rows }).catch(() => false))) return send(res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
    if (req.method === 'GET') {
      const latest = await latestActiveUpload(ctx, 'id,vehicle_count,uploaded_at,source_file_count');
      return send(res, 200, { latest: latest ? { id: latest.id, vehicleCount: latest.vehicle_count, uploadedAt: latest.uploaded_at, fileCount: latest.source_file_count } : null });
    }
    const body = await jsonBody(req, BODY_LIMIT);
    const action = ACTIONS[String(body && body.action || '')];
    if (!action) return send(res, 400, { error: 'MANHEIM_BATCH_ACTION_INVALID' });
    return await action(ctx, body);
  } catch (error) {
    if (error && error.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error && error.code || '')) ? error.code : null;
    if (code) return send(res, ['MANHEIM_UPLOAD_NOT_FOUND'].includes(code) ? 404 : code === 'MANHEIM_BATCH_INCOMPLETE' || code === 'MANHEIM_BATCH_CANCELED' || code === 'MANHEIM_BATCH_ALREADY_ACTIVE' ? 409 : 400, { error: code });
    const requestId = crypto.randomUUID().slice(0, 8);
    console.error('[manheim-batch]', { requestId, message: String(error && error.message || 'UNKNOWN') });
    return send(res, 500, { error: 'MANHEIM_BATCH_ERROR', requestId });
  }
};
module.exports.startInput = startInput;

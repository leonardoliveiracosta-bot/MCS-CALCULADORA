'use strict';

// Importação do Manheim em alto volume: todos os CSVs selecionados juntos formam UM lote,
// enviado em blocos e ativado só no fim.
//  GET                     o último lote ativo (só o tamanho), para a confirmação de lote menor
//  POST start              cria ou retoma o lote (mesma seleção de arquivos = mesmo lote)
//  POST chunk              um bloco de até 500 carros; vale pelo conteúdo (hash no manifesto):
//                          o mesmo bloco de novo não grava nada, conteúdo diferente é recusado
//  POST status             blocos já confirmados, para retomar do ponto em que parou
//  POST finalize           ativa o lote inteiro de uma vez (nunca pela metade); num acréscimo (start com
//                          append: true), junta os carros novos ao lote ativo, também de uma vez
//  POST cancel             cancela um lote ainda em montagem (nada é apagado)
//  POST visibility        ocultar ou mostrar um lote desfeito na lista deste operador (só exibição)
//  POST complement-*       os mesmos CSVs do lote ativo, lidos de novo, acrescentam só Lane, Run,
//                          Inventory, Status e Event Sale Name aos carros que o lote já tem:
//                          check (prévia, só leitura), start/stage (conferência depois da confirmação),
//                          apply (uma troca, tudo ou nada), result (totais, só leitura), cancel. Não cria lote; o carro
//                          que passa a ter Lane/Run ou Buy Now passa pela busca e, se servir, vira combinação na mesma
//                          troca (regra B). Não mexe em MMR, critérios, seleção, V1/V2, histórico nem nas combinações que já existem
// Nenhuma chamada paga e nenhuma mensagem saem daqui.
const crypto = require('node:crypto');
const { isUuid, jsonBody, requirePanel, rows, rpc, send, supabase } = require('../../panel-server');
const { batchSupported, latestActiveUpload } = require('../../panel-manheim-state');
const { loadMatchTargets } = require('../../panel-buscas-view');
const batch = require('../../panel-manheim-batch');

const BODY_LIMIT = 1500 * 1024;
const text = (value, max) => String(value === null || value === undefined ? '' : value).normalize('NFC').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

const HASH = /^[0-9a-f]{64}$/;
// The manifest (per file: name, size, cars and, per block, count and content hash) must be the one
// the browser hashed; the database checks the sums again.
function startInput(body) {
  const files = Array.isArray(body.files) ? body.files : null;
  const vehicleCount = Number(body.vehicleCount);
  const clientKey = String(body.clientKey || '');
  const manifestHash = String(body.manifestHash || '');
  if (!files || !files.length || files.length > 50 || !/^[0-9a-f]{16,64}$/.test(clientKey) || !HASH.test(manifestHash) || !Number.isInteger(vehicleCount) || vehicleCount < 0 || vehicleCount > 250000) return null;
  if (batch.contentHash(files) !== manifestHash) return null;
  const cleanFiles = files.map((file) => ({
    name: text(file && file.name, 200), size: Math.max(0, Math.round(Number(file && file.size) || 0)),
    rowCount: Math.max(0, Math.round(Number(file && file.rowCount) || 0)), vehicleCount: Math.round(Number(file && file.vehicleCount)),
    chunkCount: Math.round(Number(file && file.chunkCount)),
    chunks: Array.isArray(file && file.chunks) ? file.chunks.map((chunk) => ({ count: Math.round(Number(chunk && chunk.count)), hash: String(chunk && chunk.hash || '') })) : null
  }));
  if (cleanFiles.some((file) => !file.name || !Number.isInteger(file.chunkCount) || file.chunkCount < 0 || file.chunkCount > 1000 || !Number.isInteger(file.vehicleCount) || file.vehicleCount < 0
      || !file.chunks || file.chunks.length !== file.chunkCount
      || file.chunks.some((chunk) => !Number.isInteger(chunk.count) || chunk.count < 1 || chunk.count > batch.CHUNK_VEHICLES || !HASH.test(chunk.hash))
      || file.chunks.reduce((sum, chunk) => sum + chunk.count, 0) !== file.vehicleCount)) return null;
  if (cleanFiles.reduce((sum, file) => sum + file.vehicleCount, 0) !== vehicleCount) return null;
  const headers = Array.isArray(body.headers) ? body.headers.map((group) => Array.isArray(group) ? group.map((entry) => text(entry, 160)).filter(Boolean).slice(0, 100) : []).filter((group) => group.length).slice(0, 50) : [];
  const headerMap = body.headerMap && typeof body.headerMap === 'object' && !Array.isArray(body.headerMap) ? body.headerMap : {};
  if (!headers.length || Buffer.byteLength(JSON.stringify(headerMap), 'utf8') > 64 * 1024) return null;
  return { files: cleanFiles, vehicleCount, clientKey, manifestHash, headers, headerMap };
}

async function actionStart(ctx, body) {
  const input = startInput(body);
  if (!input) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  // Acrescentar ao lote ativo: precisa existir um lote ativo, e é sempre ele o alvo.
  const append = body.append === true;
  const target = append ? await latestActiveUpload(ctx, 'id') : null;
  if (append && !target) return send(ctx.res, 409, { error: 'MANHEIM_APPEND_NO_ACTIVE' });
  // One snapshot of today's demands for every block of this batch (the same criterion for all).
  const targets = batch.snapshotTargets(await loadMatchTargets(ctx));
  const hash = batch.targetsHash(targets);
  const result = await rpc(ctx, 'panel_manheim_batch_start', {
    p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_client_key: input.clientKey, p_vehicle_count: input.vehicleCount,
    p_headers: input.headers, p_header_map: input.headerMap, p_files: input.files, p_manifest_hash: input.manifestHash, p_targets: targets, p_targets_hash: hash
  });
  // Same files, but the content or the demands changed: never continue silently.
  if (result && result.mismatch) return send(ctx.res, 409, { error: 'MANHEIM_BATCH_RESUME_MISMATCH', uploadId: result.uploadId, reason: result.reason, received: result.received });
  if (append) await rpc(ctx, 'panel_manheim_batch_append_mark', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: result.uploadId, p_target_id: target.id });
  return send(ctx.res, result && result.resumed ? 200 : 201, { ...result, targetCount: targets.length, ...(append ? { appendTo: target.id } : {}) });
}

async function stagingUpload(ctx, uploadId) {
  const [upload] = await rows(ctx, 'manheim_uploads', { select: 'id,activated_at,canceled_at,undone_at,files_json,targets_json,append_to', environment: 'eq.' + ctx.environment, id: 'eq.' + uploadId, created_by: 'eq.' + ctx.panel.id, limit: '1' });
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
  if (!isUuid(body.uploadId) || !Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 49 || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 999
      || !vehicles || vehicles.length > batch.CHUNK_VEHICLES) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const upload = await stagingUpload(ctx, body.uploadId);
  if (!upload) return send(ctx.res, 404, { error: 'MANHEIM_UPLOAD_NOT_FOUND' });
  if (upload.canceled_at || upload.undone_at) return send(ctx.res, 409, { error: 'MANHEIM_BATCH_CANCELED' });
  // The hash of what arrived, recalculated here; the database compares it with the manifest.
  const chunkHash = batch.contentHash(vehicles);
  const entries = vehicles.map(batch.sanitizeVehicle);
  const valid = entries.filter(Boolean);
  await require('../../panel-model-aliases').load(ctx);
  const { targets, index } = targetIndex(upload);
  const matches = batch.matchChunk(valid, targets, index, { staging: true });
  const result = await rpc(ctx, 'panel_manheim_batch_chunk', {
    p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: upload.id, p_file_index: fileIndex, p_chunk_index: chunkIndex,
    p_chunk_hash: chunkHash, p_received_count: vehicles.length,
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
  // Acréscimo: junta ao lote ativo em vez de virar um lote novo.
  const finalizer = upload.append_to ? 'panel_manheim_batch_append_finalize' : 'panel_manheim_batch_finalize';
  const result = await rpc(ctx, finalizer, { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: upload.id });
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

// ------------------------------------------------------------ complemento do lote ativo
// The same CSVs of the active batch, read again, add only the sale data (Lane, Run, Inventory,
// Status, Event Sale Name). Every block is checked here against the batch manifest: the canonical
// hash of the block, recalculated from what arrived, must be the one stored at import (the sale data,
// which the old batch did not have, stays out of the hash). The database checks it again.
const SALE_FIELDS = [['lane', 20], ['run', 20], ['saleType', 80], ['saleStatus', 80], ['eventSaleName', 160]];
const SALE_KEYS = SALE_FIELDS.map(([key]) => key);
const withoutSale = (entry) => {
  const vehicle = { ...(entry && entry.vehicle) };
  SALE_KEYS.forEach((key) => { delete vehicle[key]; });
  return { ...entry, vehicle };
};
const fileSummary = (file) => ({
  name: text(file && file.name, 200), size: Math.round(Number(file && file.size) || 0), rowCount: Math.round(Number(file && file.rowCount) || 0),
  vehicleCount: Math.round(Number(file && file.vehicleCount) || 0), chunkCount: Math.round(Number(file && file.chunkCount) || 0), hash: batch.contentHash(file || null)
});
const pendingComplement = (error) => error && (error.status === 404 || /PGRST202|42883|42P01/.test(String(error.code || '') + String(error.message || '')));

async function complementBlock(ctx, body) {
  const fileIndex = Number(body.fileIndex), chunkIndex = Number(body.chunkIndex);
  const vehicles = Array.isArray(body.vehicles) ? body.vehicles : null;
  if (!Number.isInteger(fileIndex) || fileIndex < 0 || fileIndex > 49 || !Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex > 999 || !vehicles || !vehicles.length || vehicles.length > batch.CHUNK_VEHICLES) return { error: [400, 'MANHEIM_UPLOAD_INVALID'] };
  const latest = await latestActiveUpload(ctx, 'id,files_json');
  if (!latest || latest.id !== body.uploadId) return { error: [409, 'MANHEIM_COMPLEMENT_NOT_ACTIVE'] };
  const expected = latest.files_json && latest.files_json[fileIndex] && latest.files_json[fileIndex].chunks && latest.files_json[fileIndex].chunks[chunkIndex];
  // The hash as the batch was imported: without the sale data (older batch) or with it (newer batch).
  const stripped = batch.contentHash(vehicles.map(withoutSale));
  const chunkHash = expected && expected.hash === stripped ? stripped : batch.contentHash(vehicles);
  if (!expected || expected.hash !== chunkHash || Number(expected.count) !== vehicles.length) return { error: [409, 'MANHEIM_COMPLEMENT_MISMATCH'], fileIndex };
  // The same cars the import stored (the ones it ignored stay out), by the same stable identifier.
  const read = vehicles.map((source) => ({ source, entry: batch.sanitizeVehicle(source) })).filter(({ entry }) => entry);
  const items = read.map(({ source, entry }) => Object.fromEntries([['fingerprint', entry.fingerprint], ...SALE_FIELDS.map(([key, max]) => [key, text(source.vehicle[key], max)])]));
  return { fileIndex, chunkIndex, chunkHash, items, entries: read.map(({ entry }) => entry) };
}

// Rule B: a car that has sale data (Lane/Run or Buy Now) after the complement goes through the same
// search as a new batch, against today's demands. The database keeps the candidates in the conference
// and only adds them on "Complementar agora", skipping any combination that already exists. A car
// without sale data never matches (the rule itself requires it). One snapshot of the demands per
// complement, kept for a few minutes per warm function (blocks come in sequence).
const complementTargets = new Map();
async function complementMatches(ctx, runId, entries) {
  let cached = complementTargets.get(runId);
  if (!cached) {
    const targets = batch.snapshotTargets(await loadMatchTargets(ctx));
    cached = { targets, index: batch.indexTargets(targets) };
    complementTargets.set(runId, cached);
    if (complementTargets.size > 20) complementTargets.delete(complementTargets.keys().next().value);
  }
  await require('../../panel-model-aliases').load(ctx);
  return batch.matchChunk(entries, cached.targets, cached.index, { staging: true });
}
const complementKeys = (body) => /^[0-9a-f]{16,64}$/.test(String(body.clientKey || '')) && HASH.test(String(body.manifestHash || ''));

// Preview: read only, one block at a time.
async function actionComplementCheck(ctx, body) {
  if (!isUuid(body.uploadId) || !complementKeys(body)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const block = await complementBlock(ctx, body);
  if (block.error) return send(ctx.res, block.error[0], { error: block.error[1], fileIndex: block.fileIndex });
  return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_complement_check', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: body.uploadId,
    p_client_key: body.clientKey, p_manifest_hash: body.manifestHash, p_file_index: block.fileIndex, p_chunk_index: block.chunkIndex, p_chunk_hash: block.chunkHash, p_items: block.items }));
}
// After "Complementar agora": the blocks go to a conference area nobody reads.
async function actionComplementStart(ctx, body) {
  if (!isUuid(body.uploadId) || !complementKeys(body)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  if (body.confirmed !== true) return send(ctx.res, 400, { error: 'MANHEIM_COMPLEMENT_CONFIRM_REQUIRED' });
  return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_complement_start', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: body.uploadId, p_client_key: body.clientKey, p_manifest_hash: body.manifestHash }));
}
async function actionComplementStage(ctx, body) {
  if (!isUuid(body.uploadId) || !isUuid(body.runId)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const block = await complementBlock(ctx, body);
  if (block.error) {
    // A block that does not match cancels the whole complement (nothing was written to the batch).
    if (block.error[1] === 'MANHEIM_COMPLEMENT_MISMATCH') await rpc(ctx, 'panel_manheim_complement_cancel', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_run_id: body.runId, p_reason: 'BLOCK_MISMATCH' });
    return send(ctx.res, block.error[0], { error: block.error[1], fileIndex: block.fileIndex });
  }
  const result = await rpc(ctx, 'panel_manheim_complement_stage', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_run_id: body.runId,
    p_file_index: block.fileIndex, p_chunk_index: block.chunkIndex, p_chunk_hash: block.chunkHash, p_items: block.items, p_matches: await complementMatches(ctx, body.runId, block.entries) });
  if (result && result.error) return send(ctx.res, 409, { error: result.error, fileIndex: block.fileIndex });
  return send(ctx.res, 200, result);
}
// One transaction: everything or nothing.
async function actionComplementApply(ctx, body) {
  if (!isUuid(body.runId) || body.confirmed !== true) return send(ctx.res, 400, { error: body.confirmed === true ? 'MANHEIM_UPLOAD_INVALID' : 'MANHEIM_COMPLEMENT_CONFIRM_REQUIRED' });
  return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_complement_apply', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_run_id: body.runId }));
}
// Totals after the switch (read only, outside the write).
async function actionComplementResult(ctx, body) {
  if (!isUuid(body.uploadId)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_complement_result', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: body.uploadId }));
}
async function actionComplementCancel(ctx, body) {
  if (!isUuid(body.runId)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_complement_cancel', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_run_id: body.runId, p_reason: 'OPERATOR' }));
}
const COMPLEMENT_ACTIONS = new Set(['complement-check', 'complement-start', 'complement-stage', 'complement-apply', 'complement-result', 'complement-cancel']);

// ------------------------------------------------------------ histórico de lotes (só exibição)
// Hide or show an UNDONE batch in this operator's list. The batch itself never changes, and the
// active batch can never be hidden.
async function actionVisibility(ctx, body) {
  const op = String(body.op || '');
  if (!['hide', 'restore', 'hide_all'].includes(op) || (op !== 'hide_all' && !isUuid(body.uploadId))) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const keys = { environment: 'eq.' + ctx.environment, user_id: 'eq.' + ctx.panel.id };
  const pending = (error) => error && (error.status === 404 || /PGRST205|42P01/.test(String(error.code || '') + String(error.message || '')));
  try {
    if (op === 'restore') {
      await patchOrDelete(ctx, 'panel_batch_hidden', { ...keys, upload_id: 'eq.' + body.uploadId });
      return send(ctx.res, 200, { restored: true });
    }
    const undone = await rows(ctx, 'manheim_uploads', { select: 'id', environment: 'eq.' + ctx.environment, undone_at: 'not.is.null', ...(op === 'hide' ? { id: 'eq.' + body.uploadId } : {}), limit: '500' });
    if (op === 'hide' && !undone.length) return send(ctx.res, 409, { error: 'MANHEIM_BATCH_NOT_UNDONE' });
    if (undone.length) await insertIgnore(ctx, 'panel_batch_hidden', undone.map((row) => ({ environment: ctx.environment, user_id: ctx.panel.id, upload_id: row.id })));
    return send(ctx.res, 200, { hidden: undone.length });
  } catch (error) {
    if (pending(error)) return send(ctx.res, 503, { error: 'MANHEIM_HISTORY_PENDING' });
    throw error;
  }
}
const insertIgnore = (ctx, table, payload) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table + '?on_conflict=environment,user_id,upload_id', {
  method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(payload) });
const patchOrDelete = (ctx, table, filters) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table + '?' + new URLSearchParams(filters).toString(), { method: 'DELETE', headers: { prefer: 'return=minimal' } });

const CONFLICT_CODES = new Set(['MANHEIM_APPEND_NO_ACTIVE', 'MANHEIM_APPEND_TARGET_CHANGED', 'MANHEIM_BATCH_INCOMPLETE', 'MANHEIM_BATCH_CANCELED', 'MANHEIM_BATCH_ALREADY_ACTIVE', 'MANHEIM_CHUNK_CONFLICT', 'MANHEIM_CHUNK_HASH_MISMATCH', 'MANHEIM_BATCH_INTEGRITY_ERROR', 'MANHEIM_COMPLEMENT_NOT_ACTIVE', 'MANHEIM_COMPLEMENT_MISMATCH', 'MANHEIM_BATCH_NOT_UNDONE', 'MANHEIM_COMPLEMENT_INCOMPLETE', 'MANHEIM_COMPLEMENT_CANCELED']);
const ACTIONS = { start: actionStart, chunk: actionChunk, status: actionStatus, finalize: actionFinalize, cancel: actionCancel,
  'complement-check': actionComplementCheck, 'complement-start': actionComplementStart, 'complement-stage': actionComplementStage, 'complement-apply': actionComplementApply, 'complement-result': actionComplementResult, 'complement-cancel': actionComplementCancel, visibility: actionVisibility };

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  try {
    if (!(await batchSupported(ctx, { rows }).catch(() => false))) return send(res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
    if (req.method === 'GET') {
      const latest = await latestActiveUpload(ctx, 'id,vehicle_count,uploaded_at,source_file_count,files_json');
      // Per file: name, size, counts and the hash of its manifest entry (for the complement to compare
      // each file with what the batch recorded; never the cars).
      const files = latest && Array.isArray(latest.files_json) ? latest.files_json.map(fileSummary) : [];
      return send(res, 200, { latest: latest ? { id: latest.id, vehicleCount: latest.vehicle_count, uploadedAt: latest.uploaded_at, fileCount: latest.source_file_count, files } : null });
    }
    const body = await jsonBody(req, BODY_LIMIT);
    const name = String(body && body.action || '');
    const action = Object.prototype.hasOwnProperty.call(ACTIONS, name) ? ACTIONS[name] : null;
    if (!action) return send(res, 400, { error: 'MANHEIM_BATCH_ACTION_INVALID' });
    // Complement without its migration: say so, never a false count.
    if (COMPLEMENT_ACTIONS.has(name)) return await action(ctx, body).catch((error) => { if (pendingComplement(error)) return send(res, 503, { error: 'MANHEIM_COMPLEMENT_PENDING' }); throw error; });
    return await action(ctx, body);
  } catch (error) {
    if (error && error.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error && error.code || '')) ? error.code : null;
    if (code) return send(res, ['MANHEIM_UPLOAD_NOT_FOUND'].includes(code) ? 404 : CONFLICT_CODES.has(code) ? 409 : 400, { error: code });
    const requestId = crypto.randomUUID().slice(0, 8);
    console.error('[manheim-batch]', { requestId, message: String(error && error.message || 'UNKNOWN') });
    return send(res, 500, { error: 'MANHEIM_BATCH_ERROR', requestId });
  }
};
module.exports.startInput = startInput;

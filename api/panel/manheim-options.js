'use strict';

// Opções de UMA demanda do lote ativo, página por página (BUSCAS abre a demanda ou "Ver mais").
//  GET  ?key=journey:<id>:CARRO&cursor=<...>&limit=10   até 50 carros por página, cursor estável
//  GET  ?key=...&group=LANE|OFFLANE|INCOMPLETE&cursor=<n>&sort=cr|year_desc|year_asc|mmr_desc|mmr_asc
//       um grupo da demanda, 10 por vez, na ordem por CR (padrão), por ano ou por MMR
//  POST { action: 'sync' }                             compara de novo os pedidos defasados (critério
//                                                     novo ou alterado depois do lote)
//  POST { action: 'rematch', key }                     critério mudou: o servidor compara de novo só
//                                                     essa demanda com os carros do lote ativo
//  POST { action: 'select'|'remove'|'exclude'|'price', matchId, pct, reason, note }
//                                                     seleção para o cliente (no máximo 10 por demanda;
//                                                     fora de Lane/Run só com motivo). Nada é enviado.
// Nenhuma resposta traz o lote inteiro; nenhuma chamada paga; nenhuma mensagem.
const crypto = require('node:crypto');
const { allRows, jsonBody, requirePanel, rows, rpc, send } = require('../../panel-server');
const { batchSupported, latestActiveUpload } = require('../../panel-manheim-state');
const { loadBuscasBase, liveMatchesFor, upper } = require('../../panel-buscas');
const { demandContext } = require('../../panel-buscas-view');
const batch = require('../../panel-manheim-batch');
const offer = require('../../manheim-offer');
const { rematchDemands, syncStaleDemands } = require('../../panel-rematch');
const optionStamp = require('../../panel-option-stamp');

const KEY = /^(journey:[0-9a-f-]{36}|ref:[A-HJ-NP-Z2-9]{5}):(VALOR|CARRO)$/;
const PARSED_FIELDS = ['vin', 'year', 'make', 'model', 'trim', 'miles', 'location', 'locationDisplay', 'saleDate', 'startsAt', 'endsAt', 'mmrCents', 'exteriorColor', 'interiorColor', 'buyNowPrice', 'conditionGrade', 'lot', 'drivetrain', 'transmission', 'engine', 'makeNotice', 'matchNotice', 'matchedWishlistLabel', 'matchedWishlistIndex', 'dataGap', 'cleanTitle', 'odometerOk', 'lane', 'run', 'saleType', 'saleStatus', 'eventSaleName'];

const slimParsed = (parsed) => Object.fromEntries(PARSED_FIELDS.filter((field) => parsed && parsed[field] !== undefined && parsed[field] !== '' && parsed[field] !== null).map((field) => [field, parsed[field]]));

function encodeCursor(match) {
  const rank = Number.isInteger(match.sort_rank) ? match.sort_rank : match.match_kind === 'BATE' ? 0 : match.match_kind === 'POR_VALOR' ? 1 : 2;
  const parsedMiles = Number(match.vehicle_json && match.vehicle_json.parsed && match.vehicle_json.parsed.miles);
  const miles = Number.isInteger(match.sort_miles) ? match.sort_miles : Number.isInteger(parsedMiles) && parsedMiles >= 0 ? parsedMiles : batch.MAX_MILES_SORT;
  return Buffer.from(JSON.stringify([rank, miles, match.id])).toString('base64url');
}
function decodeCursor(value) {
  if (!value) return null;
  try {
    const [rank, miles, id] = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    return Number.isInteger(rank) && Number.isInteger(miles) && /^[0-9a-f-]{36}$/.test(String(id)) ? { rank, miles, id } : null;
  } catch (_) { return null; }
}

async function contextFor(ctx, key) {
  const base = await loadBuscasBase(ctx, { allRows });
  const context = demandContext(base);
  const demand = context.listed.find((item) => item.key === key && item.active) || null;
  return { base, context, demand, target: context.targetByKey.get(key) || null };
}

// Other active clients the same car also fits (by VIN), only for the cars of this page.
async function alsoFitsFor(ctx, uploadId, page, base, journeyId) {
  const vins = [...new Set(page.map((match) => upper(match.vehicle_json && match.vehicle_json.parsed && match.vehicle_json.parsed.vin)).filter((vin) => /^[A-Z0-9]{5,40}$/.test(vin)))];
  if (!vins.length) return new Map();
  const others = await rows(ctx, 'manheim_matches', { select: 'journey_id,vin', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId, undone_at: 'is.null', vin: 'in.(' + vins.join(',') + ')', journey_id: 'not.is.null', limit: '2000' });
  const own = journeyId ? base.journeyById.get(journeyId) : null;
  const recentCut = Date.now() - 60 * 86400000;
  const withVitrine = new Set((await allRows(ctx, 'vitrines', { select: 'journey_id', environment: 'eq.' + ctx.environment }).catch(() => [])).map((row) => row.journey_id).filter(Boolean));
  const activeOther = (journey) => journey && journey.status !== 'ENCERRADO' && journey.enabled !== false && (Date.parse(journey.created_at || 0) >= recentCut || withVitrine.has(journey.id));
  const byVin = new Map();
  others.forEach((row) => {
    if (!row.journey_id || row.journey_id === journeyId) return;
    const journey = base.journeyById.get(row.journey_id);
    if (!activeOther(journey) || (own && journey.contact_id === own.contact_id)) return;
    if (!byVin.has(row.vin)) byVin.set(row.vin, new Set());
    byVin.get(row.vin).add(journey.contact?.display_name || journey.reference_code || 'outro cliente');
  });
  return byVin;
}

// Before migration 20261006010000 the selection functions do not exist yet.
const selectionMissing = (error) => error && (error.status === 404 || /PGRST202|42883/.test(String(error.code || '') + String(error.message || '')));

function optionOut(match, key, demand, also, provenance = null) {
  const live = demand ? liveMatchesFor(match, [demand])[0] || null : null;
  const current = live || match;
  const parsed = slimParsed(match.vehicle_json && match.vehicle_json.parsed);
  const mmr = Number(parsed.mmrCents) || 0, bid = demand && demand.mode === 'VALOR' ? Number(demand.bidCents) || 0 : 0;
  return {
    id: match.id, journey_id: match.journey_id, calc_ref: match.calc_ref ? String(match.calc_ref).trim() : null, logical_mode: match.logical_mode, demandKey: key,
    match_kind: current.match_kind, match_reason: current.match_reason, mmr_status: current.mmr_status, row_fingerprint: match.row_fingerprint,
    presented_unit_id: match.presented_unit_id || null, vehicle_json: { parsed },
    fitsBid: match.logical_mode === 'VALOR' && mmr && bid ? mmr <= bid : null,
    alsoFitsFor: [...(also.get(upper(parsed.vin)) || [])], criteriaChanged: !live,
    // Provenance stamp: ficha, Ref, type, criteria hash and version, lot, valid or not (and why).
    stamp: provenance ? optionStamp.stampOf({ match, demand, key, ...provenance }) : null
  };
}

// Ordering chosen by the operator: the server's CR order (default), or year / MMR, both ways. The database
// sorts the whole group and returns one page per call (panel_manheim_offer_page_sorted), with no size limit;
// ties keep the CR order and a car without year or MMR goes last.
const SORTS = { cr: null, year_desc: ['year', -1], year_asc: ['year', 1], mmr_desc: ['mmr', -1], mmr_asc: ['mmr', 1] };
// Same order in memory (kept for the tests that check the rule against the database).
function sortValue(row, field) {
  const parsed = row.vehicle_json && row.vehicle_json.parsed || {};
  const value = field === 'year' ? Number(parsed.year) : Number(row.mmr_cents);
  return Number.isFinite(value) && value > 0 ? value : null;
}
function sortedGroup(list, sort) {
  const [field, direction] = SORTS[sort];
  return list.map((row, index) => ({ row, index, value: sortValue(row, field) }))
    .sort((a, b) => (a.value === null) - (b.value === null) || (a.value !== null && b.value !== null ? (a.value - b.value) * direction : 0) || a.index - b.index)
    .map((entry) => entry.row);
}

// One group of one demand, ordered by CR (up to 5 at or above the recommended minimum, then up to 5
// below it, then the rest). The page carries the price and the selection state of each car.
async function groupPage(ctx, req, key, group, limit) {
  const offset = req.query && req.query.cursor ? Number(req.query.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) return send(ctx.res, 400, { error: 'MANHEIM_CURSOR_INVALID' });
  const latest = await latestActiveUpload(ctx, 'id,uploaded_at');
  if (!latest) return send(ctx.res, 200, { key, group, uploadId: null, options: [], nextCursor: null, total: 0 });
  const sort = SORTS[req.query && req.query.sort] ? String(req.query.sort) : 'cr';
  let stored;
  try {
    if (sort === 'cr') [stored] = await Promise.all([rpc(ctx, 'panel_manheim_offer_page', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_group: group, p_offset: offset, p_limit: limit + 1 })]);
    else stored = await rpc(ctx, 'panel_manheim_offer_page_sorted', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_group: group, p_sort: sort, p_offset: offset, p_limit: limit + 1 });
  } catch (error) {
    if (selectionMissing(error)) return send(ctx.res, 503, { error: 'MANHEIM_SELECTION_PENDING' });
    throw error;
  }
  const { base, demand } = await contextFor(ctx, key);
  const page = (stored || []).slice(0, limit);
  const also = await alsoFitsFor(ctx, latest.id, page, base, demand && demand.journeyId);
  const provenance = { activeUploadId: latest.id, hashes: await optionStamp.hashesFor(ctx, latest.id, key) };
  const optionsOut = page.map((row) => ({
    ...optionOut(row, key, demand, also, provenance),
    offer: {
      group: row.offer_group, cr: row.cr === null ? null : Number(row.cr), crMinimum: row.cr_minimum === null ? null : Number(row.cr_minimum),
      belowMinimum: row.below_minimum, tier: row.tier, mmrCents: Number(row.mmr_cents), defaultPct: Number(row.default_pct),
      manualPct: row.manual_pct === null ? null : Number(row.manual_pct), finalCents: Number(row.final_cents),
      status: row.selection_status, manual: row.manual === true, manualReason: row.manual_reason || null, note: row.note || null
    }
  }));
  const total = page.length ? Number(page[0].total_in_group) || 0 : 0;
  // Next page from the group total (the database caps a page at 50, so "one extra row" never shows on a page of 50).
  const more = (stored || []).length > limit || (total > 0 && offset + page.length < total && page.length === limit);
  return send(ctx.res, 200, { key, group, uploadId: latest.id, uploadedAt: latest.uploaded_at || null, options: optionsOut, total, nextCursor: more ? String(offset + limit) : null });
}

// Selection for the customer. The database enforces the rules (active batch, valid MMR, 10 per
// demand, reason outside Lane/Run) under a lock; this only validates the input.
async function selectOption(ctx, body) {
  const actions = { select: 'SELECT', remove: 'REMOVE', exclude: 'EXCLUDE', price: 'PRICE' };
  const pct = offer.validPct(body.pct);
  if (!/^[0-9a-f-]{36}$/.test(String(body.matchId || '')) || Number.isNaN(pct)) return send(ctx.res, 400, { error: pct !== pct ? 'MANHEIM_SELECTION_PCT_INVALID' : 'MANHEIM_SELECTION_INVALID' });
  // The customer price typed in dollars (cents, whole number) instead of the percentage: never both.
  const hasFinal = body.finalCents !== null && body.finalCents !== undefined && body.finalCents !== '';
  const finalCents = hasFinal ? Number(body.finalCents) : null;
  if (hasFinal && (!Number.isSafeInteger(finalCents) || finalCents <= 0 || pct !== null)) return send(ctx.res, 400, { error: 'MANHEIM_SELECTION_FINAL_INVALID' });
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : null;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
  // A car that no longer fits (lot or criteria changed) is not selected: the stamp is recomputed now.
  if (body.action === 'select') {
    const held = await optionStamp.gate(ctx, [body.matchId]);
    if (held) return send(ctx.res, 409, { error: held.code, reason: held.reason, text: held.text });
  }
  try {
    const result = await rpc(ctx, 'panel_manheim_offer_select_v2', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_match_id: body.matchId, p_action: actions[body.action], p_manual_pct: pct, p_reason: reason || null, p_note: note || null, p_final_cents: finalCents });
    return send(ctx.res, 200, result);
  } catch (error) {
    if (selectionMissing(error)) return send(ctx.res, 503, { error: 'MANHEIM_SELECTION_PENDING' });
    throw error;
  }
}

async function options(ctx, req) {
  const key = String(req.query && req.query.key || '');
  if (!KEY.test(key)) return send(ctx.res, 400, { error: 'MANHEIM_DEMAND_KEY_INVALID' });
  const group = req.query && req.query.group ? String(req.query.group) : null;
  if (group && !offer.GROUPS.includes(group)) return send(ctx.res, 400, { error: 'MANHEIM_GROUP_INVALID' });
  if (group) return groupPage(ctx, req, key, group, Math.min(Math.max(Number(req.query && req.query.limit) || 10, 1), 50));
  const limit = Math.min(Math.max(Number(req.query && req.query.limit) || 10, 1), 50);
  const cursor = decodeCursor(req.query && req.query.cursor);
  if (req.query && req.query.cursor && !cursor) return send(ctx.res, 400, { error: 'MANHEIM_CURSOR_INVALID' });
  const latest = await latestActiveUpload(ctx, 'id,uploaded_at');
  if (!latest) return send(ctx.res, 200, { key, uploadId: null, options: [], nextCursor: null });
  const [{ base, demand }, stored] = await Promise.all([
    contextFor(ctx, key),
    rpc(ctx, 'panel_manheim_demand_options', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_after_rank: cursor ? cursor.rank : null, p_after_miles: cursor ? cursor.miles : null, p_after_id: cursor ? cursor.id : null, p_limit: limit + 1 })
  ]);
  const page = (stored || []).slice(0, limit);
  const more = (stored || []).length > limit;
  const also = await alsoFitsFor(ctx, latest.id, page, base, demand && demand.journeyId);
  // Today's rule, applied again to the stored car: a car that no longer fits says so.
  const provenance = { activeUploadId: latest.id, hashes: await optionStamp.hashesFor(ctx, latest.id, key) };
  const optionsOut = page.map((match) => optionOut(match, key, demand, also, provenance));
  return send(ctx.res, 200, { key, uploadId: latest.id, criteriaVersion: demand ? provenance.hashes.indexOf(demand.criteriaHash) + 1 || null : null, options: optionsOut, nextCursor: more && page.length ? encodeCursor(page[page.length - 1]) : null, demandFound: Boolean(demand) });
}

// Directed rematch of one demand against the cars of the active batch, read by make only.
async function rematch(ctx, body) {
  const key = String(body.key || '');
  if (!KEY.test(key)) return send(ctx.res, 400, { error: 'MANHEIM_DEMAND_KEY_INVALID' });
  const [outcome] = await rematchDemands(ctx, [key]);
  if (outcome.status === 'NO_BATCH') return send(ctx.res, 409, { error: 'MANHEIM_NO_ACTIVE_BATCH' });
  if (outcome.status !== 'DONE') return send(ctx.res, 409, { error: 'MANHEIM_DEMAND_NOT_ACTIVE' });
  // Recalculating creates a new version of the request's criteria: said, never silent.
  const latest = await latestActiveUpload(ctx, 'id');
  const { demand } = await contextFor(ctx, key).catch(() => ({ demand: null }));
  const hashes = latest ? await optionStamp.hashesFor(ctx, latest.id, key) : [];
  const version = demand ? hashes.indexOf(demand.criteriaHash) + 1 || null : null;
  return send(ctx.res, 200, { ...outcome.result, compared: outcome.compared, criteriaVersion: version });
}

module.exports = async (req, res) => {
  if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  try {
    if (!(await batchSupported(ctx, { rows }).catch(() => false))) return send(res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
    if (req.method === 'GET') return await options(ctx, req);
    const body = await jsonBody(req, 4096);
    if (body.action === 'rematch') return await rematch(ctx, body);
    // Requests whose criterion changed or that never met the active batch (OPÇÕES opened, a ficha
    // changed): compared now, within this function's 30 s.
    if (body.action === 'sync') return send(res, 200, await syncStaleDemands(ctx, { deadlineAt: Date.now() + 20000 }));
    if (['select', 'remove', 'exclude', 'price'].includes(body.action)) return await selectOption(ctx, body);
    return send(res, 400, { error: 'MANHEIM_OPTIONS_ACTION_INVALID' });
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error && error.code || '')) ? error.code : null;
    if (code) return send(res, 409, { error: code });
    const requestId = crypto.randomUUID().slice(0, 8);
    console.error('[manheim-options]', { requestId, message: String(error && error.message || 'UNKNOWN') });
    return send(res, 500, { error: 'MANHEIM_OPTIONS_ERROR', requestId });
  }
};
module.exports.encodeCursor = encodeCursor;
module.exports.decodeCursor = decodeCursor;
module.exports.sortedGroup = sortedGroup;

'use strict';

// Opções de UMA demanda do lote ativo, página por página (BUSCAS abre a demanda ou "Ver mais").
//  GET  ?key=journey:<id>:CARRO&cursor=<...>&limit=10   até 50 carros por página, cursor estável
//  POST { action: 'rematch', key }                     critério mudou: o servidor compara de novo só
//                                                     essa demanda com os carros do lote ativo
// Nenhuma resposta traz o lote inteiro; nenhuma chamada paga; nenhuma mensagem.
const crypto = require('node:crypto');
const { allRows, jsonBody, requirePanel, rows, rpc, send } = require('../../panel-server');
const { batchSupported, latestActiveUpload } = require('../../panel-manheim-state');
const { loadBuscasBase, liveMatchesFor, upper } = require('../../panel-buscas');
const { demandContext } = require('../../panel-buscas-view');
const batch = require('../../panel-manheim-batch');
const vehicleMatch = require('../../vehicle-match');

const KEY = /^(journey:[0-9a-f-]{36}|ref:[A-HJ-NP-Z2-9]{5}):(VALOR|CARRO)$/;
const PARSED_FIELDS = ['vin', 'year', 'make', 'model', 'trim', 'miles', 'location', 'locationDisplay', 'saleDate', 'startsAt', 'endsAt', 'mmrCents', 'exteriorColor', 'interiorColor', 'buyNowPrice', 'conditionGrade', 'lot', 'drivetrain', 'transmission', 'engine', 'makeNotice', 'matchNotice', 'matchedWishlistLabel', 'matchedWishlistIndex', 'dataGap', 'cleanTitle', 'odometerOk'];

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

async function options(ctx, req) {
  const key = String(req.query && req.query.key || '');
  if (!KEY.test(key)) return send(ctx.res, 400, { error: 'MANHEIM_DEMAND_KEY_INVALID' });
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
  const optionsOut = page.map((match) => {
    // Today's rule, applied again to the stored car: a car that no longer fits says so.
    const live = demand ? liveMatchesFor(match, [demand])[0] || null : null;
    const current = live || match;
    const parsed = slimParsed(match.vehicle_json && match.vehicle_json.parsed);
    const mmr = Number(parsed.mmrCents) || 0, bid = demand && demand.mode === 'VALOR' ? Number(demand.bidCents) || 0 : 0;
    return {
      id: match.id, journey_id: match.journey_id, calc_ref: match.calc_ref ? String(match.calc_ref).trim() : null, logical_mode: match.logical_mode, demandKey: key,
      match_kind: current.match_kind, match_reason: current.match_reason, mmr_status: current.mmr_status, row_fingerprint: match.row_fingerprint,
      presented_unit_id: match.presented_unit_id || null, vehicle_json: { parsed },
      fitsBid: match.logical_mode === 'VALOR' && mmr && bid ? mmr <= bid : null,
      alsoFitsFor: [...(also.get(upper(parsed.vin)) || [])], criteriaChanged: !live
    };
  });
  return send(ctx.res, 200, { key, uploadId: latest.id, options: optionsOut, nextCursor: more && page.length ? encodeCursor(page[page.length - 1]) : null, demandFound: Boolean(demand) });
}

// Directed rematch of one demand against the cars of the active batch, read by make only.
async function rematch(ctx, body) {
  const key = String(body.key || '');
  if (!KEY.test(key)) return send(ctx.res, 400, { error: 'MANHEIM_DEMAND_KEY_INVALID' });
  const latest = await latestActiveUpload(ctx, 'id');
  if (!latest) return send(ctx.res, 409, { error: 'MANHEIM_NO_ACTIVE_BATCH' });
  const { target } = await contextFor(ctx, key);
  if (!target) return send(ctx.res, 409, { error: 'MANHEIM_DEMAND_NOT_ACTIVE' });
  const [snapshot] = batch.snapshotTargets([target]);
  const makes = [...new Set(snapshot.wishes.map((wish) => batch.makeKey(wish.make)).filter(Boolean))];
  const filter = makes.length ? { make_key: 'in.(' + makes.concat(['']).map((make) => '"' + make.replace(/"/g, '') + '"').join(',') + ')' } : {};
  const cars = await allRows(ctx, 'manheim_vehicles', { select: 'id,row_fingerprint,vehicle_json,make_key,mmr_cents', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id, undone_at: 'is.null', ...filter });
  const entries = cars.map((car) => ({ fingerprint: car.row_fingerprint, makeKey: car.make_key || '', mmrCents: vehicleMatch.validMmrCents(car.mmr_cents !== null && car.mmr_cents !== undefined ? car.mmr_cents : car.vehicle_json && car.vehicle_json.mmrCents), vehicle: car.vehicle_json || {} }));
  const matches = batch.matchChunk(entries, [snapshot]);
  const result = await rpc(ctx, 'panel_manheim_rematch_demand', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: latest.id, p_demand_key: key, p_matches: matches });
  return send(ctx.res, 200, { ...result, compared: entries.length });
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

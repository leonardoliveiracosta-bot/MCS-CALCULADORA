'use strict';

// Opções de UMA demanda do lote ativo, página por página (BUSCAS abre a demanda ou "Ver mais").
//  GET  ?key=journey:<id>:CARRO&cursor=<...>&limit=10   até 50 carros por página, cursor estável
//  GET  ?key=...&group=LANE|OFFLANE|INCOMPLETE&cursor=<n>&sort=cr|year_desc|year_asc|miles_asc|miles_desc|mmr_desc|mmr_asc
//       um grupo da demanda, 10 por vez, na ordem por CR (padrão), por ano ou por MMR
//       &trims=<chave>,<chave>  só os trims marcados (só visualização; vazio = tudo). A primeira
//       página traz os trims do grupo com a contagem (trims: [{ key, label, count, selected }])
//  POST { action: 'sync' }                             compara de novo os pedidos defasados (critério
//                                                     novo ou alterado depois do lote)
//  POST { action: 'rematch', key }                     critério mudou: o servidor compara de novo só
//                                                     essa demanda com os carros do lote ativo
//  POST { action: 'select'|'remove'|'exclude'|'price', matchId, pct, reason, note }
//                                                     seleção para o cliente (no máximo 10 por demanda;
//                                                     fora de Lane/Run só com motivo). Nada é enviado.
//  POST { action: 'reason', matchId, reason }          "Por que este carro": frase para o cliente no carro
//                                                     selecionado (vai na V1); texto vazio apaga
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
const PARSED_FIELDS = ['budgetFallback', 'requestedBudgetCents', 'titleStatus', 'odometerStatus', 'vin', 'year', 'make', 'model', 'trim', 'miles', 'location', 'locationDisplay', 'saleDate', 'startsAt', 'endsAt', 'mmrCents', 'exteriorColor', 'interiorColor', 'buyNowPrice', 'conditionGrade', 'lot', 'drivetrain', 'transmission', 'engine', 'makeNotice', 'matchNotice', 'matchedWishlistLabel', 'matchedWishlistIndex', 'dataGap', 'cleanTitle', 'odometerOk', 'lane', 'run', 'saleType', 'saleStatus', 'eventSaleName'];

const slimParsed = (parsed) => Object.fromEntries([...PARSED_FIELDS,'purchaseOptions','memberMatchIds'].filter((field) => parsed && parsed[field] !== undefined && parsed[field] !== '' && parsed[field] !== null).map((field) => [field, parsed[field]]));

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
  // Only older, otherwise eligible clients of these VINs need the vitrine check.
  const olderIds = [...new Set(others.map((row) => base.journeyById.get(row.journey_id)).filter((journey) => journey && journey.id !== journeyId && journey.status !== 'ENCERRADO' && journey.enabled !== false && !(own && journey.contact_id === own.contact_id) && !(Date.parse(journey.created_at || 0) >= recentCut)).map((journey) => journey.id))];
  const vitrines = [];
  // Keep URLs bounded without cutting off any matching client.
  for (let start = 0; start < olderIds.length; start += 100) vitrines.push(...await allRows(ctx, 'vitrines', { select: 'journey_id', environment: 'eq.' + ctx.environment, journey_id: 'in.(' + olderIds.slice(start, start + 100).join(',') + ')' }).catch(() => []));
  const withVitrine = new Set(vitrines.map((row) => row.journey_id).filter(Boolean));
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

// Ordering chosen by the operator: the server's CR order (default), or year / miles / MMR, both ways. The
// database sorts the whole group and returns one page per call (panel_manheim_offer_page_sorted), with no size
// limit; ties keep the CR order and a car without year, miles or MMR goes last.
const SORTS = { cr: null, year_desc: ['year', -1], year_asc: ['year', 1], miles_asc: ['miles', 1], miles_desc: ['miles', -1], mmr_desc: ['mmr', -1], mmr_asc: ['mmr', 1] };
// Same order in memory (kept for the tests that check the rule against the database).
function sortValue(row, field) {
  const parsed = row.vehicle_json && row.vehicle_json.parsed || {};
  if (field === 'miles') return /^\d{1,9}$/.test(String(parsed.miles ?? '')) ? Number(parsed.miles) : null;
  const value = field === 'year' ? Number(parsed.year) : Number(row.mmr_cents);
  return Number.isFinite(value) && value > 0 ? value : null;
}
function sortedGroup(list, sort) {
  const [field, direction] = SORTS[sort];
  return list.map((row, index) => ({ row, index, value: sortValue(row, field) }))
    .sort((a, b) => (a.value === null) - (b.value === null) || (a.value !== null && b.value !== null ? (a.value - b.value) * direction : 0) || a.index - b.index)
    .map((entry) => entry.row);
}

// Trim filter of a group (view only): the normalized keys of the trims checked by the operator, as
// panel_manheim_trim_key gives them ('' = no trim). At most 40, each up to 80 characters.
const trimKey = (value) => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
function trimsOf(query) {
  if (!query || typeof query.trims !== 'string' || !query.trims.length) return [];
  let list;
  try { list = JSON.parse(query.trims); } catch (_) { return null; }
  if (!Array.isArray(list) || list.length > 40 || list.some((item) => typeof item !== 'string' || item.length > 80)) return null;
  return [...new Set(list.map(trimKey))];
}

// One group of one demand, ordered by CR (up to 5 at or above the recommended minimum, then up to 5
// below it, then the rest). The page carries the price and the selection state of each car.
async function groupPage(ctx, req, key, group, limit) {
  const offset = req.query && req.query.cursor ? Number(req.query.cursor) : 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 250000) return send(ctx.res, 400, { error: 'MANHEIM_CURSOR_INVALID' });
  const latest = await latestActiveUpload(ctx, 'id,uploaded_at');
  if (!latest) return send(ctx.res, 200, { key, group, uploadId: null, options: [], nextCursor: null, total: 0 });
  const sort = SORTS[req.query && req.query.sort] ? String(req.query.sort) : 'cr';
  const trims = trimsOf(req.query);
  if (trims === null) return send(ctx.res, 400, { error: 'MANHEIM_TRIMS_INVALID' });
  let stored, facets = null;
  try {
    // First page: the same live grouping supplies both the cars and the trim counts.
    // A missing additive RPC keeps the older release compatible; other failures remain errors.
    const bundle = offset === 0 ? await rpc(ctx, 'panel_manheim_offer_page_bundle', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_group: group, p_sort: sort, p_trims: trims, p_offset: offset, p_limit: limit + 1 }).catch((error) => { if (selectionMissing(error)) return null; throw error; }) : null;
    if (bundle) {
      if (!Array.isArray(bundle.options) || !Array.isArray(bundle.trims)) throw new Error('MANHEIM_OPTIONS_INVALID');
      stored = bundle.options; facets = bundle.trims;
    } else {
      // Backward compatibility before the additive migration; later pages still use one page read.
      const facetsRead = offset === 0 ? rpc(ctx, 'panel_manheim_offer_trims', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_group: group }).catch((error) => { console.error('[manheim-trims]', { message: String(error && (error.code || error.message) || 'UNKNOWN') }); return null; }) : Promise.resolve(null);
      const pageRead = trims.length ? rpc(ctx, 'panel_manheim_offer_page_trim', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_group: group, p_sort: sort, p_trims: trims, p_offset: offset, p_limit: limit + 1 })
        : sort === 'cr' ? rpc(ctx, 'panel_manheim_offer_page', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_group: group, p_offset: offset, p_limit: limit + 1 })
        : rpc(ctx, 'panel_manheim_offer_page_sorted', { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_group: group, p_sort: sort, p_offset: offset, p_limit: limit + 1 });
      [facets, stored] = await Promise.all([facetsRead, pageRead]);
    }
  } catch (error) {
    if (selectionMissing(error)) return send(ctx.res, 503, { error: 'MANHEIM_SELECTION_PENDING' });
    throw error;
  }
  const page = (stored || []).slice(0, limit);
  // No car means no current-criteria or provenance decoration is needed.
  if (!page.length) return send(ctx.res, 200, { key, group, uploadId: latest.id, uploadedAt: latest.uploaded_at || null, options: [], total: 0, trims: Array.isArray(facets) ? facets.map((row) => ({ key: row.trim_key || '', label: row.trim_key ? row.label || row.trim_key : 'Sem trim', count: Number(row.car_count) || 0, selected: Number(row.selected_count) || 0 })) : null, filter: trims, nextCursor: null });
  const { base, demand } = await contextFor(ctx, key);
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
  // "Por que este carro" of the selected cars of this page (any sale of the same VIN).
  const memberIds = [...new Set(page.flatMap((row) => (row.vehicle_json && row.vehicle_json.parsed && row.vehicle_json.parsed.memberMatchIds) || [row.id]).filter((id) => /^[0-9a-f-]{36}$/.test(String(id))))];
  const reasons = memberIds.length ? await rows(ctx, 'manheim_option_selections', { select: 'match_id,client_reason', environment: 'eq.' + ctx.environment, status: 'eq.SELECTED', match_id: 'in.(' + memberIds.join(',') + ')', limit: String(memberIds.length) }).catch(() => []) : [];
  const reasonOf = (row) => { const members = (row.vehicle_json && row.vehicle_json.parsed && row.vehicle_json.parsed.memberMatchIds) || [row.id]; const hit = reasons.find((item) => members.includes(item.match_id) && item.client_reason); return hit ? hit.client_reason : null; };
  optionsOut.forEach((option, index) => { option.offer.clientReason = reasonOf(page[index]); });
  const total = page.length ? Number(page[0].total_in_group) || 0 : 0;
  // Next page from the group total (the database caps a page at 50, so "one extra row" never shows on a page of 50).
  const more = (stored || []).length > limit || (total > 0 && offset + page.length < total && page.length === limit);
  const trimList = Array.isArray(facets) ? facets.map((row) => ({ key: row.trim_key || '', label: row.trim_key ? row.label || row.trim_key : 'Sem trim', count: Number(row.car_count) || 0, selected: Number(row.selected_count) || 0 })) : null;
  return send(ctx.res, 200, { key, group, uploadId: latest.id, uploadedAt: latest.uploaded_at || null, options: optionsOut, total, trims: trimList, filter: trims, nextCursor: more ? String(offset + limit) : null });
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
  // The price typed for the customer is whole dollars: no cents.
  if (hasFinal && finalCents % 100 !== 0) return send(ctx.res, 400, { error: 'MANHEIM_SELECTION_FINAL_CENTS' });
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 300) : null;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : null;
  // A car that no longer fits (lot or criteria changed) is not selected: the stamp is recomputed now.
  if (body.action === 'select') {
    const held = await optionStamp.gate(ctx, [body.matchId]);
    if (held) return send(ctx.res, 409, { error: held.code, reason: held.reason, text: held.text });
  }
  try {
    const result = await rpc(ctx, 'panel_manheim_offer_select_v3', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_match_id: body.matchId, p_action: actions[body.action], p_manual_pct: pct, p_reason: reason || null, p_note: note || null, p_final_cents: finalCents });
    return send(ctx.res, 200, result);
  } catch (error) {
    if (selectionMissing(error)) return send(ctx.res, 503, { error: 'MANHEIM_SELECTION_PENDING' });
    throw error;
  }
}

// Internal note only: this never changes selection or customer price.
async function saveNote(ctx, body) {
  if (!/^[0-9a-f-]{36}$/.test(String(body.matchId || '')) || (body.note != null && typeof body.note !== 'string')) return send(ctx.res, 400, { error: 'MANHEIM_SELECTION_INVALID' });
  const note = (body.note || '').trim();
  if (note.length > 500) return send(ctx.res, 400, { error: 'MANHEIM_SELECTION_INVALID' });
  try {
    return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_offer_note', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_match_id: body.matchId, p_note: note || null }));
  } catch (error) {
    if (selectionMissing(error)) return send(ctx.res, 503, { error: 'MANHEIM_SELECTION_PENDING' });
    throw error;
  }
}

// "Por que este carro": a short sentence for the customer on a selected car (the V1 shows it).
async function saveReason(ctx, body) {
  if (!/^[0-9a-f-]{36}$/.test(String(body.matchId || ''))) return send(ctx.res, 400, { error: 'MANHEIM_SELECTION_INVALID' });
  const reason = typeof body.reason === 'string' ? body.reason.replace(/[\u0000-\u001f]+/g, ' ').trim() : '';
  if (reason.length > 300) return send(ctx.res, 400, { error: 'MANHEIM_REASON_TOO_LONG' });
  try {
    return send(ctx.res, 200, await rpc(ctx, 'panel_manheim_offer_reason', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_match_id: body.matchId, p_reason: reason || null }));
  } catch (error) {
    if (selectionMissing(error)) return send(ctx.res, 503, { error: 'MANHEIM_SELECTION_PENDING' });
    throw error;
  }
}

// The cars selected for the customer in one request (at most 10), to review or remove them.
// Selected rows still in the grouped base stay; the others whose auction passed are "ended" (by name).
// Without the grouped read (null) nothing is hidden.
function splitSelected(picked, byId, grouped) {
  if (!Array.isArray(grouped)) return { kept: picked, ended: [] };
  const live = new Set(grouped.flatMap((row) => (row.vehicle_json && row.vehicle_json.parsed && row.vehicle_json.parsed.memberMatchIds) || [row.id]));
  const gone = picked.filter((row) => !live.has(row.match_id) && offer.carExpired(byId.get(row.match_id) || {}));
  const name = (parsed) => [parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' ');
  return { kept: picked.filter((row) => !gone.includes(row)), ended: [...new Set(gone.map((row) => name(byId.get(row.match_id) || {})).filter(Boolean))] };
}

async function selectedList(ctx, key) {
  const latest = await latestActiveUpload(ctx, 'id');
  if (!latest) return send(ctx.res, 200, { key, selected: [] });
  let picked;
  try { picked = await rows(ctx, 'manheim_option_selections', { select: 'match_id,final_cents,client_reason,updated_at', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id, demand_key: 'eq.' + key, status: 'eq.SELECTED', order: 'updated_at.asc', limit: '50' }); }
  catch (error) { if (selectionMissing(error)) return send(ctx.res, 503, { error: 'MANHEIM_SELECTION_PENDING' }); throw error; }
  const ids = picked.map((row) => row.match_id);
  const matches = ids.length ? await rows(ctx, 'manheim_matches', { select: 'id,vehicle_json', environment: 'eq.' + ctx.environment, id: 'in.(' + ids.join(',') + ')', limit: String(ids.length) }) : [];
  const byId = new Map(matches.map((row) => [row.id, row.vehicle_json && row.vehicle_json.parsed || {}]));
  // Same cars as the list: a selected car whose auction passed left the selection (it is named in "ended").
  const grouped = ids.length ? await rpc(ctx, 'panel_manheim_grouped_matches', { p_environment: ctx.environment, p_match_ids: ids }).catch(() => null) : [];
  const { kept, ended } = splitSelected(picked, byId, grouped);
  return send(ctx.res, 200, { key, ended, selected: kept.map((row) => { const parsed = byId.get(row.match_id) || {}; return { matchId: row.match_id, year: parsed.year || null, make: parsed.make || '', model: parsed.model || '', trim: parsed.trim || '', miles: parsed.miles ?? null, vin: parsed.vin || '', finalCents: Number(row.final_cents) || null, clientReason: row.client_reason || null }; }) });
}

async function optionsByIds(ctx, req, key) {
  const ids = typeof req.query.ids === 'string' ? [...new Set(req.query.ids.split(','))] : [];
  if (!ids.length || ids.length > 60 || ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return send(ctx.res, 400, { error: 'MANHEIM_SELECTION_INVALID' });
  const latest = await latestActiveUpload(ctx, 'id');
  if (!latest) return send(ctx.res, 200, { key, uploadId: null, options: [] });
  const args = { p_environment: ctx.environment, p_upload_id: latest.id, p_demand_key: key, p_match_ids: ids };
  const options = await rpc(ctx, 'panel_manheim_offer_ids_v2', args).catch((error) => { if (selectionMissing(error)) return rpc(ctx, 'panel_manheim_offer_ids', args); throw error; });
  return send(ctx.res, 200, { key, uploadId: latest.id, options });
}

async function options(ctx, req) {
  const key = String(req.query && req.query.key || '');
  if (!KEY.test(key)) return send(ctx.res, 400, { error: 'MANHEIM_DEMAND_KEY_INVALID' });
  const group = req.query && req.query.group ? String(req.query.group) : null;
  if (group && !offer.GROUPS.includes(group)) return send(ctx.res, 400, { error: 'MANHEIM_GROUP_INVALID' });
  if (req.query && req.query.ids !== undefined) return optionsByIds(ctx, req, key);
  if (group) return groupPage(ctx, req, key, group, Math.min(Math.max(Number(req.query && req.query.limit) || 10, 1), 50));
  if (req.query && req.query.selected === '1') return selectedList(ctx, key);
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
    if (body.action === 'reason') return await saveReason(ctx, body);
    if (body.action === 'note') return await saveNote(ctx, body);
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
module.exports.trimKey = trimKey;
module.exports.splitSelected = splitSelected;

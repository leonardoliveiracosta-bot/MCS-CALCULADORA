'use strict';
const manheimAudit = require('./panel-manheim-audit');

// GET /api/panel/records?view=manheim: the BUSCAS tab. A light summary of the latest ACTIVE
// import batch: one line per demand (person and mode) with its counts, computed by the database.
// No car travels here: the options of a demand are read page by page (manheim-options) only when
// the operator opens it. VALOR and CARRO are counted separately; the total is people.
const { allRows, panelMeta, rows, rpc } = require('./panel-server');
const { score, loadScoreIndex } = require('./panel-ready');
const { decorateContact } = require('./panel-contact');
const { decorateWithSearchStage, loadSearchStageIndex } = require('./panel-search-stage');
const { batchSupported, liveUploadFilter, undoSupported } = require('./panel-manheim-state');
const { demandPerson, liveMatchesFor, loadBuscasBase, matchTarget, reviewItem, upper } = require('./panel-buscas');
const { criteriaHash } = require('./panel-manheim-batch');

const UPLOAD_COLUMNS = 'id,source_file_count,vehicle_count,matched_vehicle_count,lead_count,headers_json,header_map,uploaded_at';
const UNDO_COLUMNS = ',undone_at,undone_by,undo_summary,ai_summary_json';
// The audit reads at most this many options per demand (above it the demand goes to review).
const AUDIT_OPTIONS = 1001;

// History of batches that were in use (a batch still being assembled, or canceled while being
// assembled, never shows here).
async function loadUploads(ctx, supported, limit = 20, batchOn = false) {
  return rows(ctx, 'manheim_uploads', { select: UPLOAD_COLUMNS + (supported ? UNDO_COLUMNS : ''), environment: 'eq.' + ctx.environment, ...(batchOn ? { activated_at: 'not.is.null' } : {}), order: 'uploaded_at.desc', limit: String(limit) });
}

function withWhatsAppIdentity(item, userIds) {
  const contactId = item.contact_id || item.contact?.id, identity = userIds.find((entry) => entry.contact_id === contactId);
  const ownPhones = item.phones || [];
  return { ...item, whatsappUsername: identity?.username || null, whatsappWithoutPhone: Boolean(identity && !ownPhones.some((phone) => phone.is_current !== false)) };
}

// "key|criteriaHash" of every request compared with the active batch: at import (targets_json) and
// later (manheim_demand_syncs). null when neither could be read.
function comparedKeys(targets, syncs) {
  if (!Array.isArray(targets) && !Array.isArray(syncs)) return null;
  const known = new Set();
  (Array.isArray(targets) ? targets : []).forEach((target) => { if (target && target.key) known.add(target.key + '|' + target.criteriaHash); });
  (Array.isArray(syncs) ? syncs : []).forEach((row) => { if (row && row.demand_key) known.add(row.demand_key + '|' + row.criteria_hash); });
  return known;
}

// Counts of the active batch per demand: options eligible NOW (no past auction, valid MMR) and
// stored_count (cars the demand has in this batch, eligible or not). Before migration
// 20261030010000 the old summary answers (no stored count).
async function batchSummary(ctx, uploadId, call = rpc) {
  const args = { p_environment: ctx.environment, p_upload_id: uploadId };
  try { return await call(ctx, 'panel_manheim_batch_summary_v2', args); }
  catch (error) {
    if (!/PGRST202|42883|does not exist|Could not find the function/i.test(String(error && (error.code || error.message) || ''))) throw error;
    return call(ctx, 'panel_manheim_batch_summary', args);
  }
}

// What a demand has in the active batch, from the summary row: options eligible now, the served
// count and whether every option found already expired. A ficha waiting to be switched on again
// only shows BATE.
function batchCounts(row, reactivation = false) {
  const bate = row ? Number(row.bate_count) || 0 : 0;
  const porValor = row && !reactivation ? Number(row.por_valor_count) || 0 : 0;
  const total = row ? (reactivation ? bate : Number(row.match_count) || 0) : 0;
  const stored = row && row.stored_count !== undefined && row.stored_count !== null ? Number(row.stored_count) || 0 : null;
  return { matchCount: total, bateCount: bate, porValorCount: porValor, servedCount: bate + porValor, storedCount: stored, expired: total === 0 && stored !== null && stored > 0 };
}

function emptyCounts() {
  return { demands: 0, people: 0, served: 0, matches: 0, review: 0 };
}

// People and demands of BUSCAS, from the operational base only (never a Manheim table): fichas and
// Refs without ficha that entered in contact, and one match target per active demand.
const offerCounts = (row) => ({ lane: row ? row.lane_count : 0, offLane: row ? row.offlane_count : 0, incomplete: row ? row.incomplete_count : 0,
  selected: row ? row.selected_count : 0, selectedIds: row && Array.isArray(row.selected_ids) ? row.selected_ids : [], max: 10,
  // Selecionados que saíram por leilão passado (migração 20261027010000; antes dela, nenhum).
  endedSelected: row && Array.isArray(row.ended_selected) ? row.ended_selected : [] });

function demandContext(base) {
  const excluded = new Set(base.journeys.filter((journey) => journey.contact?.is_lead === false || journey.triageOut).map((journey) => journey.id));
  const excludedRefs = new Set(base.journeys.filter((journey) => excluded.has(journey.id)).flatMap((journey) => [journey.reference_code, ...base.refsOf(journey)]).filter(Boolean).map(upper));
  const people = base.journeys.filter((journey) => !excluded.has(journey.id)).flatMap((journey) => {
    const facts = base.contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: base.refsOf(journey) });
    if (!facts.entered) return [];
    const disposition = base.journeyDisposition(journey);
    const own = [journey.reference_code, ...base.refsOf(journey)].map(upper).filter(Boolean).map((ref) => base.groupedByRef.get(ref)).filter(Boolean);
    return [{ journey, facts, own, disposition }];
  });
  const orders = base.grouped.filter((order) => order.disposition !== 'DISCARDED' && !excludedRefs.has(upper(order.ref)) && !base.demands.owner.has(upper(order.ref)) && !order.journeyId).flatMap((order) => {
    const facts = base.contact.facts({ ref: order.ref });
    return facts.entered ? [{ order, facts }] : [];
  });
  // A ficha closed, discarded or switched off (and not eligible to come back) has no search:
  // it is not a target, not counted and not sent to review.
  const usableJourney = ({ journey, disposition }) => journey.status !== 'ENCERRADO' && (disposition?.status || null) !== 'DISCARDED' && (journey.enabled !== false || journey.reactivationEligible || journey.status === 'PARADO');
  const orderByRef = new Map(orders.map(({ order }) => [upper(order.ref), order]));
  const journeyDemandList = people.filter(usableJourney).flatMap(({ journey }) => (base.demands.byJourney.get(journey.id) || []).map((demand) => ({ demand, journey })));
  const orderDemandList = base.demands.orders.filter((demand) => orderByRef.has(upper(demand.ref))).map((demand) => ({ demand, order: orderByRef.get(upper(demand.ref)) }));
  const targets = [];
  const demandsByTarget = new Map();
  const addTargetDemand = (targetKey, demand) => { if (!demandsByTarget.has(targetKey)) demandsByTarget.set(targetKey, []); demandsByTarget.get(targetKey).push(demand); };
  journeyDemandList.forEach(({ demand, journey }) => {
    addTargetDemand('j:' + journey.id, demand);
    if (demand.active) targets.push(matchTarget(demand, { reactivation: journey.enabled === false || journey.status === 'PARADO' }));
  });
  orderDemandList.forEach(({ demand }) => {
    addTargetDemand('r:' + upper(demand.ref), demand);
    if (demand.active) targets.push(matchTarget(demand, { reactivation: false }));
  });
  targets.forEach((target) => { target.criteriaHash = criteriaHash(target); });
  const listed = [...journeyDemandList.map(({ demand }) => demand), ...orderDemandList.map(({ demand }) => demand)];
  return { people, orders, targets, targetByKey: new Map(targets.map((target) => [target.key, target])), demandsByTarget, listed };
}

// The match targets of today (used as the snapshot of a new batch).
async function loadMatchTargets(ctx) {
  const base = await loadBuscasBase(ctx, { allRows });
  return demandContext(base).targets;
}

async function latestLiveUpload(ctx, uploads, supported, batchOn) {
  const found = uploads.find((upload) => !upload.undone_at);
  if (found) return found;
  if (!supported) return null;
  return (await rows(ctx, 'manheim_uploads', { select: UPLOAD_COLUMNS + UNDO_COLUMNS, environment: 'eq.' + ctx.environment, ...(await liveUploadFilter(ctx, { rows })), order: 'uploaded_at.desc', limit: '1' }))[0] || null;
}

// Stored options of the batch (at most `perDemand` per demand), read again with today's demands.
async function liveOptions(ctx, uploadId, context, perDemand) {
  const stored = await rpc(ctx, 'panel_manheim_batch_top_options', { p_environment: ctx.environment, p_upload_id: uploadId, p_per_demand: perDemand });
  return (stored || []).flatMap((match) => {
    const key = match.journey_id ? 'j:' + match.journey_id : 'r:' + upper(match.calc_ref);
    const demands = context.demandsByTarget.get(key);
    return demands ? liveMatchesFor(match, demands) : [];
  });
}

// Options the audit reads: only the cars SELECTED for the customer (the ones a V1 or V2 can come
// from), one per VIN as the database groups them (memberMatchIds), never the whole demand: a broad
// demand (625 options) is read as its 6 selected cars. The database groups only the demands with a
// selection and answers one jsonb value per call, so neither the 8 s limit nor the PostgREST row
// limit (1000) cuts a demand. Without the selection table (migration not applied) it keeps the old
// reading.
// Demands per call: each one is grouped by VIN on its own, so a call stays far below the 8 s limit.
const SCOPE_DEMANDS_PER_CALL = 5;
const DEMAND_KEY = /^(journey:[0-9a-f-]{36}|ref:[A-Z0-9]{5}):(VALOR|CARRO)$/;
async function auditOptions(ctx, uploadId, context, services = { allRows, rpc }) {
  let selected;
  try { selected = await services.allRows(ctx, 'manheim_option_selections', { select: 'demand_key,match_id', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId, status: 'eq.SELECTED' }); }
  catch (_) { return { matches: await liveOptions(ctx, uploadId, context, AUDIT_OPTIONS), scope: null }; }
  const scope = [...new Set(selected.map((row) => row.demand_key))].filter((key) => DEMAND_KEY.test(key));
  const chosen = new Map();
  selected.forEach((row) => { if (!chosen.has(row.demand_key)) chosen.set(row.demand_key, new Set()); chosen.get(row.demand_key).add(String(row.match_id)); });
  const matches = [];
  for (let index = 0; index < scope.length; index += SCOPE_DEMANDS_PER_CALL) {
    const part = scope.slice(index, index + SCOPE_DEMANDS_PER_CALL);
    const stored = await services.rpc(ctx, 'panel_manheim_audit_selected_options', { p_environment: ctx.environment, p_upload_id: uploadId, p_demand_keys: part,
      p_match_ids: [...new Set(part.flatMap((key) => [...chosen.get(key)]))] });
    (Array.isArray(stored) ? stored : []).forEach((match) => {
      const demands = context.demandsByTarget.get(match.journey_id ? 'j:' + match.journey_id : 'r:' + upper(match.calc_ref));
      if (demands) matches.push(...liveMatchesFor(match, demands));
    });
  }
  // A car is in when any sale of its VIN group was selected for that demand.
  const isSelected = (match) => {
    const ids = chosen.get(match.demandKey);
    if (!ids) return false;
    const members = match.vehicle_json && match.vehicle_json.parsed && Array.isArray(match.vehicle_json.parsed.memberMatchIds) ? match.vehicle_json.parsed.memberMatchIds : [];
    return [match.id, ...members].some((id) => ids.has(String(id)));
  };
  return { matches: matches.filter(isSelected), scope };
}

// Input of MANHEIM_MATCH_AUDIT: the options of the active batch grouped by demand. Server only.
async function auditInputFor(ctx) {
  const [supported, batchOn] = await Promise.all([undoSupported(ctx, { rows }), batchSupported(ctx, { rows }).catch(() => false)]);
  const [base, uploads] = await Promise.all([loadBuscasBase(ctx, { allRows }), loadUploads(ctx, supported, 20, batchOn)]);
  const latest = await latestLiveUpload(ctx, uploads, supported, batchOn);
  const context = demandContext(base);
  const read = latest ? await auditOptions(ctx, latest.id, context) : { matches: [], scope: [] };
  return { upload: latest || null, base, demands: context.listed, matches: read.matches, scope: read.scope };
}

async function manheimView(ctx, options = {}) {
  if (options.auditInput) return auditInputFor(ctx);
  const [supported, batchOn] = await Promise.all([undoSupported(ctx, { rows }), batchSupported(ctx, { rows }).catch(() => false)]);
  const [base, uploads, meta, userIds, insights, checklist, stageIndex, scoreIndex] = await Promise.all([
    loadBuscasBase(ctx, { allRows }),
    loadUploads(ctx, supported, 20, batchOn),
    panelMeta(ctx),
    allRows(ctx, 'whatsapp_user_ids', { select: 'contact_id,username', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'conversation_pending_insights', { select: 'journey_id,heat,summary_text,next_step_text,last_ai_message_id,updated_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_checklist', { select: 'journey_id,status', environment: 'eq.' + ctx.environment }),
    loadSearchStageIndex(ctx),
    loadScoreIndex(ctx).catch(() => null)
  ]);
  // "O último upload" is the most recent ACTIVE batch, even beyond the history shown.
  const latest = await latestLiveUpload(ctx, uploads, supported, batchOn);
  const context = demandContext(base);
  const messageById = new Map(base.messages.filter((message) => !message.undone_at).map((message) => [message.id, message]));
  const scoreMessages = base.messageLinks.map((link) => { const message = messageById.get(link.message_id); return message ? { ...message, journey_id: link.journey_id } : null; }).filter(Boolean);
  const insightByJourney = new Map(insights.map((item) => [item.journey_id, item]));
  const withContactHeat = (item, facts, journey) => {
    const target = journey || item;
    const ready = score(item, target, { checklist, messages: scoreMessages }, scoreIndex || []);
    return decorateContact({ ...item, ...ready }, facts, insightByJourney.get(target.id), journey || (item.status ? item : null));
  };
  const items = context.people.map(({ journey, facts, own, disposition }) => {
    const phones = base.phonesFor(journey.contact_id);
    const item = withWhatsAppIdentity({ ...journey, phones, simulations: own.flatMap((order) => order.simulations || []), disposition: disposition?.status || null, discardReason: disposition?.discard_reason || null, dispositionUpdatedAt: disposition?.updated_at || null, linkedRefs: own.map((order) => order.ref) }, userIds);
    return withContactHeat(item, facts, item);
  });
  const orders = context.orders.map(({ order, facts }) => withContactHeat({ ...order, matchTarget: true }, facts, null));

  // Counts of the batch per demand, answered by the database. A demand counts only while it is
  // still a target today; a batch compared with an older criterion asks to be checked again.
  // The reads below do not depend on each other: they run together (they used to run one after the other).
  const activeIdsEarly = uploads.filter((row) => !row.undone_at).map((row) => row.id).concat(latest && !uploads.some((row) => row.id === latest.id) ? [latest.id] : []);
  const [summaryRead, offerRead, carsRead, hiddenRead, targetsRead, syncsRead] = await Promise.all([
    // A slow or failed summary never takes the whole tab down: only its counts say "Resumo indisponível".
    latest && batchOn ? batchSummary(ctx, latest.id).catch((error) => { console.error('[buscas-summary]', { message: String(error && (error.code || error.message) || 'UNKNOWN') }); return null; }) : [],
    latest && batchOn ? rpc(ctx, 'panel_manheim_offer_summary', { p_environment: ctx.environment, p_upload_id: latest.id }).catch(() => null) : [],
    batchOn && activeIdsEarly.length ? rpc(ctx, 'panel_manheim_batch_cars', { p_environment: ctx.environment, p_upload_ids: activeIdsEarly }).catch(() => []) : [],
    rows(ctx, 'panel_batch_hidden', { select: 'upload_id', environment: 'eq.' + ctx.environment, user_id: 'eq.' + ctx.panel.id, limit: '500' }).then((found) => found.map((row) => row.upload_id)).catch(() => null),
    // What was already compared with the active batch: the requests of the import and the ones compared later.
    latest && batchOn ? rows(ctx, 'manheim_uploads', { select: 'targets_json', environment: 'eq.' + ctx.environment, id: 'eq.' + latest.id, limit: '1' }).then((found) => found[0] && found[0].targets_json).catch(() => null) : null,
    latest && batchOn ? allRows(ctx, 'manheim_demand_syncs', { select: 'demand_key,criteria_hash', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id }).catch(() => null) : null
  ]);
  const compared = comparedKeys(targetsRead, syncsRead);
  const summary = summaryRead;
  const summaryUnavailable = summaryRead === null;
  // Selection for the customer (migration 20261006010000): counts per group and what is selected.
  // Before that migration the summary goes without it (null), never with a false zero.
  const offerRows = offerRead;
  const offerByKey = Array.isArray(offerRows) ? new Map(offerRows.map((row) => [row.demand_key, row])) : null;
  const summaryByKey = new Map((summary || []).map((row) => [row.demand_key, row]));
  const counts = { VALOR: emptyCounts(), CARRO: emptyCounts(), total: { people: 0, served: 0, matches: 0, review: 0 } };
  const people = { VALOR: new Set(), CARRO: new Set() }, served = { VALOR: new Set(), CARRO: new Set() }, allPeople = new Set(), allServed = new Set();
  const personKey = (demand) => demand.journeyId ? 'j:' + demand.journeyId : 'r:' + upper(demand.ref);
  context.listed.filter((demand) => demand.active).forEach((demand) => { counts[demand.mode].demands += 1; people[demand.mode].add(personKey(demand)); allPeople.add(personKey(demand)); });
  const demands = context.listed.filter((demand) => demand.active).map((demand) => {
    const stage = demand.journeyId ? stageIndex.get(demand.journeyId)?.modes?.[demand.mode] || null : null;
    const target = context.targetByKey.get(demand.key);
    const row = summaryByKey.get(demand.key);
    const reactivation = Boolean(target && target.reactivation);
    // A ficha waiting to be switched on again only shows exact fits (BATE).
    const batchNow = batchCounts(row, reactivation);
    const { matchCount, servedCount } = batchNow;
    const hashes = row && Array.isArray(row.criteria_hashes) ? row.criteria_hashes : [];
    const stale = Boolean(row && target && hashes.length && (hashes.length > 1 || hashes[0] !== target.criteriaHash));
    if (matchCount) { counts[demand.mode].matches += matchCount; counts.total.matches += matchCount; }
    if (servedCount) { served[demand.mode].add(personKey(demand)); allServed.add(personKey(demand)); }
    return {
      key: demand.key, mode: demand.mode, targetType: demand.targetType, journeyId: demand.journeyId || null, ref: demand.ref || null, wishes: demand.activeWishes,
      bidCents: demand.mode === 'VALOR' ? demand.bidCents : null, issues: demand.issues, ...demandPerson(base, demand), stage: stage && stage.stage || null, stageLabel: stage && stage.label || null,
      reactivation, criteriaHash: target ? target.criteriaHash : null, matchCount,
      // Compared with the active batch with today's criterion: only the proof (import snapshot or
      // manheim_demand_syncs) says so, never the options it happens to have (null when unknown).
      compared: compared && target ? compared.has(demand.key + '|' + target.criteriaHash) : null, bateCount: batchNow.bateCount, porValorCount: batchNow.porValorCount,
      storedCount: batchNow.storedCount, expired: batchNow.expired, presentedCount: row ? row.presented_count : 0, stale,
      offer: offerByKey ? offerCounts(offerByKey.get(demand.key)) : null,
      // The selection could not be read (migration pending): say so, never zero.
      offerPending: Boolean(latest && batchOn && !offerByKey)
    };
  });
  ['VALOR', 'CARRO'].forEach((mode) => { counts[mode].people = people[mode].size; counts[mode].served = served[mode].size; });
  const review = context.listed.filter((demand) => !demand.active).map((demand) => reviewItem(base, demand));
  counts.total.people = allPeople.size; counts.total.served = allServed.size; counts.total.review = review.length;
  review.forEach((item) => { if (counts[item.mode]) counts[item.mode].review += 1; });

  // MANHEIM_MATCH_AUDIT: off by default, then nothing is read and nothing is blocked. On, the
  // server reads the options of each demand itself (never the browser).
  let audit = { state: manheimAudit.status(), byDemand: {} };
  if (audit.state === 'LIGADA' && latest) {
    const read = await auditOptions(ctx, latest.id, context).catch(() => ({ matches: [], scope: [] }));
    audit = await manheimAudit.viewState(ctx, { upload: latest, base, demands: context.listed, matches: read.matches, scope: read.scope }).catch(() => ({ state: 'ERRO', byDemand: {} }));
  }

  // Operational count of each active batch: different cars with a valid MMR, answered by the
  // database (the number frozen at upload may include cars that are no longer eligible). Undone
  // batches keep the number they had.
  const activeIds = activeIdsEarly;
  const operational = new Map();
  if (batchOn && activeIds.length) (carsRead || []).forEach((row) => operational.set(row.upload_id, Number(row.car_count) || 0));
  activeIds.forEach((uploadId) => { if (batchOn && !operational.has(uploadId)) operational.set(uploadId, 0); });
  const upload = latest ? { ...latest, frozen_matched_vehicle_count: latest.matched_vehicle_count, matched_vehicle_count: operational.has(latest.id) ? operational.get(latest.id) : latest.matched_vehicle_count, current_lead_count: allServed.size } : null;
  // Undone batches this operator hid from the list (display only; null before the migration).
  const hiddenBatchIds = hiddenRead;
  const batches = uploads.map((row) => ({
    id: row.id, uploadedAt: row.uploaded_at, fileCount: row.source_file_count, vehicleCount: row.vehicle_count,
    matchCount: operational.has(row.id) ? operational.get(row.id) : row.matched_vehicle_count, frozenMatchCount: row.matched_vehicle_count, leadCount: row.lead_count,
    status: row.undone_at ? 'UNDONE' : 'ACTIVE', undoneAt: row.undone_at || null, undoSummary: row.undo_summary || null, ai: row.ai_summary_json || null, current: Boolean(latest && latest.id === row.id)
  }));
  return {
    environment: ctx.environment, modelDictionary: ctx.modelDictionary,
    items: items.map((item) => decorateWithSearchStage(item, stageIndex)),
    orders: orders.map((item) => decorateWithSearchStage(item, stageIndex)),
    upload, uploads: batches, hiddenBatchIds, undoAvailable: supported, batchAvailable: batchOn, demands, review, counts, historyIncomplete: false, meta, audit, summaryUnavailable
  };
}

module.exports = { batchCounts, batchSummary, comparedKeys, manheimView, loadUploads, loadMatchTargets, demandContext, auditInputFor, auditOptions, latestLiveUpload, liveOptions };

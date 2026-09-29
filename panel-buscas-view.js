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

function emptyCounts() {
  return { demands: 0, people: 0, served: 0, matches: 0, review: 0 };
}

// People and demands of BUSCAS, from the operational base only (never a Manheim table): fichas and
// Refs without ficha that entered in contact, and one match target per active demand.
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

// Input of MANHEIM_MATCH_AUDIT: the options of the active batch grouped by demand. Server only.
async function auditInputFor(ctx) {
  const supported = await undoSupported(ctx, { rows });
  const batchOn = await batchSupported(ctx, { rows }).catch(() => false);
  const [base, uploads] = await Promise.all([loadBuscasBase(ctx, { allRows }), loadUploads(ctx, supported, 20, batchOn)]);
  const latest = await latestLiveUpload(ctx, uploads, supported, batchOn);
  const context = demandContext(base);
  const matches = latest ? await liveOptions(ctx, latest.id, context, AUDIT_OPTIONS) : [];
  return { upload: latest || null, base, demands: context.listed, matches };
}

async function manheimView(ctx, options = {}) {
  if (options.auditInput) return auditInputFor(ctx);
  const supported = await undoSupported(ctx, { rows });
  const batchOn = await batchSupported(ctx, { rows }).catch(() => false);
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
  const summary = latest && batchOn ? await rpc(ctx, 'panel_manheim_batch_summary', { p_environment: ctx.environment, p_upload_id: latest.id }) : [];
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
    const matchCount = row ? (reactivation ? row.bate_count : row.match_count) : 0;
    const servedCount = row ? (reactivation ? row.bate_count : row.bate_count + row.por_valor_count) : 0;
    const hashes = row && Array.isArray(row.criteria_hashes) ? row.criteria_hashes : [];
    const stale = Boolean(row && target && hashes.length && (hashes.length > 1 || hashes[0] !== target.criteriaHash));
    if (matchCount) { counts[demand.mode].matches += matchCount; counts.total.matches += matchCount; }
    if (servedCount) { served[demand.mode].add(personKey(demand)); allServed.add(personKey(demand)); }
    return {
      key: demand.key, mode: demand.mode, targetType: demand.targetType, journeyId: demand.journeyId || null, ref: demand.ref || null, wishes: demand.activeWishes,
      bidCents: demand.mode === 'VALOR' ? demand.bidCents : null, issues: demand.issues, ...demandPerson(base, demand), stage: stage && stage.stage || null, stageLabel: stage && stage.label || null,
      reactivation, matchCount, bateCount: row ? row.bate_count : 0, porValorCount: reactivation ? 0 : row ? row.por_valor_count : 0, presentedCount: row ? row.presented_count : 0, stale
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
    const matches = await liveOptions(ctx, latest.id, context, AUDIT_OPTIONS).catch(() => []);
    audit = await manheimAudit.viewState(ctx, { upload: latest, base, demands: context.listed, matches }).catch(() => ({ state: 'ERRO', byDemand: {} }));
  }

  // Operational count of each active batch: different cars with a valid MMR, answered by the
  // database (the number frozen at upload may include cars that are no longer eligible). Undone
  // batches keep the number they had.
  const activeIds = uploads.filter((row) => !row.undone_at).map((row) => row.id).concat(latest && !uploads.some((row) => row.id === latest.id) ? [latest.id] : []);
  const operational = new Map();
  if (batchOn && activeIds.length) (await rpc(ctx, 'panel_manheim_batch_cars', { p_environment: ctx.environment, p_upload_ids: activeIds }).catch(() => []) || []).forEach((row) => operational.set(row.upload_id, Number(row.car_count) || 0));
  activeIds.forEach((uploadId) => { if (batchOn && !operational.has(uploadId)) operational.set(uploadId, 0); });
  const upload = latest ? { ...latest, frozen_matched_vehicle_count: latest.matched_vehicle_count, matched_vehicle_count: operational.has(latest.id) ? operational.get(latest.id) : latest.matched_vehicle_count, current_lead_count: allServed.size } : null;
  const batches = uploads.map((row) => ({
    id: row.id, uploadedAt: row.uploaded_at, fileCount: row.source_file_count, vehicleCount: row.vehicle_count,
    matchCount: operational.has(row.id) ? operational.get(row.id) : row.matched_vehicle_count, frozenMatchCount: row.matched_vehicle_count, leadCount: row.lead_count,
    status: row.undone_at ? 'UNDONE' : 'ACTIVE', undoneAt: row.undone_at || null, undoSummary: row.undo_summary || null, ai: row.ai_summary_json || null, current: Boolean(latest && latest.id === row.id)
  }));
  return {
    environment: ctx.environment,
    items: items.map((item) => decorateWithSearchStage(item, stageIndex)),
    orders: orders.map((item) => decorateWithSearchStage(item, stageIndex)),
    upload, uploads: batches, undoAvailable: supported, batchAvailable: batchOn, demands, review, counts, historyIncomplete: false, meta, audit
  };
}

module.exports = { manheimView, loadUploads, loadMatchTargets, demandContext, auditInputFor, latestLiveUpload, liveOptions };

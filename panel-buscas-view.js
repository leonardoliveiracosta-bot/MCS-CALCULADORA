'use strict';

// GET /api/panel/records?view=manheim: the BUSCAS tab. The latest ACTIVE import batch, its
// matches read with today's demands (one per person and mode), the batch history and the
// demands waiting for review. VALOR and CARRO are counted separately; the total is people.
const { allRows, panelMeta, rows } = require('./panel-server');
const { score, loadScoreVehicles } = require('./panel-ready');
const { decorateContact } = require('./panel-contact');
const { decorateWithSearchStage, loadSearchStageIndex } = require('./panel-search-stage');
const { activeFilter, undoSupported } = require('./panel-manheim-state');
const { demandPerson, liveMatchesFor, loadBuscasBase, matchTarget, reviewItem, upper } = require('./panel-buscas');
const vehicleMatch = require('./vehicle-match');

const UPLOAD_COLUMNS = 'id,source_file_count,vehicle_count,matched_vehicle_count,lead_count,headers_json,header_map,uploaded_at';
const UNDO_COLUMNS = ',undone_at,undone_by,undo_summary,ai_summary_json';

async function loadUploads(ctx, supported, limit = 20) {
  return rows(ctx, 'manheim_uploads', { select: UPLOAD_COLUMNS + (supported ? UNDO_COLUMNS : ''), environment: 'eq.' + ctx.environment, order: 'uploaded_at.desc', limit: String(limit) });
}

function withWhatsAppIdentity(item, userIds) {
  const contactId = item.contact_id || item.contact?.id, identity = userIds.find((entry) => entry.contact_id === contactId);
  const ownPhones = item.phones || [];
  return { ...item, whatsappUsername: identity?.username || null, whatsappWithoutPhone: Boolean(identity && !ownPhones.some((phone) => phone.is_current !== false)) };
}

function emptyCounts() {
  return { demands: 0, people: 0, served: 0, matches: 0, review: 0 };
}

async function manheimView(ctx) {
  const supported = await undoSupported(ctx, { rows });
  const active = supported ? { undone_at: 'is.null' } : {};
  const [base, uploads, meta, userIds, insights, checklist, vitrineRows, stageIndex] = await Promise.all([
    loadBuscasBase(ctx, { allRows }),
    loadUploads(ctx, supported),
    panelMeta(ctx),
    allRows(ctx, 'whatsapp_user_ids', { select: 'contact_id,username', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'conversation_pending_insights', { select: 'journey_id,heat,summary_text,next_step_text,last_ai_message_id,updated_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_checklist', { select: 'journey_id,status', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'vitrines', { select: 'journey_id', environment: 'eq.' + ctx.environment }),
    loadSearchStageIndex(ctx)
  ]);
  // "O último upload" is the most recent ACTIVE batch, even beyond the history shown.
  const latest = uploads.find((upload) => !upload.undone_at) || (supported ? (await rows(ctx, 'manheim_uploads', { select: UPLOAD_COLUMNS + UNDO_COLUMNS, environment: 'eq.' + ctx.environment, undone_at: 'is.null', order: 'uploaded_at.desc', limit: '1' }))[0] || null : null);
  const matches = latest ? await allRows(ctx, 'manheim_matches', {
    select: 'id,journey_id,calc_ref,match_kind,match_reason,mmr_status,row_fingerprint,vehicle_json,presented_unit_id,created_at' + (supported ? ',logical_mode' : ''),
    environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id, ...active, order: 'created_at.asc'
  }) : [];
  const insightByJourney = new Map(insights.map((item) => [item.journey_id, item]));
  const scoreVehicles = await loadScoreVehicles(ctx).catch(() => []);
  const messageById = new Map(base.messages.filter((message) => !message.undone_at).map((message) => [message.id, message]));
  const scoreMessages = base.messageLinks.map((link) => { const message = messageById.get(link.message_id); return message ? { ...message, journey_id: link.journey_id } : null; }).filter(Boolean);
  const withContactHeat = (item, facts, journey) => {
    const target = journey || item;
    const ready = score(item, target, { checklist, messages: scoreMessages }, scoreVehicles);
    return decorateContact({ ...item, ...ready }, facts, insightByJourney.get(target.id), journey || (item.status ? item : null));
  };

  // People shown in BUSCAS: fichas and Refs without ficha that entered in contact.
  const excluded = new Set(base.journeys.filter((journey) => journey.contact?.is_lead === false).map((journey) => journey.id));
  const excludedRefs = new Set(base.journeys.filter((journey) => excluded.has(journey.id)).flatMap((journey) => [journey.reference_code, ...base.refsOf(journey)]).filter(Boolean).map(upper));
  const items = base.journeys.filter((journey) => !excluded.has(journey.id)).flatMap((journey) => {
    const facts = base.contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: base.refsOf(journey) });
    if (!facts.entered) return [];
    const disposition = base.journeyDisposition(journey);
    const own = [journey.reference_code, ...base.refsOf(journey)].map(upper).filter(Boolean).map((ref) => base.groupedByRef.get(ref)).filter(Boolean);
    const phones = base.phonesFor(journey.contact_id);
    const item = withWhatsAppIdentity({ ...journey, phones, simulations: own.flatMap((order) => order.simulations || []), disposition: disposition?.status || null, discardReason: disposition?.discard_reason || null, dispositionUpdatedAt: disposition?.updated_at || null, linkedRefs: own.map((order) => order.ref) }, userIds);
    return [withContactHeat(item, facts, item)];
  });
  const itemById = new Map(items.map((item) => [item.id, item]));
  const orders = base.grouped.filter((order) => order.disposition !== 'DISCARDED' && !excludedRefs.has(upper(order.ref)) && !base.demands.owner.has(upper(order.ref)) && !order.journeyId).flatMap((order) => {
    const facts = base.contact.facts({ ref: order.ref });
    return facts.entered ? [withContactHeat({ ...order, matchTarget: true }, facts, null)] : [];
  });
  const orderByRef = new Map(orders.map((order) => [upper(order.ref), order]));

  // Demands of those people. A ficha closed, switched off (and not eligible to come back) or
  // discarded is not a match target.
  // A ficha closed, discarded or switched off (and not eligible to come back) has no search:
  // it is not a target, not counted and not sent to review.
  const usableJourney = (item) => item.status !== 'ENCERRADO' && item.disposition !== 'DISCARDED' && (item.enabled !== false || item.reactivationEligible || item.status === 'PARADO');
  const journeyDemandList = items.filter(usableJourney).flatMap((item) => (base.demands.byJourney.get(item.id) || []).map((demand) => ({ demand, item })));
  const orderDemandList = base.demands.orders.filter((demand) => orderByRef.has(upper(demand.ref))).map((demand) => ({ demand, order: orderByRef.get(upper(demand.ref)) }));
  const targets = [];
  const demandsByTarget = new Map();
  const addTargetDemand = (targetKey, demand) => { if (!demandsByTarget.has(targetKey)) demandsByTarget.set(targetKey, []); demandsByTarget.get(targetKey).push(demand); };
  journeyDemandList.forEach(({ demand, item }) => {
    addTargetDemand('j:' + item.id, demand);
    if (demand.active) targets.push(matchTarget(demand, { reactivation: item.enabled === false || item.status === 'PARADO' }));
  });
  orderDemandList.forEach(({ demand }) => {
    addTargetDemand('r:' + upper(demand.ref), demand);
    if (demand.active) targets.push(matchTarget(demand, { reactivation: false }));
  });

  // M17: combinations are read with today's state and today's rule, per mode.
  const liveRaw = matches.flatMap((match) => {
    const key = match.journey_id ? 'j:' + match.journey_id : 'r:' + upper(match.calc_ref);
    const demands = demandsByTarget.get(key);
    return demands ? liveMatchesFor(match, demands) : [];
  });
  const withVitrine = new Set(vitrineRows.map((row) => row.journey_id).filter(Boolean));
  const recentCut = Date.now() - 60 * 86400000;
  const activeOther = (journey) => journey && journey.status !== 'ENCERRADO' && journey.enabled !== false && (Date.parse(journey.created_at || 0) >= recentCut || withVitrine.has(journey.id));
  const journeysByVin = new Map();
  liveRaw.forEach((match) => { const vin = upper(match.vehicle_json?.parsed?.vin); if (!vin || !match.journey_id) return; if (!journeysByVin.has(vin)) journeysByVin.set(vin, new Set()); journeysByVin.get(vin).add(match.journey_id); });
  const liveMatches = liveRaw.map((match) => {
    const parsed = match.vehicle_json?.parsed || {};
    const own = base.journeyById.get(match.journey_id);
    // "Cabe no lance" only exists in VALOR: CARRO never compares money.
    const mmr = Number(parsed.mmrCents) || 0, bid = Number(match.bidCents) || 0;
    const fitsBid = match.logical_mode === 'VALOR' && mmr && bid ? mmr <= bid : null;
    const vin = upper(parsed.vin);
    const alsoFitsFor = vin ? [...new Set([...(journeysByVin.get(vin) || [])].filter((id) => id !== match.journey_id).map((id) => base.journeyById.get(id)).filter((journey) => activeOther(journey) && journey.contact_id !== own?.contact_id).map((journey) => journey.contact?.display_name || journey.reference_code || 'outro cliente'))] : [];
    return { ...match, fitsBid, alsoFitsFor };
  });

  // Counters per mode. The same demand is counted once per side; the total counts people.
  const counts = { VALOR: emptyCounts(), CARRO: emptyCounts(), total: { people: 0, served: 0, matches: liveMatches.length, review: 0 } };
  const people = { VALOR: new Set(), CARRO: new Set() }, served = { VALOR: new Set(), CARRO: new Set() }, allPeople = new Set(), allServed = new Set();
  const personKey = (demand) => demand.journeyId ? 'j:' + demand.journeyId : 'r:' + upper(demand.ref);
  const listed = [...journeyDemandList.map(({ demand }) => demand), ...orderDemandList.map(({ demand }) => demand)];
  listed.filter((demand) => demand.active).forEach((demand) => { counts[demand.mode].demands += 1; people[demand.mode].add(personKey(demand)); allPeople.add(personKey(demand)); });
  liveMatches.forEach((match) => {
    counts[match.logical_mode].matches += 1;
    if (vehicleMatch.countsAsServed(match.match_kind)) { const key = match.journey_id ? 'j:' + match.journey_id : 'r:' + upper(match.calc_ref); served[match.logical_mode].add(key); allServed.add(key); }
  });
  ['VALOR', 'CARRO'].forEach((mode) => { counts[mode].people = people[mode].size; counts[mode].served = served[mode].size; });
  const review = listed.filter((demand) => !demand.active).map((demand) => reviewItem(base, demand));
  counts.total.people = allPeople.size; counts.total.served = allServed.size; counts.total.review = review.length;
  review.forEach((item) => { if (counts[item.mode]) counts[item.mode].review += 1; });

  const demands = listed.filter((demand) => demand.active).map((demand) => {
    const stage = demand.journeyId ? stageIndex.get(demand.journeyId)?.modes?.[demand.mode] || null : null;
    return { key: demand.key, mode: demand.mode, targetType: demand.targetType, journeyId: demand.journeyId || null, ref: demand.ref || null, wishes: demand.activeWishes, bidCents: demand.mode === 'VALOR' ? demand.bidCents : null, issues: demand.issues, ...demandPerson(base, demand), stage: stage && stage.stage || null, stageLabel: stage && stage.label || null };
  });

  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
  const [history, stored] = await Promise.all([
    allRows(ctx, 'manheim_uploads', { select: 'id,vehicle_count,uploaded_at', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + cutoff, ...active }),
    allRows(ctx, 'manheim_vehicles', { select: 'upload_id,row_fingerprint', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + cutoff, ...active })
  ]);
  const storedByUpload = new Map(); stored.forEach((row) => storedByUpload.set(row.upload_id, (storedByUpload.get(row.upload_id) || 0) + 1));
  const historyIncomplete = history.some((upload) => Number(upload.vehicle_count) > 0 && (storedByUpload.get(upload.id) || 0) < Number(upload.vehicle_count));
  // B5: people served by today's combinations (BATE or POR VALOR), not the count frozen at upload.
  const upload = latest ? { ...latest, current_lead_count: allServed.size } : null;
  const batches = uploads.map((row) => ({
    id: row.id, uploadedAt: row.uploaded_at, fileCount: row.source_file_count, vehicleCount: row.vehicle_count, matchCount: row.matched_vehicle_count, leadCount: row.lead_count,
    status: row.undone_at ? 'UNDONE' : 'ACTIVE', undoneAt: row.undone_at || null, undoSummary: row.undo_summary || null, ai: row.ai_summary_json || null, current: Boolean(latest && latest.id === row.id)
  }));
  return {
    environment: ctx.environment,
    items: items.map((item) => decorateWithSearchStage(item, stageIndex)),
    orders: orders.map((item) => decorateWithSearchStage(item, stageIndex)),
    upload, uploads: batches, undoAvailable: supported, matches: liveMatches, demands, targets, review, counts, historyIncomplete, meta
  };
}

module.exports = { manheimView, loadUploads };

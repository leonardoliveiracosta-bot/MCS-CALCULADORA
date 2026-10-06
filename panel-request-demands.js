'use strict';
// Conversation requests use the same live demands as imports, options and vitrines. A request
// already carried from PESQUISAS stays linked to its versions, without rewriting calculator data.
const requests = require('./vehicle-requests');
const { finalizeDemand, normalizeWishlist } = require('./panel-domain');
const { fichaOf } = require('./panel-search-to-ficha');
const catalog = require('./vehicle-catalog');
// The active criterion of each request is its latest version (max created_at, then id); the older
// versions stay only as history. Never depends on the order the rows were read in.
function latestVersions(versions) {
  const latest = new Map();
  (versions || []).forEach((version) => {
    const old = latest.get(version.request_id);
    const newer = !old || String(version.created_at || '') > String(old.created_at || '') || (String(version.created_at || '') === String(old.created_at || '') && String(version.id || '') > String(old.id || ''));
    if (newer) latest.set(version.request_id, version);
  });
  return latest;
}
async function attach(ctx, base, read) {
  const env = 'eq.' + ctx.environment;
  const [stored, versions, marks] = await Promise.all([
    read(ctx, 'vehicle_requests', { select: 'id,journey_id', environment: env }),
    read(ctx, 'vehicle_request_versions', { select: 'id,request_id,criteria_json,evidence_json,needs_review,review_reason,created_at', environment: env, order: 'created_at.asc,id.asc' }),
    read(ctx, 'journey_declarations', { select: 'journey_id,value_json', environment: env, field: 'eq.VEICULO', order: 'created_at.asc' })
  ]);
  const latest = latestVersions(versions);
  const carried = new Map(marks.filter((m) => m.value_json?.origin === 'PESQUISAS').map((m) => [m.value_json.requestKey, m]));
  for (const r of stored) {
    const v = latest.get(r.id); if (!v) continue;
    const criteria = v.criteria_json || {};
    const described = requests.describe({ criteria, needsReview: v.needs_review, reviewReason: v.review_reason });
    const evidence = Object.values(v.evidence_json || {}).flat().map((id) => ({ id }));
    const journeyId = r.journey_id || fichaOf({ evidence }, base);
    const journey = base.journeyById.get(journeyId); if (!journey) continue;
    let demands = base.demands.byJourney.get(journeyId) || [];
    // Remove only wishes explicitly linked to this request; a review blocks its old options too.
    demands = demands.map((d) => finalizeDemand({ ...d, wishes: d.wishes.filter((w) => w.requestId !== r.id) }));
    if (!described.comparable) { base.demands.byJourney.set(journeyId, demands); continue; }
    const mode = described.searchMode;
    let demand = demands.find((d) => d.mode === mode);
    if (!demand) {
      demand = { key: `journey:${journeyId}:${mode}`, targetType: 'JOURNEY', journeyId, ref: journey.reference_code || null, mode, source: 'CONVERSA', wishes: [], bidCents: null };
      demands.push(demand);
    }
    const mark = carried.get('conversa:' + r.id);
    const wish = normalizeWishlist({ ...criteria, requestId: r.id });
    // Legacy PESQUISAS carries did not store requestId. Their mark proves ownership of that mode.
    if (mark && mark.journey_id === journeyId && mark.value_json.mode === mode) {
      const old = mark.value_json.modeWishlists || [];
      demand.wishes = demand.wishes.filter((w) => w.requestId || !old.some((o) => catalog.normalizedModel(o.model,o.make) === catalog.normalizedModel(w.model,w.make) && ['yearMin','yearMax','minMiles','maxMiles','budgetUsd'].every((f) => (o[f] ?? null) === (w[f] ?? null))));
    }
    const same = demand.wishes.find((w) => !w.requestId && catalog.normalizedModel(w.model,w.make) === catalog.normalizedModel(wish.model,wish.make)
      && ['yearMin','yearMax','minMiles','maxMiles'].every((f) => (w[f] ?? null) === (wish[f] ?? null))
      && (w.budgetUsd || (mode === 'VALOR' ? demand.bidCents / 100 : null) || null) === (wish.budgetUsd || null));
    if (!same) demand.wishes.push(wish);
    base.demands.byJourney.set(journeyId, demands.map((d) => finalizeDemand(d)));
  }
  return base;
}
// The same conversation requests for ONE ficha (the ficha screen), reading only what it needs: the
// requests linked to it directly or by its messages (a message owned by two fichas links neither, as
// in BUSCAS). demands: the ficha's own demands (journeyDemands). Returns its demands with the requests.
async function forJourney(ctx, journey, demands, read) {
  const env = 'eq.' + ctx.environment;
  const [stored, versions, ownLinks] = await Promise.all([
    read(ctx, 'vehicle_requests', { select: 'id,journey_id', environment: env }),
    read(ctx, 'vehicle_request_versions', { select: 'id,request_id,evidence_json,created_at', environment: env, order: 'created_at.asc,id.asc' }),
    read(ctx, 'message_journeys', { select: 'message_id', environment: env, journey_id: 'eq.' + journey.id, undone_at: 'is.null' })
  ]);
  const own = new Set(ownLinks.map((link) => link.message_id));
  const latest = latestVersions(versions);
  const evidenceOf = (request) => Object.values((latest.get(request.id) || {}).evidence_json || {}).flat().map(String);
  const candidates = stored.filter((request) => request.journey_id === journey.id || (!request.journey_id && evidenceOf(request).some((id) => own.has(id))));
  if (!candidates.length) return demands;
  const evidence = [...new Set(candidates.flatMap(evidenceOf))].filter((id) => /^[0-9a-f-]{36}$/.test(id));
  const messageLinks = [];
  for (let index = 0; index < evidence.length; index += 150) messageLinks.push(...await read(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null', message_id: 'in.(' + evidence.slice(index, index + 150).join(',') + ')' }));
  const base = { journeyById: new Map([[journey.id, journey]]), demands: { byJourney: new Map([[journey.id, demands]]) }, messageLinks };
  const ids = new Set(candidates.map((request) => request.id));
  await attach(ctx, base, (c, table, query) => table === 'vehicle_requests' ? Promise.resolve(stored.filter((request) => ids.has(request.id)))
    : table === 'vehicle_request_versions' ? read(c, table, { ...query, request_id: 'in.(' + [...ids].join(',') + ')' }) : read(c, table, { ...query, journey_id: 'eq.' + journey.id }));
  return base.demands.byJourney.get(journey.id) || demands;
}
module.exports = { attach, forJourney, latestVersions };

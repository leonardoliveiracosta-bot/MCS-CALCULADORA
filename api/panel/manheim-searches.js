'use strict';
const { allRows, insert, jsonBody, patchRows, requirePanel, rows, safeText, send } = require('../../panel-server');
const vehicleMatch = require('../../vehicle-match');
const { demandPerson, loadBuscasBase, upper } = require('../../panel-buscas');
const { searchIdentity } = require('../../panel-search-stage');
module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'POST') {
      const body = await jsonBody(req, 2048);
      const key = safeText(body.key, 180, true);
      if (!key) return send(res, 400, { error: 'SEARCH_KEY_INVALID' });
      const patch = { created: body.created === true, updated_at: new Date().toISOString(), updated_by: ctx.panel.id };
      const existing = await rows(ctx, 'manheim_saved_searches', { select: 'id', environment: 'eq.' + ctx.environment, search_key: 'eq.' + key, limit: '1' });
      if (existing[0]) await patchRows(ctx, 'manheim_saved_searches', { environment: 'eq.' + ctx.environment, search_key: 'eq.' + key }, patch);
      else await insert(ctx, 'manheim_saved_searches', { environment: ctx.environment, search_key: key, ...patch }, false);
      return send(res, 200, { saved: true });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const [base, saved] = await Promise.all([
      loadBuscasBase(ctx, { allRows }),
      allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created', environment: 'eq.' + ctx.environment })
    ]);
    return send(res, 200, buildSavedSearches(base, saved));
  } catch (_) { return send(res, 500, { error: 'SEARCHES_UNAVAILABLE' }); }
};

// "Quais buscas salvar no Manheim", per mode. One person counts once per mode; the aggregated
// range only widens what is searched in the Manheim, it never decides who a car serves (each car
// of the CSV is checked again against each person's own criteria).
function buildSavedSearches(base, saved, now = Date.now()) {
  const closed = (journey) => !journey || journey.status === 'ENCERRADO' || journey.status === 'PARADO' || journey.enabled === false || base.journeyDisposition(journey)?.status === 'DISCARDED' || journey.contact?.is_lead === false || journey.triageOut === true;
  const people = [];
  // Anexo A (surpresa 2): a discarded person or a paused ficha (PARADO) is not a search to save.
  base.journeys.forEach((journey) => {
    if (closed(journey) || !base.journeyEntered(journey)) return;
    const client = demandPerson(base, { journeyId: journey.id });
    (base.demands.byJourney.get(journey.id) || []).forEach((demand) => people.push({ lead: 'journey:' + journey.id, demand, client, latestAt: journey.updated_at || journey.created_at }));
  });
  const cutoff = now - 30 * 86400000;
  base.demands.orders.forEach((demand) => {
    const order = base.groupedByRef.get(upper(demand.ref));
    if (!order || order.disposition === 'DISCARDED' || (Date.parse(demand.occurredAt) || 0) < cutoff || !base.orderEntered(demand.ref)) return;
    people.push({ lead: 'order:' + demand.ref, demand, client: demandPerson(base, demand), latestAt: demand.occurredAt });
  });
  const groups = new Map();
  const modeLeads = { CARRO: new Set(), VALOR: new Set() };
  const review = [];
  const bump = (list, value) => { if (Number(value) > 0) list.push(Number(value)); };
  for (const { lead, demand, client, latestAt } of people) {
    if (!demand.active) { review.push({ lead, key: demand.key, mode: demand.mode, issues: demand.issues, client }); continue; }
    modeLeads[demand.mode].add(lead);
    for (const wish of demand.activeWishes) {
      const identity = searchIdentity(wish, demand.mode);
      if (!identity) continue;
      if (!groups.has(identity.key)) groups.set(identity.key, { key: identity.key, mode: demand.mode, basis: identity.basis, make: wish.make, model: wish.model, leads: new Map(), yearMins: [], yearMaxs: [], milesMins: [], milesMaxs: [], mmrMin: [], mmrMax: [], unboundedYearMin: false, unboundedMilesMin: false, unboundedMilesMax: false, latestAt: 0 });
      const group = groups.get(identity.key);
      group.leads.set(lead, client);
      group.latestAt = Math.max(group.latestAt, Date.parse(latestAt || 0) || 0);
      if (demand.mode === 'CARRO') {
        group.unboundedYearMin ||= !wish.yearMin; group.unboundedMilesMin ||= wish.minMiles == null; group.unboundedMilesMax ||= wish.maxMiles == null;
        bump(group.yearMins,wish.yearMin); bump(group.yearMaxs,wish.yearMax || new Date(now).getUTCFullYear()+1); bump(group.milesMins,wish.minMiles); bump(group.milesMaxs,wish.maxMiles);
      } else {
        const bid=wish.budgetUsd ? wish.budgetUsd*100 : demand.bidCents, band=vehicleMatch.valueBand(bid);
        if(band){group.mmrMin.push(Math.max(175000,band.minCents));group.mmrMax.push(band.maxCents);}
        group.milesMaxs.push(Math.min(vehicleMatch.mileageCap(bid),wish.maxMiles ?? Infinity));
        group.unboundedMilesMin ||= wish.minMiles == null; bump(group.milesMins,wish.minMiles);
      }
    }
  }
  const marked = new Map(saved.map((row) => [row.search_key, row.created]));
  const seen = { CARRO: new Set(), VALOR: new Set() };
  const bySize = (a, b) => b.leads.size - a.leads.size || a.key.localeCompare(b.key);
  const nearMiles = (group) => group.mode === 'CARRO' ? Math.floor(Math.max(...group.milesMaxs) * 115 / 100) : Math.max(...group.milesMaxs);
  const shape = (group, index) => {
    const total = modeLeads[group.mode].size;
    group.leads.forEach((_, lead) => seen[group.mode].add(lead));
    return {
      key: group.key, mode: group.mode, basis: group.basis, make: group.make, model: group.model,
      // The Manheim search covers every customer of the group; each car is checked again per customer.
      // POR CARRO opens the "Próximo" margin (1 year each side, 15% more miles) so those cars come in the CSV.
      yearFrom: !group.unboundedYearMin && group.mode === 'CARRO' && group.yearMins.length ? Math.min(...group.yearMins) - 1 : null,
      yearTo: group.mode === 'CARRO' && group.yearMaxs.length ? Math.max(...group.yearMaxs) + 1 : null,
      milesFrom: !group.unboundedMilesMin && group.milesMins.length ? Math.min(...group.milesMins) : null,
      milesTo: !group.unboundedMilesMax && group.milesMaxs.length ? nearMiles(group) : null,
      milesMax: !group.unboundedMilesMax && group.milesMaxs.length ? nearMiles(group) : null,
      yearsKnown: group.mode === 'CARRO',
      mmrMinCents: group.mmrMin.length ? Math.min(...group.mmrMin) : null, mmrMaxCents: group.mmrMax.length ? Math.max(...group.mmrMax) : null,
      leads: group.leads.size, clients: [...group.leads.values()], latestAt: group.latestAt ? new Date(group.latestAt).toISOString() : null,
      created: marked.get(group.key) === true, needsQualify: false,
      searches: index + 1, covered: seen[group.mode].size, percent: total ? Math.round(seen[group.mode].size / total * 100) : 0, individualPercent: total ? Math.round(group.leads.size / total * 100) : 0
    };
  };
  const valueGroups = [...groups.values()].filter((group) => group.mode === 'VALOR').sort(bySize);
  const carGroups = [...groups.values()].filter((group) => group.mode === 'CARRO').sort(bySize);
  const result = [...valueGroups.map(shape), ...carGroups.map(shape)];
  const reviewLeads = new Set(review.map((item) => item.lead));
  return {
    activeLeads: new Set([...modeLeads.CARRO, ...modeLeads.VALOR]).size, activeLeadsCriteria: modeLeads.CARRO.size, activeLeadsValue: modeLeads.VALOR.size,
    activeLeadsByMode: { CARRO: modeLeads.CARRO.size, VALOR: modeLeads.VALOR.size }, needsQualifyLeads: reviewLeads.size, review, groups: result
  };
}
module.exports.buildSavedSearches = buildSavedSearches;

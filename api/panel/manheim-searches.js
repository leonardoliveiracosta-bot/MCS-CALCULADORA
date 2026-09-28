'use strict';
const { orders } = require('../../panel-lead');
const { allRows, insert, jsonBody, patchRows, requirePanel, rows, safeText, send } = require('../../panel-server');
const { effectiveCriteria, mergeWishlists } = require('../../panel-domain');
const vehicleMatch = require('../../vehicle-match');
const { contactIndex } = require('../../panel-contact');
const catalog = require('../../vehicle-catalog');
const { dispositionIndex } = require('../../panel-disposition');
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
    const [journeys, contacts, phones, toggles, requests, saved, refs, calcRuns, messageLinks, messages, dispositions] = await Promise.all([
      allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,criteria_json,budget_cents,confirmed_total_ceiling_cents,created_at,updated_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_primary,is_current', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: 'eq.' + ctx.environment }),
      orders(ctx),
      allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment, undone_at:'is.null' }),
      allRows(ctx, 'messages', { select: 'id,direction,occurred_at_utc,occurred_at_local,source_kind,created_at,undone_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment, cleared_at: 'is.null' })
    ]);
    // Anexo A (surpresa 2): a discarded person or a paused ficha (PARADO) is not a search to save.
    const personDisposition = dispositionIndex(dispositions);
    const discardedJourney = (journey) => personDisposition(journey.id, [journey.reference_code, ...refs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code)].filter(Boolean))?.status === 'DISCARDED';
    const contact = contactIndex({ calcRuns, messages:messages.filter((message)=>!message.undone_at), messageLinks });
    const contactById = new Map(contacts.map((row) => [row.id, row]));
    const phonesFor = (contactId) => phones.filter((row) => row.contact_id === contactId && row.is_current !== false);
    const primaryPhone = (contactId) => {
      const values = phonesFor(contactId);
      const phone = values.find((row) => row.is_primary) || values[0];
      return phone ? phone.phone_e164 || phone.phone_raw || null : null;
    };
    const disabled = new Set(toggles.filter((row) => !row.enabled).map((row) => row.journey_id));
    const closedRefs = new Set(journeys.filter((row) => row.status === 'ENCERRADO' || disabled.has(row.id)).map((row) => String(row.reference_code || '').trim().toUpperCase()).filter(Boolean));
    refs.filter((row)=>disabled.has(row.journey_id)||journeys.some((journey)=>journey.id===row.journey_id&&journey.status==='ENCERRADO'))
      .forEach((row)=>closedRefs.add(String(row.ref_code).trim().toUpperCase()));
    // One entry per person (A4): a Ref linked to a ficha belongs to that ficha. The ficha's
    // criteria win (R1/A3, wishlistOverride included); linked Refs only fill what is missing.
    const active = new Map();
    for (const journey of journeys) {
      if (journey.status === 'ENCERRADO' || journey.status === 'PARADO' || disabled.has(journey.id) || discardedJourney(journey)) continue;
      const contactRow = contactById.get(journey.contact_id);
      if (contactRow && contactRow.is_lead === false) continue;
      const journeyRefs = refs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code);
      const facts = contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: journeyRefs });
      if (!facts.entered) continue;
      active.set('journey:' + journey.id, {
        journey, orders: [],
        client: { journeyId: journey.id, name: contactRow?.display_name || `Pedido ${journey.reference_code || '—'}`, phone: primaryPhone(journey.contact_id), ref: journey.reference_code || journeyRefs[0] || null },
        latestAt: journey.updated_at || journey.created_at
      });
    }
    const cutoff = Date.now() - 30 * 86400000;
    const refUpper = (value) => String(value || '').trim().toUpperCase();
    for (const order of requests) {
      if (order.disposition === 'DISCARDED' || closedRefs.has(refUpper(order.ref)) || closedRefs.has(order.ref) || Date.parse(order.occurredAt) < cutoff) continue;
      const linked = journeys.find((journey) => refUpper(journey.reference_code) === refUpper(order.ref)) || refs.map((row) => ({ row, journey: journeys.find((item) => item.id === row.journey_id) })).find((item) => refUpper(item.row.ref_code) === refUpper(order.ref))?.journey;
      if (linked && (linked.status === 'ENCERRADO' || linked.status === 'PARADO' || disabled.has(linked.id) || discardedJourney(linked))) continue;
      const linkedRefs = linked ? refs.filter((row) => row.journey_id === linked.id).map((row) => row.ref_code) : [];
      const facts = contact.facts({ ref: order.ref, journeyId: linked?.id, refs: linkedRefs });
      if (!facts.entered) continue;
      const contactRow = linked ? contactById.get(linked.contact_id) : null;
      if (contactRow?.is_lead === false) continue;
      const key = linked ? 'journey:' + linked.id : 'order:' + order.ref;
      if (!active.has(key)) active.set(key, {
        journey: linked || null, orders: [],
        client: { journeyId: linked?.id || null, name: contactRow?.display_name || `Pedido ${order.ref}`, phone: linked ? primaryPhone(linked.contact_id) : null, ref: order.ref },
        latestAt: order.occurredAt
      });
      active.get(key).orders.push(order);
    }
    const groups = new Map();
    const leadIds = new Set();
    // Coverage is counted separately by basis: criteria (Busca) and value (Simulação) are two
    // different commercial paths and are never added up as if they were the same thing.
    const basisLeads = { CRITERIA: new Set(), VALUE: new Set() };
    const bump = (list, value) => { if (Number(value) > 0) list.push(Number(value)); };
    for (const [lead, activeLead] of active) {
      const merged = activeLead.orders.length ? { wishlists: mergeWishlists([], activeLead.orders.slice().sort((a, b) => (Date.parse(b.occurredAt) || 0) - (Date.parse(a.occurredAt) || 0)).flatMap((order) => order.wishlists || [])), budgetCents: activeLead.orders.map((order) => order.budgetCents).find((value) => Number(value) > 0) || null } : null;
      const criteria = effectiveCriteria(activeLead.journey, merged);
      for (const wish of criteria.wishes) {
        if (!wish.make || !wish.model || /^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.make).trim()) || /^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.model).trim())) continue;
        // R3: how this wish can be searched. Nothing is invented for what the customer did not say.
        const { basis, band } = vehicleMatch.wishSearchBasis(wish, criteria.bidCents);
        if (basis !== 'QUALIFY') { leadIds.add(lead); basisLeads[basis].add(lead); }
        const base = `${catalog.fold(wish.make)}|${catalog.modelTokens(wish.model,wish.make).join(' ')}`;
        const key = basis === 'CRITERIA' ? base : base + (basis === 'VALUE' ? '|valor' : '|qualificar');
        if (!groups.has(key)) groups.set(key, { key, basis, make: wish.make, model: wish.model, leads: new Map(), yearMins: [], yearMaxs: [], openFrom: false, openTo: false, withYears: 0, miles: [], mmrMin: [], mmrMax: [], latestAt: 0 });
        const group = groups.get(key);
        group.leads.set(lead, activeLead.client);
        group.latestAt = Math.max(group.latestAt, Date.parse(activeLead.latestAt || 0) || 0);
        if (wish.yearMin || wish.yearMax) {
          group.withYears += 1;
          if (wish.yearMin) bump(group.yearMins, wish.yearMin); else group.openFrom = true;
          if (wish.yearMax) bump(group.yearMaxs, wish.yearMax); else group.openTo = true;
        }
        bump(group.miles, wish.maxMiles);
        if (band) { group.mmrMin.push(band.minCents); group.mmrMax.push(band.maxCents); }
      }
    }
    const marked = new Map(saved.map((row) => [row.search_key,row.created]));
    const seen = { CRITERIA: new Set(), VALUE: new Set() };
    const bySize = (a,b) => b.leads.size - a.leads.size || a.key.localeCompare(b.key);
    const criteriaGroups = [...groups.values()].filter((group) => group.basis === 'CRITERIA').sort(bySize);
    const valueGroups = [...groups.values()].filter((group) => group.basis === 'VALUE').sort(bySize);
    const qualify = [...groups.values()].filter((group) => group.basis === 'QUALIFY').sort((a,b) => b.leads.size - a.leads.size || a.key.localeCompare(b.key));
    const shape = (group, index) => {
      const yearsKnown = group.withYears === group.leads.size && group.withYears > 0;
      // The aggregated range covers every customer's real limits: an open side stays open.
      const yearFrom = yearsKnown && !group.openFrom && group.yearMins.length ? Math.min(...group.yearMins) : null;
      const yearTo = yearsKnown && !group.openTo && group.yearMaxs.length ? Math.max(...group.yearMaxs) : null;
      return {
        key: group.key, basis: group.basis, make: group.make, model: group.model,
        yearFrom, yearTo, yearsKnown, yearsPartial: group.withYears > 0 && !yearsKnown,
        milesMax: group.basis === 'CRITERIA' && group.miles.length === group.leads.size ? Math.max(...group.miles) : null,
        mmrMinCents: group.mmrMin.length ? Math.min(...group.mmrMin) : null, mmrMaxCents: group.mmrMax.length ? Math.max(...group.mmrMax) : null,
        leads: group.leads.size, clients: [...group.leads.values()], latestAt: group.latestAt ? new Date(group.latestAt).toISOString() : null,
        created: marked.get(group.key) === true, needsQualify: group.basis === 'QUALIFY',
        ...(index === null ? { searches: null, covered: null, percent: null, individualPercent: null } : (() => {
          const total = basisLeads[group.basis].size;
          group.leads.forEach((_, lead) => seen[group.basis].add(lead));
          return { searches: index + 1, covered: seen[group.basis].size, percent: total ? Math.round(seen[group.basis].size / total * 100) : 0, individualPercent: total ? Math.round(group.leads.size / total * 100) : 0 };
        })())
      };
    };
    const result = [...criteriaGroups.map((group, index) => shape(group, index)), ...valueGroups.map((group, index) => shape(group, index)), ...qualify.map((group) => shape(group, null))];
    return send(res, 200, { activeLeads: leadIds.size, activeLeadsCriteria: basisLeads.CRITERIA.size, activeLeadsValue: basisLeads.VALUE.size, needsQualifyLeads: new Set(qualify.flatMap((group) => [...group.leads.keys()])).size, groups: result });
  } catch (_) { return send(res, 500, { error: 'SEARCHES_UNAVAILABLE' }); }
};

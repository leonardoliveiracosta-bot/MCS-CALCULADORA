'use strict';
const { orders } = require('../../panel-lead');
const { allRows, insert, jsonBody, patchRows, requirePanel, rows, safeText, send } = require('../../panel-server');
const { wishlistsForJourney } = require('../../panel-domain');
const { contactIndex } = require('../../panel-contact');
const catalog = require('../../vehicle-catalog');
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
    const [journeys, toggles, requests, saved, refs, contacts, phones, calcRuns, messageLinks, messages] = await Promise.all([
      allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,criteria_json,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: 'eq.' + ctx.environment }),
      orders(ctx),
      allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_primary,is_current', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'messages', { select: 'id,direction,occurred_at_utc,occurred_at_local,created_at,source_kind', environment: 'eq.' + ctx.environment })
    ]);
    const contact = contactIndex({ calcRuns, messages, messageLinks });
    const contactById = new Map(contacts.map((row) => [row.id, row]));
    const phonesByContact = new Map();
    for (const phone of phones) if (phone.is_current !== false) {
      if (!phonesByContact.has(phone.contact_id)) phonesByContact.set(phone.contact_id, []);
      phonesByContact.get(phone.contact_id).push(phone);
    }
    const journeyByRef = new Map();
    journeys.forEach((journey) => { if (journey.reference_code) journeyByRef.set(String(journey.reference_code).trim().toUpperCase(), journey); });
    refs.forEach((row) => { const journey=journeys.find((item)=>item.id===row.journey_id); if (journey) journeyByRef.set(String(row.ref_code).trim().toUpperCase(), journey); });
    const clientFor = (journey, fallbackRef, facts = {}) => {
      const person = journey && contactById.get(journey.contact_id);
      const phone = journey && (phonesByContact.get(journey.contact_id) || []).sort((a,b)=>Number(Boolean(b.is_primary))-Number(Boolean(a.is_primary)))[0];
      return { journeyId: journey?.id || null, ref: journey?.reference_code || fallbackRef || null, name: person?.display_name || (fallbackRef ? `Pedido ${fallbackRef}` : 'Pedido sem nome'), phone: phone?.phone_e164 || phone?.phone_raw || null, latestAt: facts.latestAt ? new Date(facts.latestAt).toISOString() : null };
    };
    const disabled = new Set(toggles.filter((row) => !row.enabled).map((row) => row.journey_id));
    const closedRefs = new Set(journeys.filter((row) => row.status === 'ENCERRADO' || disabled.has(row.id)).map((row) => String(row.reference_code || '').trim()).filter(Boolean));
    refs.filter((row)=>disabled.has(row.journey_id)||journeys.some((journey)=>journey.id===row.journey_id&&journey.status==='ENCERRADO'))
      .forEach((row)=>closedRefs.add(String(row.ref_code).trim()));
    const active = new Map();
    for (const journey of journeys) {
      if (journey.status === 'ENCERRADO' || disabled.has(journey.id)) continue;
      const journeyRefs=[journey.reference_code,...refs.filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code)].filter(Boolean);
      const facts=contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: journeyRefs });
      if (!facts.entered) continue;
      active.set('journey:'+journey.id, { wishes: wishlistsForJourney(journey), client: clientFor(journey, journey.reference_code, facts) });
    }
    const cutoff = Date.now() - 30 * 86400000;
    for (const order of requests) {
      if (order.disposition === 'DISCARDED' || closedRefs.has(order.ref) || Date.parse(order.occurredAt) < cutoff) continue;
      const journey=journeyByRef.get(String(order.ref||'').trim().toUpperCase()) || null;
      const facts=contact.facts({ journeyId: journey?.id, ref: order.ref, refs: journey ? refs.filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code) : [] });
      if (!facts.entered) continue;
      const key=journey ? 'journey:'+journey.id : 'order:'+order.ref;
      const current=active.get(key);
      active.set(key, { wishes: (current?.wishes || []).concat(order.wishlists || []), client: current?.client || clientFor(journey, order.ref, facts) });
    }
    const groups = new Map();
    const leadIds = new Set();
    for (const [lead, entry] of active) for (const wish of entry.wishes) {
      if (!wish.make || !wish.model || /^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.make).trim()) || /^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.model).trim())) continue;
      leadIds.add(lead);
      const key = `${catalog.fold(wish.make)}|${catalog.modelTokens(wish.model,wish.make).join(' ')}`;
      if (!groups.has(key)) groups.set(key, { key, make: wish.make, model: wish.model, leads: new Set(), clients: new Map(), from: [], to: [], miles: [] });
      const group = groups.get(key);
      group.leads.add(lead);
      group.clients.set(lead, entry.client);
      if (wish.yearMin) group.from.push(wish.yearMin);
      if (wish.yearMax) group.to.push(wish.yearMax);
      if (wish.maxMiles) group.miles.push(wish.maxMiles);
    }
    const marked = new Map(saved.map((row) => [row.search_key,row.created]));
    const seen = new Set();
    const result = [...groups.values()].sort((a,b) => b.leads.size - a.leads.size || a.key.localeCompare(b.key)).map((group,index) => {
      group.leads.forEach((lead) => seen.add(lead));
      const year = new Date().getUTCFullYear();
      const from=group.from.length?Math.min(...group.from):group.to.length?Math.min(...group.to)-9:year-9;
      const to=group.to.length?Math.max(...group.to):group.from.length?Math.max(...group.from)+9:year;
      return { key: group.key, make: group.make, model: group.model, yearFrom: Math.min(from,to), yearTo: Math.max(from,to), milesMax: group.miles.length ? Math.max(...group.miles) : 100000,
        leads: group.leads.size, clients:[...group.clients.values()], latestAt:[...group.clients.values()].map((client)=>client.latestAt||'').sort().at(-1)||null, searches: index + 1, covered: seen.size, percent: leadIds.size ? Math.round(seen.size / leadIds.size * 100) : 0, individualPercent: leadIds.size ? Math.round(group.leads.size / leadIds.size * 100) : 0, created: marked.get(group.key) === true };
    });
    return send(res, 200, { activeLeads: leadIds.size, groups: result });
  } catch (_) { return send(res, 500, { error: 'SEARCHES_UNAVAILABLE' }); }
};

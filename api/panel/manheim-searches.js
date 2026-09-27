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
    const [journeys, contacts, phones, toggles, requests, saved, refs, calcRuns, messageLinks, messages] = await Promise.all([
      allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,criteria_json,created_at,updated_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_primary,is_current', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: 'eq.' + ctx.environment }),
      orders(ctx),
      allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment, undone_at:'is.null' }),
      allRows(ctx, 'messages', { select: 'id,direction,occurred_at_utc,occurred_at_local,source_kind,created_at,undone_at', environment: 'eq.' + ctx.environment })
    ]);
    const contact = contactIndex({ calcRuns, messages:messages.filter((message)=>!message.undone_at), messageLinks });
    const contactById = new Map(contacts.map((row) => [row.id, row]));
    const phonesFor = (contactId) => phones.filter((row) => row.contact_id === contactId && row.is_current !== false);
    const primaryPhone = (contactId) => {
      const values = phonesFor(contactId);
      const phone = values.find((row) => row.is_primary) || values[0];
      return phone ? phone.phone_e164 || phone.phone_raw || null : null;
    };
    const disabled = new Set(toggles.filter((row) => !row.enabled).map((row) => row.journey_id));
    const closedRefs = new Set(journeys.filter((row) => row.status === 'ENCERRADO' || disabled.has(row.id)).map((row) => String(row.reference_code || '').trim()).filter(Boolean));
    refs.filter((row)=>disabled.has(row.journey_id)||journeys.some((journey)=>journey.id===row.journey_id&&journey.status==='ENCERRADO'))
      .forEach((row)=>closedRefs.add(String(row.ref_code).trim()));
    const active = new Map();
    for (const journey of journeys) {
      if (journey.status === 'ENCERRADO' || disabled.has(journey.id)) continue;
      const contactRow = contactById.get(journey.contact_id);
      if (contactRow && contactRow.is_lead === false) continue;
      const journeyRefs = refs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code);
      const facts = contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: journeyRefs });
      if (!facts.entered) continue;
      active.set('journey:' + journey.id, {
        wishes: wishlistsForJourney(journey),
        client: { journeyId: journey.id, name: contactRow?.display_name || `Pedido ${journey.reference_code || '—'}`, phone: primaryPhone(journey.contact_id), ref: journey.reference_code || journeyRefs[0] || null },
        latestAt: journey.updated_at || journey.created_at
      });
    }
    const cutoff = Date.now() - 30 * 86400000;
    for (const order of requests) {
      if (order.disposition === 'DISCARDED' || closedRefs.has(order.ref) || Date.parse(order.occurredAt) < cutoff) continue;
      const linked = journeys.find((journey) => String(journey.reference_code || '').trim().toUpperCase() === String(order.ref || '').trim().toUpperCase()) || refs.map((row) => ({ row, journey: journeys.find((item) => item.id === row.journey_id) })).find((item) => String(item.row.ref_code || '').trim().toUpperCase() === String(order.ref || '').trim().toUpperCase())?.journey;
      const linkedRefs = linked ? refs.filter((row) => row.journey_id === linked.id).map((row) => row.ref_code) : [];
      const facts = contact.facts({ ref: order.ref, journeyId: linked?.id, refs: linkedRefs });
      if (!facts.entered) continue;
      const contactRow = linked ? contactById.get(linked.contact_id) : null;
      if (contactRow?.is_lead === false) continue;
      const key = linked ? 'journey:' + linked.id : 'order:' + order.ref;
      const prior = active.get(key);
      active.set(key, {
        wishes: (prior?.wishes || []).concat(order.wishlists || []),
        client: prior?.client || { journeyId: linked?.id || null, name: contactRow?.display_name || `Pedido ${order.ref}`, phone: linked ? primaryPhone(linked.contact_id) : null, ref: order.ref },
        latestAt: prior?.latestAt || order.occurredAt
      });
    }
    const groups = new Map();
    const leadIds = new Set();
    for (const [lead, activeLead] of active) for (const wish of activeLead.wishes) {
      if (!wish.make || !wish.model || /^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.make).trim()) || /^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.model).trim())) continue;
      leadIds.add(lead);
      const key = `${catalog.fold(wish.make)}|${catalog.modelTokens(wish.model,wish.make).join(' ')}`;
      if (!groups.has(key)) groups.set(key, { key, make: wish.make, model: wish.model, leads: new Map(), from: [], to: [], miles: [], latestAt: 0 });
      const group = groups.get(key);
      group.leads.set(lead, activeLead.client);
      group.latestAt = Math.max(group.latestAt, Date.parse(activeLead.latestAt || 0) || 0);
      if (wish.yearMin) group.from.push(wish.yearMin);
      if (wish.yearMax) group.to.push(wish.yearMax);
      if (wish.maxMiles) group.miles.push(wish.maxMiles);
    }
    const marked = new Map(saved.map((row) => [row.search_key,row.created]));
    const seen = new Set();
    const result = [...groups.values()].sort((a,b) => b.leads.size - a.leads.size || a.key.localeCompare(b.key)).map((group,index) => {
      group.leads.forEach((_, lead) => seen.add(lead));
      const year = new Date().getUTCFullYear();
      const from=group.from.length?Math.min(...group.from):group.to.length?Math.min(...group.to)-9:year-9;
      const to=group.to.length?Math.max(...group.to):group.from.length?Math.max(...group.from)+9:year;
      return { key: group.key, make: group.make, model: group.model, yearFrom: Math.min(from,to), yearTo: Math.max(from,to), milesMax: group.miles.length ? Math.max(...group.miles) : 100000,
        leads: group.leads.size, clients: [...group.leads.values()], searches: index + 1, covered: seen.size, percent: leadIds.size ? Math.round(seen.size / leadIds.size * 100) : 0,
        individualPercent: leadIds.size ? Math.round(group.leads.size / leadIds.size * 100) : 0, latestAt: group.latestAt ? new Date(group.latestAt).toISOString() : null, created: marked.get(group.key) === true };
    });
    return send(res, 200, { activeLeads: leadIds.size, groups: result });
  } catch (_) { return send(res, 500, { error: 'SEARCHES_UNAVAILABLE' }); }
};

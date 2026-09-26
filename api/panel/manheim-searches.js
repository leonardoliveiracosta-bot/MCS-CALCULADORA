'use strict';
const { orders } = require('../../panel-lead');
const { allRows, insert, jsonBody, patchRows, requirePanel, rows, safeText, send } = require('../../panel-server');
const { wishlistsForJourney } = require('../../panel-domain');
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
    const [journeys, toggles, requests, saved] = await Promise.all([
      allRows(ctx, 'journeys', { select: 'id,reference_code,status,criteria_json,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: 'eq.' + ctx.environment }),
      orders(ctx),
      allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created', environment: 'eq.' + ctx.environment })
    ]);
    const disabled = new Set(toggles.filter((row) => !row.enabled).map((row) => row.journey_id));
    const active = new Map();
    for (const journey of journeys) {
      if (journey.status === 'ENCERRADO' || disabled.has(journey.id)) continue;
      active.set(String(journey.reference_code || journey.id).trim(), wishlistsForJourney(journey));
    }
    const cutoff = Date.now() - 30 * 86400000;
    for (const order of requests) {
      if (order.disposition === 'DISCARDED' || Date.parse(order.occurredAt) < cutoff) continue;
      const key = order.ref;
      active.set(key, (active.get(key) || []).concat(order.wishlists || []));
    }
    const groups = new Map();
    const leadIds = new Set();
    for (const [lead, wishes] of active) for (const wish of wishes) {
      if (!wish.make || !wish.model) continue;
      leadIds.add(lead);
      const key = `${catalog.fold(wish.make)}|${catalog.modelTokens(wish.model,wish.make).join(' ')}`;
      if (!groups.has(key)) groups.set(key, { key, make: wish.make, model: wish.model, leads: new Set(), from: [], to: [], miles: [] });
      const group = groups.get(key);
      group.leads.add(lead);
      if (wish.yearMin) group.from.push(wish.yearMin);
      if (wish.yearMax) group.to.push(wish.yearMax);
      if (wish.maxMiles) group.miles.push(wish.maxMiles);
    }
    const marked = new Map(saved.map((row) => [row.search_key,row.created]));
    const seen = new Set();
    const result = [...groups.values()].sort((a,b) => b.leads.size - a.leads.size || a.key.localeCompare(b.key)).map((group,index) => {
      group.leads.forEach((lead) => seen.add(lead));
      const year = new Date().getUTCFullYear();
      return { key: group.key, make: group.make, model: group.model, yearFrom: group.from.length ? Math.min(...group.from) : year - 9,
        yearTo: group.to.length ? Math.max(...group.to) : year, milesMax: group.miles.length ? Math.max(...group.miles) : 100000,
        leads: group.leads.size, searches: index + 1, covered: seen.size, percent: leadIds.size ? Math.round(seen.size / leadIds.size * 100) : 0, created: marked.get(group.key) === true };
    });
    return send(res, 200, { activeLeads: leadIds.size, groups: result });
  } catch (_) { return send(res, 500, { error: 'SEARCHES_UNAVAILABLE' }); }
};

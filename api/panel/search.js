'use strict';

const { searchMatches } = require('../../panel-domain');
const { allRows, requirePanel, safeText, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const q = safeText(req.query && req.query.q, 100, true);
    if (!q) return send(res, 400, { error: 'SEARCH_QUERY_INVALID' });
    const [contacts, phones, refs, journeys] = await Promise.all([
      allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journeys', { select: 'id,contact_id,vehicle_text,stage,status,updated_at', environment: 'eq.' + ctx.environment })
    ]);
    const journeyMap = new Map(journeys.map((item) => [item.id, item]));
    const contactMap = new Map(contacts.map((item) => [item.id, item]));
    const hits = new Map();
    const add = (contactId, journeyId, matchedBy) => {
      const key = `${contactId}:${journeyId || ''}`;
      const contact = contactMap.get(contactId);
      if (!contact || hits.has(key)) return;
      const journey = journeyId ? journeyMap.get(journeyId) : null;
      hits.set(key, {
        contactId, journeyId: journeyId || null, name: contact.display_name || 'Contato sem nome',
        vehicleText: journey ? journey.vehicle_text : null, stage: journey ? journey.stage : null,
        status: journey ? journey.status : null, matchedBy
      });
    };
    for (const contact of contacts) {
      if (searchMatches(q, contact)) {
        const own = journeys.filter((item) => item.contact_id === contact.id);
        if (own.length) own.forEach((item) => add(contact.id, item.id, 'nome'));
        else add(contact.id, null, 'nome');
      }
    }
    for (const phone of phones) {
      if (searchMatches(q, phone)) {
        const own = journeys.filter((item) => item.contact_id === phone.contact_id);
        if (own.length) own.forEach((item) => add(phone.contact_id, item.id, 'telefone'));
        else add(phone.contact_id, null, 'telefone');
      }
    }
    for (const ref of refs) {
      if (!searchMatches(q, ref)) continue;
      const journey = journeyMap.get(ref.journey_id);
      if (journey) add(journey.contact_id, journey.id, 'Ref');
    }
    return send(res, 200, { environment: ctx.environment, items: [...hits.values()].slice(0, 100) });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_SEARCH_ERROR' });
  }
};

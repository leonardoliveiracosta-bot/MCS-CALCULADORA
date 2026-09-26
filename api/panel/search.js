'use strict';

const { consolidateCalcRuns, groupCalculatorByRef, orderSearchMatches, searchMatches } = require('../../panel-domain');
const { allRows, requirePanel, safeText, send } = require('../../panel-server');
const { sortItems } = require('../../panel-sort');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const q = safeText(req.query && req.query.q, 100, true);
    if (!q) return send(res, 400, { error: 'SEARCH_QUERY_INVALID' });
    const [contacts, phones, refs, journeys, calcRuns, links, dispositions] = await Promise.all([
      allRows(ctx, 'contacts', { select: 'id,display_name,is_lead,location_text', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,vehicle_text,stage,status,budget_cents,confirmed_total_ceiling_cents,updated_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment })
    ]);
    const journeyMap = new Map(journeys.map((item) => [item.id, item]));
    const contactMap = new Map(contacts.filter((item)=>item.is_lead!==false).map((item) => [item.id, item]));
    const hits = new Map();
    const add = (contactId, journeyId, matchedBy) => {
      const key = `${contactId}:${journeyId || ''}`;
      const contact = contactMap.get(contactId);
      if (!contact || hits.has(key)) return;
      const journey = journeyId ? journeyMap.get(journeyId) : null;
      hits.set(key, {
        kind: 'JOURNEY', contactId, journeyId: journeyId || null,
        name: contact.display_name || 'Contato sem nome',
        vehicleText: journey ? journey.vehicle_text : null,
        referenceCode: journey ? journey.reference_code : null,
        stage: journey ? journey.stage : null,
        status: journey ? journey.status : null, budget_cents:journey?.budget_cents,confirmed_total_ceiling_cents:journey?.confirmed_total_ceiling_cents,
        contact,phones:phones.filter((p)=>p.contact_id===contactId),updated_at:journey?.updated_at,matchedBy
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
    const refQuery = q.replace(/^ref\s*:?\s*/i, '');
    for (const ref of refs) {
      if (!searchMatches(refQuery, ref)) continue;
      const journey = journeyMap.get(ref.journey_id);
      if (journey) add(journey.contact_id, journey.id, 'Ref');
    }
    for (const journey of journeys) {
      if (journey.reference_code && searchMatches(refQuery, { ref_code: journey.reference_code })) add(journey.contact_id, journey.id, 'Ref');
    }

    const journeyByRef=new Map();for(const journey of journeys){if(journey.reference_code)journeyByRef.set(String(journey.reference_code).trim().toUpperCase(),journey);}for(const ref of refs){const journey=journeyMap.get(ref.journey_id);if(journey)journeyByRef.set(String(ref.ref_code).trim().toUpperCase(),journey);}
    const groupedOrders = groupCalculatorByRef(consolidateCalcRuns(calcRuns, links), dispositions);
    const orderHits = groupedOrders.filter((item) => orderSearchMatches(q, item)).flatMap((item) => {
      const journey=journeyByRef.get(item.ref);const contact=journey&&contactMap.get(journey.contact_id);if(journey&&!contact)return [];
      return [{
      kind: 'ORDER',
      orderKey: item.key,
      ref: item.ref,
      journeyId: item.journeyId || null,
      name: `Ref ${item.ref}`,
      vehicleText: item.vehicleText,
      zip: item.zip,
      logicalMode: item.logicalMode,
      logicalModes: item.logicalModes,
      simulationCount: item.simulationCount,
      disposition: item.disposition,
      contactName:contact?.display_name,phones:journey?phones.filter((p)=>p.contact_id===journey.contact_id):[],confirmed_total_ceiling_cents:journey?.confirmed_total_ceiling_cents,budgetCents:item.budgetCents,updated_at:journey?.updated_at||item.occurredAt,
      matchedBy: foldMatch(q, item)
    }];});
    const sort=String(req.query?.sort||'recent');
    return send(res, 200, { environment: ctx.environment, items: sortItems([...hits.values()].concat(orderHits),sort,'recent').slice(0, 100) });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_SEARCH_ERROR' });
  }
};

function foldMatch(query, item) {
  const normalized = String(query || '').replace(/^ref\s*:?\s*/i, '').trim().toLocaleLowerCase('pt-BR');
  if (String(item.ref || '').toLocaleLowerCase('pt-BR').includes(normalized)) return 'Ref';
  if (String(item.zip || '').toLocaleLowerCase('pt-BR').includes(normalized)) return 'ZIP';
  return 'modelo';
}

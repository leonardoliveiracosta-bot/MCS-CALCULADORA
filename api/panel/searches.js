'use strict';

const { allRows, insert, isUuid, jsonBody, patchRows, requirePanel, rows, safeText, send } = require('../../panel-server');
const { contactIndex } = require('../../panel-contact');
const { ensureJourney, leadData, orders } = require('../../panel-lead');
const { wishlistsForJourney } = require('../../panel-domain');
const { floridaDays, loadSearchStageIndex, searchKey, searchableWish, stageLabel } = require('../../panel-search-stage');

const activeStatus = (journey, disabled) => journey && journey.status !== 'ENCERRADO' && !disabled.has(journey.id);
const phoneFor = (phones, contactId) => {
  const values = phones.filter((row) => row.contact_id === contactId && row.is_current !== false && !row.retired_at);
  const phone = values.find((row) => row.is_primary) || values[0];
  return phone && (phone.phone_e164 || phone.phone_raw) || null;
};
const title = (wish, bid) => [
  [wish.make, wish.model].filter(Boolean).join(' '),
  wish.yearMin || wish.yearMax ? `${wish.yearMin || '—'}–${wish.yearMax || '—'}` : '',
  wish.maxMiles ? `até ${Number(wish.maxMiles).toLocaleString('pt-BR')} milhas` : '',
  bid ? `lance até US$ ${Number(bid).toLocaleString('pt-BR')}` : ''
].filter(Boolean).join(' · ');

async function payload(ctx) {
  const [journeys, contacts, phones, toggles, refs, messages, messageLinks, calcRuns, saved, matches, stageIndex] = await Promise.all([
    allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,criteria_json,budget_cents,created_at,updated_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_primary,is_current,retired_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'messages', { select: 'id,direction,occurred_at_utc,occurred_at_local,source_kind,created_at,undone_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment, undone_at:'is.null' }),
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'manheim_matches', { select: 'journey_id,row_fingerprint', environment: 'eq.' + ctx.environment }),
    loadSearchStageIndex(ctx)
  ]);
  const contact = contactIndex({ calcRuns, messages: messages.filter((message) => !message.undone_at), messageLinks });
  const contactById = new Map(contacts.map((row) => [row.id, row]));
  const disabled = new Set(toggles.filter((row) => !row.enabled).map((row) => row.journey_id));
  const refsFor = (journey) => refs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code);
  const rowsOut = [];
  journeys.forEach((journey) => {
    const person = contactById.get(journey.contact_id);
    const wish = searchableWish(wishlistsForJourney(journey));
    if (!activeStatus(journey, disabled) || !wish || person?.is_lead === false) return;
    const facts = contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: refsFor(journey) });
    if (!facts.entered) return;
    const stage = stageIndex.get(journey.id);
    if (!stage) return;
    rowsOut.push({
      journeyId: journey.id, ref: journey.reference_code || refsFor(journey)[0] || null,
      name: person?.display_name || `Pedido ${journey.reference_code || '—'}`,
      phone: phoneFor(phones, journey.contact_id), wish, searchKey: stage.searchKey,
      exactSearch: title(wish, Number(journey.budget_cents || 0) / 100),
      stage: stage.stage, stageSource:stage.stageSource, stageLabel: stage.label, stageAt: stage.at, days: floridaDays(stage.at),
      hasCalculatorOrder: stage.hasCalculatorOrder, directLeadSource: stage.directLeadSource,
      matchCount: matches.filter((match) => match.journey_id === journey.id).length,
      latestAt: journey.updated_at || journey.created_at
    });
  });
  const peers = new Map();
  rowsOut.forEach((row) => { if (!peers.has(row.searchKey)) peers.set(row.searchKey, []); peers.get(row.searchKey).push(row); });
  rowsOut.forEach((row) => { row.alsoServes = peers.get(row.searchKey).filter((peer) => peer.journeyId !== row.journeyId).map((peer) => ({ name: peer.name, ref: peer.ref })); });
  const counts = { MISSING: 0, SAVED: 0, SENT: 0 };
  rowsOut.forEach((row) => { counts[row.stage]++; });
  return { items: rowsOut.sort((a, b) => ({ MISSING: 0, SAVED: 1, SENT: 2 }[a.stage] - { MISSING: 0, SAVED: 1, SENT: 2 }[b.stage]) || Date.parse(b.latestAt) - Date.parse(a.latestAt)), counts, saved: new Set(saved.filter((row) => row.created).map((row) => row.search_key)) };
}

async function mark(ctx, body) {
  const kind = String(body.kind || '').toUpperCase();
  if (!['SAVED', 'SENT'].includes(kind)) return null;
  let journeyId = isUuid(body.journeyId) ? body.journeyId : null;
  if (!journeyId && body.ref) {
    const lead = await leadData(ctx, null, String(body.ref).trim().toUpperCase(), null);
    if (!lead) return null;
    journeyId = (await ensureJourney(ctx, lead)).id;
  }
  if (!journeyId) return null;
  const current = await rows(ctx, 'journeys', { select: 'id,criteria_json', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' });
  const wish = current[0] && searchableWish(wishlistsForJourney(current[0]));
  const key = searchKey(wish);
  if (!key) return null;
  const all = await allRows(ctx, 'journeys', { select: 'id,criteria_json', environment: 'eq.' + ctx.environment, status: 'neq.ENCERRADO' });
  const ids = kind === 'SAVED' ? all.filter((journey) => searchKey(searchableWish(wishlistsForJourney(journey))) === key).map((journey) => journey.id) : [journeyId];
  const at = new Date().toISOString();
  for (const id of ids) {
    const existing = await rows(ctx, 'panel_search_marks', { select: 'id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, kind: 'eq.' + kind, undone_at: 'is.null', limit: '1' });
    if (!existing[0]) await insert(ctx, 'panel_search_marks', { environment: ctx.environment, journey_id: id, kind, created_at: at, created_by: ctx.panel.id }, false);
  }
  return { journeyId, kind, searchKey: key, markedJourneyIds: ids };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  try {
    if (req.method === 'GET') return send(res, 200, await payload(ctx));
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 4096);
    if (body.action === 'mark') { const result = await mark(ctx, body); return result ? send(res, 201, result) : send(res, 400, { error: 'SEARCH_MARK_INVALID' }); }
    if (body.action === 'undo') {
      const kind = String(body.kind || '').toUpperCase();
      if (!isUuid(body.journeyId) || !['SAVED', 'SENT'].includes(kind)) return send(res, 400, { error: 'SEARCH_UNDO_INVALID' });
      let journeyIds=[body.journeyId];
      if(kind==='SAVED'){
        const current=await rows(ctx,'journeys',{select:'id,criteria_json',environment:'eq.'+ctx.environment,id:'eq.'+body.journeyId,limit:'1'});
        const key=searchKey(searchableWish(wishlistsForJourney(current[0]||{})));
        if(key){const all=await allRows(ctx,'journeys',{select:'id,criteria_json',environment:'eq.'+ctx.environment,status:'neq.ENCERRADO'});journeyIds=all.filter((journey)=>searchKey(searchableWish(wishlistsForJourney(journey)))===key).map((journey)=>journey.id);}
      }
      let updated=[];
      for(const journeyId of journeyIds) updated=updated.concat(await patchRows(ctx, 'panel_search_marks', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, kind: 'eq.' + kind, undone_at: 'is.null' }, { undone_at: new Date().toISOString(), undone_by: ctx.panel.id }));
      return send(res, 200, { undone: Boolean(updated.length) });
    }
    return send(res, 400, { error: 'SEARCH_ACTION_INVALID' });
  } catch (_) { return send(res, 500, { error: 'SEARCHES_UNAVAILABLE' }); }
};
module.exports.payload = payload;
module.exports.mark = mark;

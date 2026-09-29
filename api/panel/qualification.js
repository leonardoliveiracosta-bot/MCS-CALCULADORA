'use strict';

const { checklistSummary, consolidateCalcRuns, shortDeadline, toggleEnabled } = require('../../panel-domain');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');
const { sortItems } = require('../../panel-sort');
const { contactIndex, decorateContact } = require('../../panel-contact');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');
const { score, loadScoreVehicles } = require('../../panel-ready');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const scoreVehicles = await loadScoreVehicles(ctx).catch(() => []);
    const [journeys, contacts, phones, refs, messageLinks, messages, checklist, evidence, divergences, toggleStates, meta, calcRuns, insights, dispositions] = await Promise.all([
      allRows(ctx, 'journeys', {
        select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,closed_at,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_at,customer_deadline_text,qualified_at,closed_reason,updated_at',
        environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
      }),
      allRows(ctx, 'contacts', { select: 'id,display_name,is_lead,location_text', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment, undone_at:'is.null' }),
      allRows(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,source_kind,created_at,undone_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_checklist', { select: 'id,journey_id,point_number,point_label,status,completed_at', environment: 'eq.' + ctx.environment, order: 'point_number.asc' }),
      allRows(ctx, 'checklist_evidence', { select: 'id,checklist_id,message_id,excerpt_text,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_divergences', { select: 'id,journey_id,field,status,operational_declaration_id,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason', environment: 'eq.' + ctx.environment }),
      panelMeta(ctx),
      allRows(ctx,'calc_runs',{select:'id,created_at,dados,is_test',order:'created_at.asc'}),
      allRows(ctx,'conversation_pending_insights',{select:'journey_id,heat,summary_text,next_step_text,last_ai_message_id,updated_at',environment:'eq.'+ctx.environment}),
      allRows(ctx,'panel_item_dispositions',{select:'item_kind,item_key,status,updated_at',environment:'eq.'+ctx.environment,cleared_at:'is.null'})
    ]);
    const contact=contactIndex({calcRuns,messages:messages.filter((message)=>!message.undone_at),messageLinks});const insightByJourney=new Map(insights.map((item)=>[item.journey_id,item]));
    const evidenceByPoint = new Map();
    for (const item of evidence) {
      if (!evidenceByPoint.has(item.checklist_id)) evidenceByPoint.set(item.checklist_id, []);
      evidenceByPoint.get(item.checklist_id).push(item);
    }
    const contactsById = new Map(contacts.map((item) => [item.id, item]));
    const stateByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
    const calculatorRefs=new Set(calcRuns.map((run)=>String(run.dados?.ref||'').trim().toUpperCase()).filter(Boolean));
    const dispositionByJourney=new Map(dispositions.filter((item)=>item.item_kind==='JOURNEY').map((item)=>[item.item_key,item]));
    const dispositionByRef=new Map(dispositions.filter((item)=>item.item_kind==='REF').map((item)=>[String(item.item_key).trim().toUpperCase(),item]));
    const messagesById = new Map(messages.map((item) => [item.id, item]));
    // The score compares with the person's own demands (VALOR and/or CARRO), so it needs the
    // calculator entries of the ficha's Refs, split by mode.
    const modeItems = consolidateCalcRuns(calcRuns);
    const items = journeys.filter((journey)=>contactsById.get(journey.contact_id)?.is_lead!==false).flatMap((journey) => {
      const ownRefs=[journey.reference_code,...refs.filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code)].filter(Boolean).map((ref)=>String(ref).trim().toUpperCase());
      const calculatorRef=ownRefs.find((ref)=>calculatorRefs.has(ref))||null;
      const disposition=(calculatorRef&&dispositionByRef.get(calculatorRef))||dispositionByJourney.get(journey.id)||null;
      if(disposition)return [];
      const facts=contact.facts({journeyId:journey.id,ref:journey.reference_code,refs:refs.filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code)});if(!facts.entered)return [];
      const points = checklist.filter((item) => item.journey_id === journey.id).map((point) => ({ ...point, evidence: evidenceByPoint.get(point.id) || [] }));
      const ownMessages = messageLinks.filter((link) => link.journey_id === journey.id).map((link) => messagesById.get(link.message_id)).filter(Boolean).sort((a, b) => Date.parse(b.occurred_at_utc || b.occurred_at_local || b.created_at) - Date.parse(a.occurred_at_utc || a.occurred_at_local || a.created_at));
      const state = stateByJourney.get(journey.id);
      const complete={...journey,contact:contactsById.get(journey.contact_id)||null,phones:phones.filter((phone)=>phone.contact_id===journey.contact_id)};
      const ready=score({zip:complete.contact?.location_text?.match(/\b\d{5}\b/)?.[0]||'',budgetCents:complete.budget_cents,simulations:modeItems.filter((item)=>ownRefs.includes(item.ref))},complete,{checklist,messages:ownMessages.map((message)=>({...message,journey_id:journey.id}))},scoreVehicles);
      return [decorateContact({
        ...journey, kind:calculatorRef?'CALCULATOR_ORDER':'JOURNEY', ref:calculatorRef||journey.reference_code, disposition:null, dispositionUpdatedAt:null, enabled: toggleEnabled(journey.status, state), toggleManaged: Boolean(state), offReason: state && state.off_reason || null, contact: contactsById.get(journey.contact_id) || null,
        phones: phones.filter((phone) => phone.contact_id === journey.contact_id), latestMessage: ownMessages.find((message) => !message.is_automatic) || ownMessages[0] || null,
        lastCustomerAt: ownMessages.find((message) => message.direction === 'CUSTOMER')?.occurred_at_utc || ownMessages.find((message) => message.direction === 'CUSTOMER')?.occurred_at_local || ownMessages.find((message) => message.direction === 'CUSTOMER')?.created_at || null,
        refs: refs.filter((item) => item.journey_id === journey.id),
        checklist: points, checklistSummary: checklistSummary(points),
        divergences: divergences.filter((item) => item.journey_id === journey.id),
        shortDeadline: shortDeadline(journey.customer_deadline_at),score:ready.score,goodHour:ready.goodHour
      },facts,insightByJourney.get(journey.id),complete)];
    });
    const stageIndex=await loadSearchStageIndex(ctx);
    return send(res, 200, { environment: ctx.environment, items:sortItems(items,String(req.query?.sort||'recent'),'recent').map((item)=>decorateWithSearchStage(item,stageIndex)), meta });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_QUALIFICATION_ERROR' });
  }
};

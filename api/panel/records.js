'use strict';

const crypto = require('node:crypto');

const { buildConversationTimeline, buildReturns, checklistSummary, consolidateCalcRuns, groupCalculatorByRef, journeyEnabled, reactivationEligible, shortDeadline, time, wishlistForJourney, wishlistsForJourney } = require('../../panel-domain');
const { allRows, isUuid, panelMeta, requirePanel, rows, send } = require('../../panel-server');
const { score } = require('../../panel-ready');
const { timezoneForZip } = require('../../panel-lead');
const { sortItems, lastRealMessageAt } = require('../../panel-sort');
const { roundedMmr } = require('../../vitrine-domain');
const { contactIndex, decorateContact } = require('../../panel-contact');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');

function newPromiseToday(promises, ref, zip) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezoneForZip(zip), year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = format.format(new Date());
  return promises.some((item) => String(item.ref_code).trim() === ref && item.status === 'OPEN' && format.format(new Date(item.due_at)) === today);
}

function withWhatsAppIdentity(item,userIds){
  const contactId=item.contact_id||item.contact?.id,identity=userIds.find((entry)=>entry.contact_id===contactId);
  const ownPhones=item.phones||[];
  return {...item,whatsappUsername:identity?.username||null,whatsappWithoutPhone:Boolean(identity&&!ownPhones.some((phone)=>phone.is_current!==false))};
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (String((req.query && req.query.view) || '') === 'manheim') {
      const [journeys, contacts, phones, refs, toggleStates, uploads, meta, messageLinks, messages, userIds] = await Promise.all([
        allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,stage,status,criteria_json,budget_cents,confirmed_total_ceiling_cents,vehicle_text,created_at,updated_at', environment: 'eq.' + ctx.environment, order: 'updated_at.desc' }),
        allRows(ctx, 'contacts', { select: 'id,display_name,is_lead,location_text', environment: 'eq.' + ctx.environment }),
        allRows(ctx,'contact_phones',{select:'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current',environment:'eq.'+ctx.environment}),
        allRows(ctx,'journey_refs',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment}),
        allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }),
        rows(ctx, 'manheim_uploads', { select: 'id,source_file_count,vehicle_count,matched_vehicle_count,lead_count,headers_json,header_map,uploaded_at', environment: 'eq.' + ctx.environment, order: 'uploaded_at.desc', limit: '1' }),
        panelMeta(ctx),
        allRows(ctx,'message_journeys',{select:'journey_id,message_id',environment:'eq.'+ctx.environment,undone_at:'is.null'}),
        allRows(ctx,'messages',{select:'id,direction,occurred_at_utc,occurred_at_local,source_kind,created_at,undone_at',environment:'eq.'+ctx.environment}),
        allRows(ctx,'whatsapp_user_ids',{select:'contact_id,username',environment:'eq.'+ctx.environment})
      ]);
      const latest = uploads[0] || null;
      const matches = latest ? await allRows(ctx, 'manheim_matches', {
        select: 'id,journey_id,calc_ref,match_kind,match_reason,mmr_status,row_fingerprint,vehicle_json,presented_unit_id,created_at',
        environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id, order: 'created_at.asc'
      }) : [];
      const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
      const excludedJourneyIds=new Set(journeys.filter(j=>contactsById.get(j.contact_id)?.is_lead===false).map(j=>j.id));
      const excludedRefs=new Set(journeys.filter(j=>excludedJourneyIds.has(j.id)).flatMap(j=>[j.reference_code,...refs.filter(r=>r.journey_id===j.id).map(r=>r.ref_code)]).filter(Boolean).map(r=>String(r).trim().toUpperCase()));
      const stateByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
      const items = journeys.filter((journey)=>contactsById.get(journey.contact_id)?.is_lead!==false).map((journey) => {
        const state = stateByJourney.get(journey.id);
        const item = withWhatsAppIdentity({ ...journey, enabled: state ? state.enabled : journey.status !== 'ENCERRADO', toggleManaged: Boolean(state), offReason: state && state.off_reason || null, contact: contactsById.get(journey.contact_id) || null,phones:phones.filter(p=>p.contact_id===journey.contact_id) },userIds);
        return { ...item, wishlist: wishlistForJourney(item), wishlists: wishlistsForJourney(item), reactivationEligible: reactivationEligible(item) };
      });
      const [calcRuns, calcLinks, dispositions] = await Promise.all([
        allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
        allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' })
      ]);
      const dispositionByJourney=new Map(dispositions.filter((item)=>item.item_kind==='JOURNEY').map((item)=>[item.item_key,item]));
      const contact=contactIndex({calcRuns,messages:messages.filter((message)=>!message.undone_at),messageLinks});
      const insights=await allRows(ctx,'conversation_pending_insights',{select:'journey_id,heat,summary_text,next_step_text',environment:'eq.'+ctx.environment});
      const insightByJourney=new Map(insights.map((item)=>[item.journey_id,item]));
      const withContactHeat=(item,facts,journey)=>{
        const target=journey||item;
        const ready=score({...item,zip:item.zip||target.contact?.location_text?.match(/\b\d{5}\b/)?.[0]||''},target,{messages:[]},[]);
        return decorateContact({...item,...ready},facts,insightByJourney.get(target.id));
      };
      const journeyMap=new Map(items.map(x=>[x.id,x])),journeyByRef=new Map(items.filter(x=>x.reference_code).map(x=>[String(x.reference_code).trim().toUpperCase(),x]));refs.forEach(r=>{const j=journeyMap.get(r.journey_id);if(j)journeyByRef.set(String(r.ref_code).trim().toUpperCase(),j);});
      const orders = groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks), dispositions)
        .filter((order) => order.disposition !== 'DISCARDED'&&!excludedRefs.has(order.ref)).flatMap(order=>{const j=journeyByRef.get(order.ref);const facts=contact.facts({ref:order.ref,journeyId:j?.id,refs:j?refs.filter((row)=>row.journey_id===j.id).map((row)=>row.ref_code):[]});if(!facts.entered)return [];const complete=j?{...order,journeyId:j.id,contactName:j.contact?.display_name,phones:j.phones,confirmed_total_ceiling_cents:j.confirmed_total_ceiling_cents}:order;return [withContactHeat(complete,facts,j)];});
      const contactedItems=items.flatMap((item)=>{const facts=contact.facts({journeyId:item.id,ref:item.reference_code,refs:refs.filter((row)=>row.journey_id===item.id).map((row)=>row.ref_code)});const disposition=dispositionByJourney.get(item.id);return facts.entered?[withContactHeat({...item,disposition:disposition?.status||null,discardReason:disposition?.discard_reason||null,dispositionUpdatedAt:disposition?.updated_at||null},facts,item)]:[];});
      const itemIds=new Set(contactedItems.map((item)=>item.id)),orderRefs=new Set(orders.map((item)=>item.ref));
      const contactedMatchesRaw=matches.filter((match)=>(match.journey_id&&itemIds.has(match.journey_id))||(match.calc_ref&&orderRefs.has(String(match.calc_ref).trim().toUpperCase())));
      /* BUSCAS: cabe no lance (valor medio do leilao <= lance maximo da ficha) e mesmo VIN em outra ficha ativa */
      const vitrineRows=await allRows(ctx,'vitrines',{select:'journey_id',environment:'eq.'+ctx.environment});
      const withVitrine=new Set(vitrineRows.map((row)=>row.journey_id).filter(Boolean));
      const journeyById=new Map(journeys.map((journey)=>[journey.id,journey]));
      const recentCut=Date.now()-60*86400000;
      const activeOther=(journey)=>journey&&journey.status!=='ENCERRADO'&&stateByJourney.get(journey.id)?.enabled!==false&&(Date.parse(journey.created_at||0)>=recentCut||withVitrine.has(journey.id));
      const journeysByVin=new Map();matches.forEach((match)=>{const vin=String(match.vehicle_json?.parsed?.vin||'').trim().toUpperCase();if(!vin||!match.journey_id)return;if(!journeysByVin.has(vin))journeysByVin.set(vin,new Set());journeysByVin.get(vin).add(match.journey_id);});
      const contactedMatches=contactedMatchesRaw.map((match)=>{
        const parsed=match.vehicle_json?.parsed||{},own=journeyById.get(match.journey_id);
        const average=roundedMmr(parsed.mmrCents),budget=Number(own?.budget_cents)||0;
        const fitsBid=average&&budget?average*100<=budget:null;
        const vin=String(parsed.vin||'').trim().toUpperCase();
        const alsoFitsFor=vin?[...new Set([...(journeysByVin.get(vin)||[])].filter((id)=>id!==match.journey_id).map((id)=>journeyById.get(id)).filter((journey)=>activeOther(journey)&&journey.contact_id!==own?.contact_id).map((journey)=>contactsById.get(journey.contact_id)?.display_name||journey.reference_code||'outro cliente'))]:[];
        return {...match,fitsBid,alsoFitsFor};
      });
      const cutoff=new Date(Date.now()-60*86400000).toISOString();
      const [history,stored]=await Promise.all([
        allRows(ctx,'manheim_uploads',{select:'id,vehicle_count,uploaded_at',environment:'eq.'+ctx.environment,uploaded_at:'gte.'+cutoff}),
        allRows(ctx,'manheim_vehicles',{select:'upload_id,row_fingerprint',environment:'eq.'+ctx.environment,uploaded_at:'gte.'+cutoff})
      ]);
      const storedByUpload=new Map();stored.forEach((row)=>storedByUpload.set(row.upload_id,(storedByUpload.get(row.upload_id)||0)+1));
      const historyIncomplete=history.some((upload)=>Number(upload.vehicle_count)>0&&(storedByUpload.get(upload.id)||0)<Number(upload.vehicle_count));
      const stageIndex=await loadSearchStageIndex(ctx);
      return send(res, 200, { environment: ctx.environment, items:contactedItems.map((item)=>decorateWithSearchStage(item,stageIndex)), orders:orders.map((item)=>decorateWithSearchStage(item,stageIndex)), upload: latest, matches:contactedMatches, historyIncomplete, meta });
    }
    const id = String((req.query && req.query.id) || '');
    if (!id) {
      const [items, contacts, phones, refs, messageLinks, messages, toggleStates, uploads, meta, checklist, promises, archive, calcRuns, calcLinks, leadPromises, aiItems, aiSuggestions, userIds, dispositions] = await Promise.all([
        allRows(ctx, 'journeys', {
          select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,customer_deadline_at,next_action_text,next_action_at,qualified_at,closed_reason,updated_at',
          environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
        }),
        allRows(ctx, 'contacts', { select: 'id,display_name,location_text,is_lead', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment, undone_at:'is.null' }),
        allRows(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,source_kind,whatsapp_delivered_at,whatsapp_read_at,created_at,undone_at', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }),
        rows(ctx, 'manheim_uploads', { select: 'id', environment: 'eq.' + ctx.environment, order: 'uploaded_at.desc', limit: '1' }),
        panelMeta(ctx),
        allRows(ctx, 'journey_checklist', { select: 'journey_id,status', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'promises', { select: 'journey_id,status,due_at', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'manheim_vehicles', { select: 'row_fingerprint,vehicle_json', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + new Date(Date.now() - 60 * 86400000).toISOString() }),
        allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
        allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'lead_promises', { select: 'ref_code,due_at,status', environment: 'eq.' + ctx.environment, status: 'eq.OPEN' }),
        allRows(ctx, 'conversation_ai_items', { select: 'journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING' }),
        allRows(ctx, 'whatsapp_link_suggestions', { select: 'source_journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING', suggestion_kind: 'eq.AI' }),
        allRows(ctx, 'whatsapp_user_ids', { select: 'contact_id,username', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' })
      ]);
      const contact=contactIndex({calcRuns,messages:messages.filter((message)=>!message.undone_at),messageLinks});
      const insights=await allRows(ctx,'conversation_pending_insights',{select:'journey_id,heat,summary_text,next_step_text',environment:'eq.'+ctx.environment});const insightByJourney=new Map(insights.map((item)=>[item.journey_id,item]));
      const [latestMatches,recentVehicles]=await Promise.all([
        uploads[0] ? allRows(ctx, 'manheim_matches', { select: 'journey_id', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploads[0].id }) : Promise.resolve([]),
        allRows(ctx,'manheim_matches',{select:'row_fingerprint,vehicle_json',environment:'eq.'+ctx.environment,created_at:'gte.'+new Date(Date.now()-60*86400000).toISOString()})
      ]);
      const vehicleMap=new Map(archive.map((entry)=>[entry.row_fingerprint,entry.vehicle_json]));
      recentVehicles.forEach((entry)=>{if(entry.vehicle_json?.parsed&&!vehicleMap.has(entry.row_fingerprint))vehicleMap.set(entry.row_fingerprint,entry.vehicle_json.parsed);});
      const scoredVehicles=[...vehicleMap.values()];
      const contactsById = new Map(contacts.map((item) => [item.id, item]));
      const dispositionByJourney=new Map(dispositions.filter((item)=>item.item_kind==='JOURNEY').map((item)=>[item.item_key,item]));
      const dispositionByRef=new Map(dispositions.filter((item)=>item.item_kind==='REF').map((item)=>[String(item.item_key).trim().toUpperCase(),item]));
      const messagesById = new Map(messages.map((item) => [item.id, item]));
      const stateByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
      const ordersByRef = new Map(groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks)).map((order) => [order.ref, order]));
      refs.forEach((ref)=>{const own=items.find((item)=>item.id===ref.journey_id);if(own&&own.reference_code&&ordersByRef.has(String(ref.ref_code).trim().toUpperCase())&&!ordersByRef.has(String(own.reference_code).trim().toUpperCase()))ordersByRef.set(String(own.reference_code).trim().toUpperCase(),ordersByRef.get(String(ref.ref_code).trim().toUpperCase()));});
      const listed=items.flatMap((item) => {
        const facts=contact.facts({journeyId:item.id,ref:item.reference_code,refs:refs.filter((row)=>row.journey_id===item.id).map((row)=>row.ref_code)});if(!facts.entered)return [];
        const ownMessages = messageLinks.filter((link) => link.journey_id === item.id).map((link) => messagesById.get(link.message_id)).filter(Boolean).sort((a, b) => (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0) - (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0));
        const state = stateByJourney.get(item.id);
        const complete = withWhatsAppIdentity({ ...item, enabled: state ? state.enabled : item.status !== 'ENCERRADO', toggleManaged: Boolean(state), offReason: state && state.off_reason || null, manheimMatchCount: latestMatches.filter((match) =>match.journey_id === item.id).length, contact: contactsById.get(item.contact_id) || null, phones: phones.filter((phone) => phone.contact_id === item.contact_id), refs: refs.filter((ref) => ref.journey_id === item.id), latestMessage: ownMessages.find((message)=>!message.is_automatic) || ownMessages[0] || null,
          pendingAiCount: aiItems.filter((entry)=>entry.journey_id===item.id).length, aiLinkSuggested: aiSuggestions.some((entry)=>entry.source_journey_id===item.id) },userIds);
        const order = [item.reference_code,...refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code)].map((ref)=>ordersByRef.get(String(ref||'').trim().toUpperCase())).find(Boolean);
        const scoring = { ...complete, ...order, zip: order?.zip || complete.contact?.location_text?.match(/\b\d{5}\b/)?.[0] || '', plate: order?.plate || 'transf', wishlists: wishlistsForJourney(complete) };
        const ready = score(scoring, complete, { checklist, promises, messages: ownMessages.map((message) => ({ ...message, journey_id: item.id })) }, scoredVehicles);
        const disposition=(order&&dispositionByRef.get(order.ref))||dispositionByJourney.get(item.id)||null;
        const latestMcsMessage=ownMessages.find((message)=>message.direction==='MCS')||null,lastCustomer=ownMessages.find((message)=>message.direction==='CUSTOMER')||null;
        /* ordem Mais recentes/antigas: ultima mensagem real; sem mensagem, a simulacao; sem nada, fim da lista */
        const lastRealAt=lastRealMessageAt(ownMessages);
        return [decorateContact({ ...complete, ...ready, isLead:complete.contact?.is_lead!==false, lastRealMessageAt:lastRealAt, sortAt:lastRealAt||order?.occurredAt||null, latestMcsMessage,lastCustomerAt:lastCustomer?.occurred_at_utc||lastCustomer?.created_at||null, disposition:disposition?.status||null, discardReason:disposition?.discard_reason||null, dispositionUpdatedAt:disposition?.updated_at||null, promiseToday: ready.promiseToday || (complete.enabled !== false && newPromiseToday(leadPromises, String(item.reference_code || '').trim(), scoring.zip)) },facts,insightByJourney.get(item.id))];
      });const stageIndex=await loadSearchStageIndex(ctx);return send(res, 200, { environment: ctx.environment, items:sortItems(listed,String(req.query?.sort||'ready'),'ready').map((item)=>decorateWithSearchStage(item,stageIndex)), meta });
    }
    if (!isUuid(id)) return send(res, 400, { error: 'JOURNEY_ID_INVALID' });
    const found = await rows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
      environment: 'eq.' + ctx.environment, id: 'eq.' + id, limit: '1'
    });
    const journey = found[0];
    if (!journey) return send(res, 404, { error: 'JOURNEY_NOT_FOUND' });
    const [contacts, phones, refs, checklist, evidence, promises, units, interactions, activities, divergences, declarations, links, messages, attachments, toggleStates, uploads, meta, userIds] = await Promise.all([
      rows(ctx, 'contacts', { select: 'id,display_name,location_text,profile_text,notes,is_lead', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id, limit: '1' }),
      allRows(ctx, 'contact_phones', { select: 'id,phone_e164,phone_raw,phone_owner,is_primary,is_current,confirmed_at,retired_at', environment: 'eq.' + ctx.environment, contact_id: 'eq.' + journey.contact_id }),
      allRows(ctx, 'journey_refs', { select: 'id,ref_code,calculator_sid,source_message_id,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id }),
      allRows(ctx, 'journey_checklist', { select: 'id,point_number,point_label,status,completed_at,updated_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'point_number.asc' }),
      allRows(ctx, 'checklist_evidence', { select: 'id,checklist_id,message_id,excerpt_text,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'promises', { select: 'id,message_id,promise_text,due_at,due_text,status,fulfilled_at,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'due_at.asc' }),
      allRows(ctx, 'units', { select: 'id,vehicle_text,details_json,presented_at,last_customer_response_at,status,decline_reason,updated_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'presented_at.desc' }),
      allRows(ctx, 'interactions', { select: 'id,message_id,type,occurred_at,detail_text,next_action_at,created_at,undone_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'occurred_at.desc' }),
      allRows(ctx, 'activity_log', { select: 'id,activity_type,summary,metadata,occurred_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'occurred_at.desc' }),
      allRows(ctx, 'journey_divergences', { select: 'id,field,left_declaration_id,right_declaration_id,operational_declaration_id,status,resolved_at,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id }),
      allRows(ctx, 'journey_declarations', { select: 'id,field,source,value_text,value_json,message_id,calc_sid,calc_ref,declared_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'declared_at.desc' }),
      allRows(ctx, 'message_journeys', { select: 'message_id,association_source,associated_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, undone_at:'is.null' }),
      allRows(ctx, 'messages', { select: 'id,chat_id,channel,direction,body_text,is_automatic,occurred_at_local,timezone_assumed,occurred_at_utc,time_uncertain,original_order,whatsapp_delivered_at,whatsapp_read_at,media_kind,media_mime_type,media_byte_size,media_status,created_at,undone_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'attachments', { select: 'id,chat_id,message_id,kind,original_filename,mime_type,byte_size,verified_at,created_at,undone_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id }),
      rows(ctx, 'journey_toggle_states', { select: 'enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, limit: '1' }),
      rows(ctx, 'manheim_uploads', { select: 'id,uploaded_at', environment: 'eq.' + ctx.environment, order: 'uploaded_at.desc', limit: '1' }),
      panelMeta(ctx),
      rows(ctx,'whatsapp_user_ids',{select:'contact_id,username',environment:'eq.'+ctx.environment,contact_id:'eq.'+journey.contact_id,limit:'1'})
    ]);
    const manheimMatches = uploads[0] ? await allRows(ctx, 'manheim_matches', { select: 'id,match_kind', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploads[0].id, journey_id: 'eq.' + id }) : [];
    const [calcRuns, calcLinks, dispositions, senderAliases] = await Promise.all([
      Promise.resolve([]),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' }),
      allRows(ctx, 'chat_sender_aliases', { select: 'chat_id,sender_text,direction', environment: 'eq.' + ctx.environment })
    ]);
    const refSet = new Set([journey.reference_code, ...refs.map((ref) => ref.ref_code)].filter(Boolean).map((ref) => String(ref).toUpperCase()));
    const filteredRuns = (await Promise.all([...refSet].map((ref)=>allRows(ctx,'calc_runs',{select:'id,created_at,zip,estado,lance,pagamento,dados,is_test','dados->>ref':'eq.'+ref,order:'created_at.asc'})))).flat();
    const calculatorRequests = groupCalculatorByRef(consolidateCalcRuns(filteredRuns, calcLinks), dispositions).filter((order) => refSet.has(order.ref));
    const messageIds = new Set(links.map((item) => item.message_id));
    const conversation = messages.filter((item) => messageIds.has(item.id) && !item.undone_at).sort((a, b) => {
      const delta = (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0) - (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0);
      return delta || (Number(a.original_order) || 0) - (Number(b.original_order) || 0) || a.id.localeCompare(b.id);
    });
    const points = checklist.map((point) => ({ ...point, evidence: evidence.filter((item) => item.checklist_id === point.id) }));
    const timeline = buildConversationTimeline(conversation, interactions, activities);
    const toggle = toggleStates[0];
    const enabled = toggle ? toggle.enabled : journey.status !== 'ENCERRADO';
    const facts = contactIndex({ calcRuns: filteredRuns, messages: messages.filter((message)=>!message.undone_at), messageLinks: links.map((link) => ({ journey_id: journey.id, message_id: link.message_id })) }).facts({ journeyId: journey.id, ref: journey.reference_code, refs: refs.map((row) => row.ref_code) });
    const journeyDisposition=dispositions.find((item)=>item.item_kind==='JOURNEY'&&item.item_key===journey.id)||null;
    const refDisposition=calculatorRequests.map((item)=>dispositions.find((entry)=>entry.item_kind==='REF'&&String(entry.item_key).trim().toUpperCase()===item.ref)).find(Boolean)||null;
    const disposition=refDisposition||journeyDisposition;
    return send(res, 200, {
      environment: ctx.environment,
      item: {
        ...withWhatsAppIdentity({...journey,contact:contacts[0]||null,phones},userIds), disposition:disposition?.status||null, discardReason:disposition?.discard_reason||null, dispositionUpdatedAt:disposition?.updated_at||null, dispositionKind:refDisposition?'REF':'JOURNEY', dispositionKey:refDisposition?String(refDisposition.item_key).trim().toUpperCase():journey.id, enabled, toggleManaged: Boolean(toggle), offReason: toggle && toggle.off_reason || null, wishlist: wishlistForJourney(journey), wishlists: wishlistsForJourney(journey), refs, checklist: points, checklistSummary: checklistSummary(points),
        shortDeadline: shortDeadline(journey.customer_deadline_at), promises, units,
        returns: buildReturns(journey, promises), interactions: interactions.filter((item)=>!item.undone_at), divergences, declarations, attachments: attachments.filter((item)=>!item.undone_at), conversation, timeline,
        calculatorRequests, senderAliases: senderAliases.filter((alias) => conversation.some((message) => message.chat_id === alias.chat_id)),
        manheimMatchCount: manheimMatches.length, manheimUploadAt: uploads[0] && uploads[0].uploaded_at || null, contactChannel: facts.channel, enteredContact: facts.entered
      },
      meta
    });
  } catch (error) {
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[panel-records]',{requestId,route:'/api/panel/records',journeyId:String(req.query?.id||''),message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});
    return send(res, 500, { error: 'PANEL_RECORDS_ERROR',requestId });
  }
};

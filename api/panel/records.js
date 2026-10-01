'use strict';

const crypto = require('node:crypto');

const { buildConversationTimeline, buildReturns, checklistSummary, consolidateCalcRuns, effectiveCriteria, groupCalculatorByRef, mergeWishlists, journeyEnabled, reactivationEligible, shortDeadline, time, toggleEnabled, wishlistForJourney, wishlistsForJourney } = require('../../panel-domain');
const { allRows, isUuid, panelMeta, requirePanel, rows, rpc, send } = require('../../panel-server');
const { score, loadScoreIndex } = require('../../panel-ready');
const { timezoneForZip } = require('../../panel-lead');
const { sortItems, lastRealMessageAt } = require('../../panel-sort');
const { contactIndex, decorateContact } = require('../../panel-contact');
const { dispositionIndex } = require('../../panel-disposition');
const { clientOrigin } = require('../../panel-origin');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');
const { manheimView } = require('../../panel-buscas-view');
const { activeFilter, batchSupported, latestActiveUpload } = require('../../panel-manheim-state');
const { outOfFunnelIndex } = require('../../panel-triage');

// Cars of the latest live batch per person, counted by the database (never the cars themselves).
// MMR is mandatory: a stored match without a valid MMR is never counted.
async function manheimCounts(ctx, journeyId) {
  if (!(await batchSupported(ctx, { rows }).catch(() => false))) return { byJourney: new Map(), upload: null };
  const upload = await latestActiveUpload(ctx, 'id,uploaded_at');
  if (!upload) return { byJourney: new Map(), upload: null };
  const list = await rpc(ctx, 'panel_manheim_batch_people', { p_environment: ctx.environment, p_upload_id: upload.id });
  const byJourney = new Map((list || []).filter((row) => row.journey_id && !row.logical_mode && (!journeyId || row.journey_id === journeyId)).map((row) => [row.journey_id, Number(row.vehicle_count) || 0]));
  return { byJourney, upload };
}


function newPromiseToday(promises, ref, zip, journeyId) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: timezoneForZip(zip), year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = format.format(new Date());
  // A promise from a ficha without calculator Ref has no ref_code: it belongs to the journey.
  const mine = (item) => item.ref_code == null ? Boolean(journeyId) && item.journey_id === journeyId : String(item.ref_code).trim() === ref;
  return promises.some((item) => mine(item) && item.status === 'OPEN' && format.format(new Date(item.due_at)) === today);
}

function withWhatsAppIdentity(item,userIds){
  const contactId=item.contact_id||item.contact?.id,identity=userIds.find((entry)=>entry.contact_id===contactId);
  const ownPhones=item.phones||[];
  return {...item,whatsappUsername:identity?.username||null,whatsappWithoutPhone:Boolean(identity&&!ownPhones.some((phone)=>phone.is_current!==false))};
}

// The CLIENTES list (every ficha that entered the panel), shared by the list and by the report
// opened from CLIENTES so both always count the same universe.
async function clientList(ctx, activeBatch) {
  const [items, contacts, phones, refs, messageLinks, messages, toggleStates, manheim, meta, checklist, promises, scoreIndex, calcRuns, calcLinks, leadPromises, aiItems, aiSuggestions, userIds, dispositions] = await Promise.all([
    allRows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,customer_deadline_at,next_action_text,next_action_at,qualified_at,closed_at,closed_reason,updated_at',
      environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
    }),
    allRows(ctx, 'contacts', { select: 'id,display_name,location_text,is_lead', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment, undone_at:'is.null' }),
    allRows(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,source_kind,whatsapp_delivered_at,whatsapp_read_at,created_at,undone_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }),
    manheimCounts(ctx).catch(() => ({ byJourney: new Map(), upload: null })),
    panelMeta(ctx),
    allRows(ctx, 'journey_checklist', { select: 'journey_id,status', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'promises', { select: 'journey_id,status,due_at', environment: 'eq.' + ctx.environment }),
    loadScoreIndex(ctx).catch(() => []),
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'lead_promises', { select: 'ref_code,journey_id,due_at,status', environment: 'eq.' + ctx.environment, status: 'eq.OPEN' }),
    allRows(ctx, 'conversation_ai_items', { select: 'journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING' }),
    allRows(ctx, 'whatsapp_link_suggestions', { select: 'source_journey_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING', suggestion_kind: 'eq.AI' }),
    allRows(ctx, 'whatsapp_user_ids', { select: 'contact_id,username', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' })
  ]);
  const contact=contactIndex({calcRuns,messages:messages.filter((message)=>!message.undone_at),messageLinks});
  // Triagem: conversa fora do funil comercial não entra em CLIENTES (continua na busca global).
  const triageOut=await outOfFunnelIndex(ctx,items,refs);
  const insights=await allRows(ctx,'conversation_pending_insights',{select:'journey_id,heat,summary_text,next_step_text,last_ai_message_id,updated_at',environment:'eq.'+ctx.environment});const insightByJourney=new Map(insights.map((item)=>[item.journey_id,item]));
  const contactsById = new Map(contacts.map((item) => [item.id, item]));
  const personDisposition=dispositionIndex(dispositions);
  const messagesById = new Map(messages.map((item) => [item.id, item]));
  const stateByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
  const ordersByRef = new Map(groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks)).map((order) => [order.ref, order]));
  refs.forEach((ref)=>{const own=items.find((item)=>item.id===ref.journey_id);if(own&&own.reference_code&&ordersByRef.has(String(ref.ref_code).trim().toUpperCase())&&!ordersByRef.has(String(own.reference_code).trim().toUpperCase()))ordersByRef.set(String(own.reference_code).trim().toUpperCase(),ordersByRef.get(String(ref.ref_code).trim().toUpperCase()));});
  // CLIENTES shows the real checklist of each ficha (it used to read 0/6 for everyone).
  const checklistByJourney=new Map();checklist.forEach((point)=>{if(!checklistByJourney.has(point.journey_id))checklistByJourney.set(point.journey_id,[]);checklistByJourney.get(point.journey_id).push(point);});
  const listed=items.flatMap((item) => {
    if(triageOut.has(item.id))return [];
    const facts=contact.facts({journeyId:item.id,ref:item.reference_code,refs:refs.filter((row)=>row.journey_id===item.id).map((row)=>row.ref_code)});if(!facts.entered)return [];
    const ownMessages = messageLinks.filter((link) => link.journey_id === item.id).map((link) => messagesById.get(link.message_id)).filter(Boolean).sort((a, b) => (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0) - (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0));
    const state = stateByJourney.get(item.id);
    const complete = withWhatsAppIdentity({ ...item, enabled: toggleEnabled(item.status, state), toggleManaged: Boolean(state), offReason: state && state.off_reason || null, manheimMatchCount: manheim.byJourney.get(item.id) || 0, contact: contactsById.get(item.contact_id) || null, phones: phones.filter((phone) => phone.contact_id === item.contact_id), refs: refs.filter((ref) => ref.journey_id === item.id), latestMessage: ownMessages.find((message)=>!message.is_automatic) || ownMessages[0] || null,
      pendingAiCount: aiItems.filter((entry)=>entry.journey_id===item.id).length, aiLinkSuggested: aiSuggestions.some((entry)=>entry.source_journey_id===item.id) },userIds);
    const order = [item.reference_code,...refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code)].map((ref)=>ordersByRef.get(String(ref||'').trim().toUpperCase())).find(Boolean);
    const scoring = { ...complete, ...order, zip: order?.zip || complete.contact?.location_text?.match(/\b\d{5}\b/)?.[0] || '', plate: order?.plate || 'transf', wishlists: wishlistsForJourney(complete) };
    const ready = score(scoring, complete, { checklist, promises, messages: ownMessages.map((message) => ({ ...message, journey_id: item.id })) }, scoreIndex);
    // A8: one disposition per person (ficha + linked Refs), the most recent wins.
    const disposition=personDisposition(item.id,[item.reference_code,...refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code),order?.ref].filter(Boolean));
    const latestMcsMessage=ownMessages.find((message)=>message.direction==='MCS')||null,lastCustomer=ownMessages.find((message)=>message.direction==='CUSTOMER')||null;
    /* ordem Mais recentes/antigas: ultima mensagem real; sem mensagem, a simulacao; sem nada, fim da lista */
    const lastRealAt=lastRealMessageAt(ownMessages);
    // Lote 4: Origem, Tipo and Última atividade for the CLIENTES filters (PEDIDOS merged in).
    const ownOrders=[...new Set([item.reference_code,...refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code)].map((ref)=>String(ref||'').trim().toUpperCase()).filter(Boolean))].map((ref)=>ordersByRef.get(ref)).filter(Boolean);
    const originInfo=clientOrigin(item,ownOrders,lastRealAt);
    return [decorateContact({ ...complete, ...ready, ...originInfo, checklistSummary:checklistSummary(checklistByJourney.get(item.id)||[]), isLead:complete.contact?.is_lead!==false, lastRealMessageAt:lastRealAt, sortAt:lastRealAt||order?.occurredAt||null, latestMcsMessage,lastCustomerAt:lastCustomer?.occurred_at_utc||lastCustomer?.created_at||null, disposition:disposition?.status||null, discardReason:disposition?.discard_reason||null, dispositionUpdatedAt:disposition?.updated_at||null, promiseToday: ready.promiseToday || (complete.enabled !== false && newPromiseToday(leadPromises, String(item.reference_code || '').trim(), scoring.zip, item.id)) },facts,insightByJourney.get(item.id),complete)];
  });
  return { listed, meta };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (String((req.query && req.query.view) || '') === 'manheim') return send(res, 200, await manheimView(ctx));
    const id = String((req.query && req.query.id) || '');
    const activeBatch = await activeFilter(ctx, { rows });
    if (!id) {
      const { listed, meta } = await clientList(ctx, activeBatch);
      const stageIndex=await loadSearchStageIndex(ctx);return send(res, 200, { environment: ctx.environment, items:sortItems(listed,String(req.query?.sort||'ready'),'ready').map((item)=>decorateWithSearchStage(item,stageIndex)), meta });
    }
    if (!isUuid(id)) return send(res, 400, { error: 'JOURNEY_ID_INVALID' });
    const found = await rows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
      environment: 'eq.' + ctx.environment, id: 'eq.' + id, limit: '1'
    });
    const journey = found[0];
    if (!journey) return send(res, 404, { error: 'JOURNEY_NOT_FOUND' });
    const [contacts, phones, refs, checklist, evidence, promises, units, interactions, activities, divergences, declarations, links, messages, attachments, toggleStates, manheim, meta, userIds] = await Promise.all([
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
      manheimCounts(ctx, id).catch(() => ({ byJourney: new Map(), upload: null })),
      panelMeta(ctx),
      rows(ctx,'whatsapp_user_ids',{select:'contact_id,username',environment:'eq.'+ctx.environment,contact_id:'eq.'+journey.contact_id,limit:'1'})
    ]);
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
    const enabled = toggleEnabled(journey.status, toggle);
    const facts = contactIndex({ calcRuns: filteredRuns, messages: messages.filter((message)=>!message.undone_at), messageLinks: links.map((link) => ({ journey_id: journey.id, message_id: link.message_id })) }).facts({ journeyId: journey.id, ref: journey.reference_code, refs: refs.map((row) => row.ref_code) });
    // A8: the most recent disposition of the person (ficha or any linked Ref) wins.
    const disposition=dispositionIndex(dispositions)(journey.id,[...refSet]);
    const refDisposition=disposition&&disposition.item_kind==='REF'?disposition:null;
    return send(res, 200, {
      environment: ctx.environment,
      item: {
        ...withWhatsAppIdentity({...journey,contact:contacts[0]||null,phones},userIds), disposition:disposition?.status||null, discardReason:disposition?.discard_reason||null, dispositionUpdatedAt:disposition?.updated_at||null, dispositionKind:refDisposition?'REF':'JOURNEY', dispositionKey:refDisposition?String(refDisposition.item_key).trim().toUpperCase():journey.id, enabled, toggleManaged: Boolean(toggle), offReason: toggle && toggle.off_reason || null, wishlist: wishlistForJourney(journey), wishlists: wishlistsForJourney(journey), refs, checklist: points, checklistSummary: checklistSummary(points),
        shortDeadline: shortDeadline(journey.customer_deadline_at), promises, units,
        returns: buildReturns(journey, promises), interactions: interactions.filter((item)=>!item.undone_at), divergences, declarations, attachments: attachments.filter((item)=>!item.undone_at), conversation, timeline,
        calculatorRequests, senderAliases: senderAliases.filter((alias) => conversation.some((message) => message.chat_id === alias.chat_id)),
        manheimMatchCount: manheim.byJourney.get(id) || 0, manheimUploadAt: manheim.upload && manheim.upload.uploaded_at || null, contactChannel: facts.channel, enteredContact: facts.entered
      },
      meta
    });
  } catch (error) {
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[panel-records]',{requestId,route:'/api/panel/records',journeyId:String(req.query?.id||''),message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});
    return send(res, 500, { error: 'PANEL_RECORDS_ERROR',requestId });
  }
};
module.exports.clientList = clientList;

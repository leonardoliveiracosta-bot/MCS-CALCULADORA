'use strict';

const crypto = require('node:crypto');

const { buildConversationTimeline, buildReturns, checklistSummary, consolidateCalcRuns, effectiveCriteria, groupCalculatorByRef, mergeWishlists, journeyEnabled, reactivationEligible, shortDeadline, time, toggleEnabled, wishlistForJourney, wishlistsForJourney, listCriteria } = require('../../panel-domain');
const { allRows, isUuid, panelMeta, requirePanel, rows, rpc, send } = require('../../panel-server');
const { score, loadScoreIndex } = require('../../panel-ready');
const { timezoneForZip } = require('../../panel-lead');
const { sortItems, lastRealMessageAt } = require('../../panel-sort');
const { contactIndex, decorateContact, messageChannel } = require('../../panel-contact');
const { dispositionIndex } = require('../../panel-disposition');
const { clientOrigin, insidePeriod } = require('../../panel-origin');
const { fixedSituation } = require('../../panel-pendencias');
const { loadVitrineOrigins } = require('../../panel-vitrine-origin');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');
const { manheimView } = require('../../panel-buscas-view');
const { activeFilter, batchSupported, latestActiveUpload } = require('../../panel-manheim-state');
const { outOfFunnelIndex } = require('../../panel-triage');
const groups = require('../../panel-groups');
const { loadClassification, factsOf } = require('../../panel-classification');
const refProof = require('../../panel-ref-proof');
const orderSummary = require('../../panel-order-summary');
const { loadTopic } = require('../../panel-topic');

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
// opened from CLIENTES so both always count the same universe. The messages never come here one by
// one: the database returns one summary row per ficha (panel_journey_message_facts) and the latest
// message of each WhatsApp conversation (panel_journey_chat_latest), for the situation.
// Page by page (500 rows each), never trusting one answer to bring everything (PostgREST cuts at 1.000).
async function factsRpc(ctx, name) {
  const all = [];
  for (let offset = 0; offset < 200000; offset += 500) {
    const page = await rpc(ctx, name, { p_environment: ctx.environment, p_limit: 500, p_offset: offset });
    all.push(...(page || []));
    if (!page || page.length < 500) break;
  }
  return all;
}
async function clientList(ctx, activeBatch) {
  const env = 'eq.' + ctx.environment;
  const [items, contacts, phones, refs, toggleStates, manheim, meta, checklist, promises, scoreIndex, calcRuns, calcLinks, leadPromises, aiItems, aiSuggestions, userIds, dispositions, messageFacts, chatLatest, insights, resolutions] = await Promise.all([
    allRows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,customer_deadline_at,next_action_text,next_action_at,next_action_set_at,last_effective_contact_at,qualified_at,closed_at,closed_reason,created_at,updated_at',
      environment: env, order: 'updated_at.desc'
    }),
    allRows(ctx, 'contacts', { select: 'id,display_name,location_text,is_lead', environment: env }),
    allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: env }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env }),
    allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: env }),
    manheimCounts(ctx).catch(() => ({ byJourney: new Map(), upload: null })),
    panelMeta(ctx),
    allRows(ctx, 'journey_checklist', { select: 'journey_id,status', environment: env }),
    allRows(ctx, 'promises', { select: 'journey_id,status,due_at', environment: env }),
    loadScoreIndex(ctx).catch(() => []),
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: env }),
    allRows(ctx, 'lead_promises', { select: 'ref_code,journey_id,due_at,status', environment: env, status: 'eq.OPEN' }),
    allRows(ctx, 'conversation_ai_items', { select: 'journey_id', environment: env, status: 'eq.PENDING' }),
    allRows(ctx, 'whatsapp_link_suggestions', { select: 'source_journey_id', environment: env, status: 'eq.PENDING', suggestion_kind: 'eq.AI' }),
    allRows(ctx, 'whatsapp_user_ids', { select: 'contact_id,username', environment: env }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: env, cleared_at:'is.null' }),
    factsRpc(ctx, 'panel_journey_message_facts'),
    factsRpc(ctx, 'panel_journey_chat_latest'),
    allRows(ctx, 'conversation_pending_insights', { select: 'journey_id,chat_id,situation,heat,summary_text,next_step_text,translation_text,last_ai_message_id,updated_at', environment: env }),
    allRows(ctx, 'conversation_pending_resolutions', { select: 'journey_id,chat_id,resolved_message_id', environment: env, undone_at: 'is.null' })
  ]);
  // Triagem: conversa fora do funil comercial não entra em CLIENTES (continua na busca global).
  const [triageOut, explicitByJourney]=await Promise.all([outOfFunnelIndex(ctx,items,refs),refProof.loadExplicit(ctx,rpc).catch(()=>null)]);
  // Identity: Refs proven by the calculator (calc_runs or the client's calculator message).
  const runRefs=refProof.runRefsOf(calcRuns);
  // Fora do assunto (leitura da triagem ou correção sua) e quem veio pela vitrine; sem tabela, ninguém.
  const [topic, vitrineOrigins, classification, templateRows] = await Promise.all([loadTopic(ctx).catch(()=>null), loadVitrineOrigins(ctx).catch(()=>null), loadClassification(ctx), rpc(ctx, 'panel_journey_calc_templates', {p_environment: ctx.environment}).catch(()=>null)]);
  // A message in the calculator model proves the origin even when the Ref is not recoverable.
  const templateJourneys = new Set((templateRows || []).map((row) => row.journey_id));
  const now=Date.now();
  const summaryByJourney=new Map((messageFacts||[]).map((row)=>[row.journey_id,row]));
  const chatsByJourney=new Map();(chatLatest||[]).forEach((row)=>{if(!chatsByJourney.has(row.journey_id))chatsByJourney.set(row.journey_id,[]);chatsByJourney.get(row.journey_id).push(row);});
  // The journey-level insight (newest of its conversations) for the heat; the chat-level one for the situation.
  const insightByJourney=new Map();insights.slice().sort((a,b)=>(time(a.updated_at)||0)-(time(b.updated_at)||0)).forEach((row)=>insightByJourney.set(row.journey_id,row));
  const insightByChat=new Map(insights.map((row)=>[row.journey_id+'|'+row.chat_id,row])),resolutionByChat=new Map(resolutions.map((row)=>[row.journey_id+'|'+row.chat_id,row]));
  const contactsById = new Map(contacts.map((item) => [item.id, item]));
  const personDisposition=dispositionIndex(dispositions);
  const stateByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
  const ordersByRef = new Map(groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks)).map((order) => [order.ref, order]));
  refs.forEach((ref)=>{const own=items.find((item)=>item.id===ref.journey_id);if(own&&own.reference_code&&ordersByRef.has(String(ref.ref_code).trim().toUpperCase())&&!ordersByRef.has(String(own.reference_code).trim().toUpperCase()))ordersByRef.set(String(own.reference_code).trim().toUpperCase(),ordersByRef.get(String(ref.ref_code).trim().toUpperCase()));});
  // CLIENTES shows the real checklist of each ficha (it used to read 0/6 for everyone).
  const checklistByJourney=new Map();checklist.forEach((point)=>{if(!checklistByJourney.has(point.journey_id))checklistByJourney.set(point.journey_id,[]);checklistByJourney.get(point.journey_id).push(point);});
  const listed=items.flatMap((item) => {
    if(triageOut.has(item.id))return [];
    const summary=summaryByJourney.get(item.id)||null;
    // Only whoever really wrote (a customer message linked to the ficha) is a client in this list.
    if(!summary||!(Number(summary.customer_count)>0))return [];
    const facts={entered:true,firstAt:time(summary.first_customer_at)||null,latestAt:time(summary.last_customer_at)||null,channel:messageChannel({source_kind:summary.last_customer_source})};
    const latestMessage=summary.latest_id?{id:summary.latest_id,direction:summary.latest_direction,body_text:summary.latest_text||'',is_automatic:Boolean(summary.latest_automatic),occurred_at_utc:summary.latest_at,source_kind:summary.latest_source||null}:null;
    const latestMcsMessage=summary.last_mcs_id?{id:summary.last_mcs_id,direction:'MCS',occurred_at_utc:summary.last_mcs_at,whatsapp_delivered_at:summary.last_mcs_delivered_at||null,whatsapp_read_at:summary.last_mcs_read_at||null,is_automatic:Boolean(summary.last_mcs_automatic)}:null;
    const state = stateByJourney.get(item.id);
    const complete = withWhatsAppIdentity({ ...item, enabled: toggleEnabled(item.status, state), toggleManaged: Boolean(state), offReason: state && state.off_reason || null, manheimMatchCount: manheim.byJourney.get(item.id) || 0, contact: contactsById.get(item.contact_id) || null, phones: phones.filter((phone) => phone.contact_id === item.contact_id), refs: refs.filter((ref) => ref.journey_id === item.id), latestMessage,
      pendingAiCount: aiItems.filter((entry)=>entry.journey_id===item.id).length, aiLinkSuggested: aiSuggestions.some((entry)=>entry.source_journey_id===item.id) },userIds);
    const order = [item.reference_code,...refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code)].map((ref)=>ordersByRef.get(String(ref||'').trim().toUpperCase())).find(Boolean);
    const scoring = { ...complete, ...order, zip: order?.zip || complete.contact?.location_text?.match(/\b\d{5}\b/)?.[0] || '', plate: order?.plate || 'transf', wishlists: wishlistsForJourney(complete) };
    // The score reads only the time of the latest customer message.
    const ready = score(scoring, complete, { checklist, promises, messages: summary.last_customer_at ? [{ journey_id: item.id, direction: 'CUSTOMER', occurred_at_utc: summary.last_customer_at }] : [] }, scoreIndex);
    // A8: one disposition per person (ficha + linked Refs), the most recent wins.
    const disposition=personDisposition(item.id,[item.reference_code,...refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code),order?.ref].filter(Boolean));
    /* ordem Mais recentes/antigas: ultima mensagem real; sem mensagem, a simulacao; sem nada, fim da lista */
    const lastRealAt=summary.latest_real_at||null;
    // Lote 4: Origem, Tipo and Última atividade for the CLIENTES filters (PEDIDOS merged in).
    const ownOrders=[...new Set([item.reference_code,...refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code)].map((ref)=>String(ref||'').trim().toUpperCase()).filter(Boolean))].map((ref)=>ordersByRef.get(ref)).filter(Boolean);
    const originInfo=clientOrigin(item,ownOrders,lastRealAt);
    // Situation of the conversation (same rule as PENDÊNCIAS), from its most recent WhatsApp conversation.
    const chat=(chatsByJourney.get(item.id)||[]).slice().sort((a,b)=>(time(b.at)||0)-(time(a.at)||0))[0]||null;
    let pending={};
    if(chat){const insight=insightByChat.get(item.id+'|'+chat.chat_id)||null,resolution=resolutionByChat.get(item.id+'|'+chat.chat_id)||null,latest={id:chat.message_id,direction:chat.direction,occurred_at_utc:chat.at};
      const situation=fixedSituation({contact:complete.contact||{},journey:item,enabled:complete.enabled,switchedAt:state?.switched_at||null,latest},insight,now);const fresh=insight&&insight.last_ai_message_id===chat.message_id;
      pending={chatId:chat.chat_id,situation,resolved:Boolean(resolution&&resolution.resolved_message_id===chat.message_id),summary:fresh?insight.summary_text||'':'',nextStep:fresh?insight.next_step_text||'':'',translation:fresh?insight.translation_text||'':'',latestAt:chat.at,daysStalled:Math.max(0,Math.floor((now-(time(chat.at)||now))/86400000))};}
    const proof=refProof.proofFor({journey:item,linkedRefs:refs.filter((ref)=>ref.journey_id===item.id).map((ref)=>ref.ref_code),runRefs,explicit:explicitByJourney?explicitByJourney.get(item.id)||[]:[]});
    // A Ref proven only by the calculator message keeps the origin Calculadora (channels do not replace it).
    if(proof.hasCalcRef&&!originInfo.origins.includes('CALCULADORA'))originInfo.origins.unshift('CALCULADORA');
    if(proof.hasCalcRef&&!ownOrders.length){const types=proof.messageModes.map((mode)=>mode==='CARRO'?'BUSCA':mode==='VALOR'?'SIMULACAO':null).filter(Boolean);originInfo.calculatorTypes=types;}
    const offTopic=topic?topic.journey(item.id,{hasCalculator:ownOrders.length>0||proof.hasCalcRef}):null;
    const vitrine=vitrineOrigins?vitrineOrigins.forPerson({journeyId:item.id,contactId:item.contact_id}):null;
    const group=groups.classify(groups.factsFor({summary,orders:ownOrders,journey:{...item,enabled:complete.enabled,switchedAt:state?.switched_at||null},disposition:disposition?.status||null,dispositionAt:disposition?.updated_at||null,offTopic,vitrine,situation:pending.situation||null,calcProof:proof,template:templateJourneys.has(item.id),...factsOf(classification,item.id)}),now);
    return [decorateContact({ ...complete, ...ready, ...originInfo, ...pending, group, ...((shown)=>({vehicleText:shown.vehicleText,budgetCents:shown.budgetCents||0,criteriaSource:{vehicle:shown.vehicleSource,bid:shown.bidSource}}))(listCriteria(item,ownOrders)), aiOrders:orderSummary.orderSummaries({orders:[...new Set([...ownOrders.map((order)=>order.ref),...(proof.calcRefs||[])])],summaries:factsOf(classification,item.id).subject.summaries||[]}), calcRefs:proof.calcRefs, calcRef:proof.calcRef, hasCalcRef:proof.hasCalcRef, calcRefsWithoutRun:proof.calcRefsWithoutRun, internalCode:proof.internalCode, lastCustomerMessage:ownOrders.length?null:groups.latestCustomerMessage(summary), checklistSummary:checklistSummary(checklistByJourney.get(item.id)||[]), isLead:complete.contact?.is_lead!==false, lastRealMessageAt:lastRealAt, sortAt:lastRealAt||order?.occurredAt||null, latestMcsMessage,lastCustomerAt:summary.last_customer_at||null, disposition:disposition?.status||null, discardReason:disposition?.discard_reason||null, dispositionUpdatedAt:disposition?.updated_at||null, promiseToday: ready.promiseToday || (complete.enabled !== false && newPromiseToday(leadPromises, String(item.reference_code || '').trim(), scoring.zip, item.id)) },facts,insightByJourney.get(item.id),complete)];
  });
  return { listed, meta };
}

// CLIENTES page: filters, sort and counts on the server; the browser receives one page at a time.
// Every count comes from the same filtered universe, so the tab badge, "N de M clientes", the
// sections and the situation bar always agree.
const PAGE_SIZE = 50;
const SECTION_ORDER = { NAO_ATENDIDO: 0, ATENDIDO: 1, FORA_DO_ASSUNTO: 2 };
function clientsPage(listed, query = {}, now = Date.now()) {
  const q = (name, fallback = 'all') => String(query[name] ?? fallback) || fallback;
  const period = q('period', 'all'), situation = q('situation'), checklist = q('checklist'), ref = q('ref'), heat = q('heat'), origin = q('origin'), type = q('type'), overdue24 = q('overdue24', 'false') === 'true';
  const leads = listed.filter((item) => item.isLead !== false);
  const inPeriod = (item) => insidePeriod(item, period, now);
  // Ref = a Ref proven by the calculator; an internal code of the ficha is not a Ref.
  const hasRef = (item) => typeof item.hasCalcRef === 'boolean' ? item.hasCalcRef : Boolean(item.reference_code || (item.refs || []).length);
  const refStateOfItem = (item) => (item.group && item.group.refState) || (hasRef(item) ? 'COM_REF' : 'SEM_REF');
  const completed = (item) => Number(item.checklistSummary?.completed || 0);
  const late = (item) => { const latest = item.latestMessage; return Boolean(latest && !latest.is_automatic && latest.direction === 'CUSTOMER' && now - (time(latest.occurred_at_utc) || now) > 86400000); };
  // Every filter except the situation one (the bar counts by situation inside the rest).
  const others = (item) => inPeriod(item) && (checklist === 'all' || (checklist === 'complete' ? completed(item) === 6 : completed(item) < 6)) && (ref === 'all' || refStateOfItem(item) === ({ with: 'COM_REF', recover: 'A_RECUPERAR', without: 'SEM_REF' })[ref])
    && (heat === 'all' || String(item.heat || '').toUpperCase() === heat) && groups.matchesOrigin(item, origin) && (type === 'all' || (item.calculatorTypes || []).includes(type)) && (!overdue24 || late(item));
  const base = listed.filter(others);
  const situations = { NO_RESPONSE: 0, MCS_PENDING: 0, CUSTOMER_PENDING: 0, IN_PROGRESS: 0, CLOSED: 0, NONE: 0 };
  base.filter((item) => item.isLead !== false).forEach((item) => { situations[situations[item.situation] === undefined ? 'NONE' : item.situation] += 1; });
  const filtered = base.filter((item) => situation === 'all' || item.situation === situation);
  const sortKey = q('sort', 'ready');
  const sorted = sortItems(filtered, sortKey, 'ready');
  // "Não atendidos" by longest wait only with the default order (Pronto para ligar); any other choice applies there too.
  const waitFirst = sortKey === 'ready';
  // Sections first (não atendidos, atendidos, fora do assunto); "não é lead" at the very end, apart.
  const sectionOf = (item) => item.isLead === false ? 3 : SECTION_ORDER[item.group?.key] ?? 1;
  // Inside each section, the areas (calculator by value, by car, direct incomplete, direct defined).
  const areaRank = (item) => groups.AREA_ORDER.indexOf(groups.areaOf(item));
  const ordered = sorted.map((item, index) => ({ item, index })).sort((a, b) => sectionOf(a.item) - sectionOf(b.item) || areaRank(a.item) - areaRank(b.item) || (waitFirst && a.item.group?.key === 'NAO_ATENDIDO' && b.item.group?.key === 'NAO_ATENDIDO' ? (b.item.group.unattended?.waitedMs || 0) - (a.item.group.unattended?.waitedMs || 0) : 0) || a.index - b.index).map((entry) => entry.item);
  const sections = { NAO_ATENDIDO: 0, ATENDIDO: 0, FORA_DO_ASSUNTO: 0, NAO_LEAD: 0 };
  const areas = {};
  ordered.forEach((item) => {
    const section = item.isLead === false ? 'NAO_LEAD' : item.group?.key || 'ATENDIDO';
    sections[section] += 1;
    const area = groups.areaOf(item);
    areas[section] = areas[section] || {};
    areas[section][area] = (areas[section][area] || 0) + 1;
  });
  const pageSize = Math.min(String(query.export || '') === '1' ? 5000 : 200, Math.max(1, Number(query.pageSize) || PAGE_SIZE));
  const page = Math.max(1, Number(query.page) || 1);
  const shownLeads = ordered.filter((item) => item.isLead !== false).length;
  return {
    items: ordered.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: ordered.length, hasMore: page * pageSize < ordered.length,
    counts: { periodLeads: leads.filter(inPeriod).length, allLeads: leads.length, shownLeads, nonLeads: sections.NAO_LEAD, situations, sections, areas }
  };
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
      const [{ listed, meta }, stageIndex, pendingRun, history] = await Promise.all([clientList(ctx, activeBatch), loadSearchStageIndex(ctx),
        rows(ctx, 'conversation_general_read_runs', { select: 'status,total_conversations,completed_conversations,budget_usd,spent_usd,reserved_usd,last_error,started_at,updated_at', environment: 'eq.' + ctx.environment, limit: '1' }).catch(() => []),
        rows(ctx, 'whatsapp_raw_events', { select: 'received_at', environment: 'eq.' + ctx.environment, event_type: 'in.(history,mixed)', order: 'received_at.desc', limit: '1' }).catch(() => [])]);
      // Decorated first: the search types defined place each contact in its area.
      const page = clientsPage(listed.map((item) => decorateWithSearchStage(item, stageIndex)), req.query || {});
      const lastHistoryAt = history[0]?.received_at || null;
      return send(res, 200, { environment: ctx.environment, ...page, meta,
        pending: { run: pendingRun[0] || { status: 'IDLE', total_conversations: 0, completed_conversations: 0, budget_usd: null, spent_usd: 0, reserved_usd: 0 }, lastHistoryAt, historyReady: !lastHistoryAt || Date.now() - Date.parse(lastHistoryAt) >= 30 * 60000 } });
    }
    if (!isUuid(id)) return send(res, 400, { error: 'JOURNEY_ID_INVALID' });
    const found = await rows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_set_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
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
    // Identity: the Ref the client wrote in the calculator message is a Ref even without calc_runs.
    const explicit=conversation.filter((message)=>message.direction==='CUSTOMER').flatMap((message)=>refProof.explicitRefs(message.body_text).map((ref)=>({ref,mode:refProof.messageMode(message.body_text),at:message.occurred_at_utc||message.created_at||null})));
    const proof=refProof.proofFor({journey,linkedRefs:refs.map((row)=>row.ref_code),runRefs:refProof.runRefsOf(filteredRuns),explicit});
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
        manheimMatchCount: manheim.byJourney.get(id) || 0, manheimUploadAt: manheim.upload && manheim.upload.uploaded_at || null, contactChannel: facts.channel, enteredContact: facts.entered,
        calcRefs: proof.calcRefs, calcRef: proof.calcRef, hasCalcRef: proof.hasCalcRef, calcRefsWithoutRun: proof.calcRefsWithoutRun, internalCode: proof.internalCode
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
module.exports.clientsPage = clientsPage;

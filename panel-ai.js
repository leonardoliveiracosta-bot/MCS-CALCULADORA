'use strict';

const crypto = require('node:crypto');
const { consolidateCalcRuns, groupCalculatorByRef, mergeWishlists, REF_RE, time } = require('./panel-domain');
const { validItems, prepareItems } = require('./panel-note');
const { allRows, insert, patchRows, rows, supabase } = require('./panel-server');
const { timezoneForZip } = require('./panel-lead');
const { storeDailyInsight } = require('./panel-pendencias');

const AI_TYPES = new Set(['call_result','checklist','budget','payment','deadline','wishlist','phone','promise','return','stage','disable']);
const DAY_MS = 86400000;
const AI_CONTEXT_MAX_MESSAGES = 150;
const AI_CONTEXT_MAX_CHARS = 40000;
const AI_FAILURE_BACKOFF_MS = 6 * 60 * 60 * 1000;
// Automatic reading starts at 3 MCS messages in the conversation. The automatic greeting does not count;
// MCS messages imported from the WhatsApp history do.
const AI_MIN_MCS_MESSAGES = 3;

function firstJson(text) {
  const source = String(text || '');
  for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < source.length; index++) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{') depth++;
      else if (character === '}' && --depth === 0) {
        try { return JSON.parse(source.slice(start, index + 1)); } catch (_) { break; }
      }
    }
  }
  throw new Error('AI_RESPONSE_INVALID');
}

// Daily quota by kind (America/New_York day): ROTINA (ai-cron) 1000, MANUAL (operator clicks) 2000.
// The routine never uses up what the operator needs.
async function reserveCall(ctx, kind = 'MANUAL') {
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_ai_reserve_call', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment, p_kind: kind === 'ROTINA' ? 'ROTINA' : 'MANUAL' })
  });
  if (!result || result.allowed !== true) throw new Error('AI_DAILY_LIMIT');
  return result;
}

async function anthropicJson(system, user, fetchImpl = fetch) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANTHROPIC_MODEL) throw new Error('AI_UNAVAILABLE');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL, max_tokens: 2400, temperature: 0,
        system, messages: [{ role: 'user', content: user }] })
    });
    if (!response.ok) throw new Error('AI_UNAVAILABLE');
    const payload = await response.json();
    const text = (payload.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    return firstJson(text);
  } catch (error) {
    if (error.message === 'AI_RESPONSE_INVALID') throw error;
    throw new Error('AI_UNAVAILABLE');
  } finally { clearTimeout(timeout); }
}

function stampOf(message) { return time(message.occurred_at_utc || message.occurred_at_local || message.created_at) || 0; }
function normalizedName(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').replace(/\s+/g,' ').trim(); }
function words(value) { return new Set(normalizedName(value).split(' ').filter((part) => part.length >= 3)); }
function overlap(a, b) { let count=0; for (const value of a) if (b.has(value)) count++; return count; }
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

function aiContextWindow(messages, maximumBid, timezone, priorSummary='', search=null) {
  const newest = messages.slice(-AI_CONTEXT_MAX_MESSAGES).map((message) => ({
    sender: message.direction,
    text: String(message.body_text || ''),
    at: new Date(stampOf(message)).toISOString()
  }));
  const cut = messages.length > newest.length;
  let accumulated=String(priorSummary||'').slice(0,6000);
  const payload = () => JSON.stringify({agora:new Date().toISOString(),fuso:timezone,lanceCalculadora:maximumBid||null,...(search?{busca:search}:{}),resumoAcumulado:accumulated||null,conversa:newest});
  while (accumulated && payload().length > AI_CONTEXT_MAX_CHARS) accumulated=accumulated.slice(Math.ceil(accumulated.length*.15));
  let truncated = cut;
  while (newest.length && payload().length > AI_CONTEXT_MAX_CHARS) {
    const excess = payload().length - AI_CONTEXT_MAX_CHARS;
    if (newest.length > 1 && newest[0].text.length <= excess + 96) { newest.shift(); truncated = true; continue; }
    const first = newest[0];
    const trim = Math.min(first.text.length, Math.max(1, excess + 96));
    first.text = first.text.slice(trim);
    truncated = true;
    if (!first.text && newest.length > 1) newest.shift();
  }
  return {messages:newest, truncated, user:payload()};
}

function automaticAttemptAllowed(group, now=Date.now()) {
  const state = group.attemptState;
  if (!state) return true;
  const lastFailure = time(state.last_failure_at);
  if (lastFailure && now - lastFailure < AI_FAILURE_BACKOFF_MS) return false;
  return !(Number(state.consecutive_failures || 0) >= 3 && state.last_customer_message_id === group.lastCustomer?.id);
}

async function recordAttempt(ctx, group, success, errorCode=null) {
  if (!group.lastCustomer) return null;
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_ai_record_attempt',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      p_environment:ctx.environment,p_journey:group.journey.id,p_chat:group.chatId,p_customer:group.lastCustomer.id,
      p_success:Boolean(success),p_error:success?null:String(errorCode||'AI_FAILED').slice(0,180)
    })
  });
}

function trackableAiFailure(error) {
  return !['AI_DAILY_LIMIT','AI_NO_CUSTOMER_MESSAGE','AI_NOT_ELIGIBLE'].includes(String(error && error.message || error));
}

async function allConversationData(ctx) {
  const [journeys, contacts, links, messages, refs, readings, states, attempts, calcRuns, pendingInsights] = await Promise.all([
    allRows(ctx,'journeys',{select:'id,contact_id,reference_code,status,criteria_json,budget_cents,payment_text,customer_deadline_text',environment:'eq.'+ctx.environment}),
    allRows(ctx,'contacts',{select:'id,display_name,location_text,is_lead',environment:'eq.'+ctx.environment}),
    allRows(ctx,'message_journeys',{select:'journey_id,message_id',environment:'eq.'+ctx.environment,undone_at:'is.null'}),
    allRows(ctx,'messages',{select:'id,chat_id,channel,direction,body_text,is_automatic,source_kind,occurred_at_utc,occurred_at_local,created_at,undone_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'journey_refs',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment}),
    allRows(ctx,'conversation_ai_readings',{select:'id,journey_id,chat_id,last_customer_message_id,status,created_at',environment:'eq.'+ctx.environment,status:'eq.ACTIVE'}),
    allRows(ctx,'conversation_ai_link_state',{select:'journey_id,chat_id,first_customer_at,last_run_at,last_order_seen_at,retry_requested',environment:'eq.'+ctx.environment}),
    allRows(ctx,'conversation_ai_attempt_state',{select:'journey_id,chat_id,last_customer_message_id,last_failure_at,consecutive_failures,last_error,last_attempt_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'calc_runs',{select:'dados,is_test'}),
    allRows(ctx,'conversation_pending_insights',{select:'journey_id,chat_id,summary_text,last_ai_message_id',environment:'eq.'+ctx.environment})
  ]);
  const calculatorRefs=new Set(calcRuns.filter((run)=>run.is_test!==true).map((run)=>String(run.dados?.ref||'').trim().toUpperCase()).filter((ref)=>REF_RE.test(ref)));
  const messageById=new Map(messages.filter((message)=>!message.undone_at).map((message)=>[message.id,message]));
  const journeyById=new Map(journeys.map((journey)=>[journey.id,journey]));
  const contactById=new Map(contacts.map((contact)=>[contact.id,contact]));
  const refsByJourney=new Map();
  refs.forEach((ref)=>{if(!refsByJourney.has(ref.journey_id))refsByJourney.set(ref.journey_id,[]);refsByJourney.get(ref.journey_id).push(String(ref.ref_code).trim().toUpperCase());});
  const groups=new Map();
  for(const link of links){
    const message=messageById.get(link.message_id),journey=journeyById.get(link.journey_id);
    if(!message||!journey)continue;
    const key=journey.id+'|'+message.chat_id;
    if(!groups.has(key))groups.set(key,{journey,contact:contactById.get(journey.contact_id)||{},chatId:message.chat_id,messages:[]});
    groups.get(key).messages.push(message);
  }
  for(const group of groups.values()){
    group.messages.sort((a,b)=>stampOf(a)-stampOf(b)||String(a.id).localeCompare(String(b.id)));
    group.effectiveMessages=group.messages.filter((message)=>!message.is_automatic);
    group.customerMessages=group.effectiveMessages.filter((message)=>message.direction==='CUSTOMER');
    group.mcsCount=group.messages.filter((message)=>message.direction==='MCS'&&!message.is_automatic).length;
    group.lastCustomer=group.customerMessages.at(-1)||null;
    group.firstCustomer=group.customerMessages[0]||null;
    group.refs=[String(group.journey.reference_code||'').trim().toUpperCase(),...(refsByJourney.get(group.journey.id)||[])].filter((ref)=>REF_RE.test(ref)&&calculatorRefs.has(ref));
    group.reading=readings.find((reading)=>reading.journey_id===group.journey.id&&reading.chat_id===group.chatId)||null;
    group.linkState=states.find((state)=>state.journey_id===group.journey.id&&state.chat_id===group.chatId)||null;
    group.attemptState=attempts.find((state)=>state.journey_id===group.journey.id&&state.chat_id===group.chatId)||null;
    group.pendingInsight=pendingInsights.find((item)=>item.journey_id===group.journey.id&&item.chat_id===group.chatId)||null;
  }
  return [...groups.values()];
}

async function calculatorOrders(ctx) {
  const cutoff=new Date(Date.now()-7*DAY_MS).toISOString();
  const [runs,links,journeys,refs]=await Promise.all([
    allRows(ctx,'calc_runs',{select:'id,created_at,zip,estado,lance,pagamento,dados,is_test',created_at:'gte.'+cutoff,order:'created_at.asc'}),
    allRows(ctx,'calculator_request_links',{select:'calc_sid,calc_ref,logical_mode,contact_id,journey_id',environment:'eq.'+ctx.environment}),
    allRows(ctx,'journeys',{select:'id,reference_code',environment:'eq.'+ctx.environment}),
    allRows(ctx,'journey_refs',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment})
  ]);
  const owned=new Set(journeys.map((journey)=>String(journey.reference_code||'').trim().toUpperCase()).concat(refs.map((ref)=>String(ref.ref_code||'').trim().toUpperCase())).filter((ref)=>REF_RE.test(ref)));
  return groupCalculatorByRef(consolidateCalcRuns(runs,links)).filter((order)=>!order.journeyId&&!owned.has(order.ref));
}

function deterministicCandidates(group, orders) {
  const name=normalizedName(group.contact.display_name),firstName=name.split(' ')[0];
  const conversation=group.customerMessages.map((message)=>message.body_text).join(' '),conversationWords=words(conversation);
  // Money only: "80,000 miles"/"80k mi"/"80 mil milhas" are mileage, never an amount; "20k" and
  // "20 mil" are 20,000.
  const amounts=[...conversation.matchAll(/(?:us\$|\$)?\s*(\d{1,3}(?:[.,]\d{3})+|\d+)(\s*(?:mil\b|k\b))?(?!\s*(?:mi\b|miles\b|milhas\b|millas\b|mil\s+milhas|mil\s+millas|k\s*mi\b))/gi)].map((match)=>{
    const multiplier=match[2]?1000:1;return Number(match[1].replace(/[.,]/g,''))*multiplier;
  }).filter((value)=>value>=1000);
  const firstAt=stampOf(group.firstCustomer);
  return orders.map((order)=>{
    const orderAt=time(order.occurredAt)||0,orderName=normalizedName(order.contactName),vehicleWords=words(order.vehicleText);
    const sameName=Boolean(firstName&&orderName&&(orderName.split(' ')[0]===firstName||orderName.includes(name)||name.includes(orderName)));
    const vehicleMatches=overlap(conversationWords,vehicleWords);
    const dollars=Number(order.budgetCents||0)/100,sameValue=amounts.some((value)=>Math.abs(value-dollars)<=Math.max(500,dollars*.05));
    const distance=Math.abs(orderAt-firstAt),nearTime=distance<=24*3600000;
    const score=Number(sameName)*5+Math.min(vehicleMatches,3)*2+Number(sameValue)*4+Number(nearTime)*Math.max(1,3-Math.floor(distance/3600000/8));
    const reasons=[];if(sameName)reasons.push('mesmo nome');if(vehicleMatches)reasons.push('carro citado na conversa');if(sameValue)reasons.push('mesmo valor');if(nearTime)reasons.push('horário próximo da primeira mensagem');
    return {...order,deterministicScore:score,reasons};
  }).filter((order)=>order.deterministicScore>0).sort((a,b)=>b.deterministicScore-a.deterministicScore||(time(b.occurredAt)||0)-(time(a.occurredAt)||0)||a.ref.localeCompare(b.ref)).slice(0,5);
}

function readingPrompt(group, maximumBid, order=null) {
  const timezone=timezoneForZip((group.contact.location_text||'').match(/\b\d{5}\b/)?.[0]||'');
  // The search type and what the calculator already has, so "missing" never asks across the type (MESA).
  const modes=[...new Set([...(order&&order.logicalModes||[]),...(Array.isArray(group.journey.criteria_json?.logical_modes)?group.journey.criteria_json.logical_modes:[])])].filter((mode)=>mode==='CARRO'||mode==='VALOR');
  const search=modes.length||order?{tipos:modes.map((mode)=>mode==='CARRO'?'POR_CARRO':'POR_VALOR'),calculadora:order?{carro:order.vehicleText||null,anos:order.yearsText||null,milhas:order.mileageText||null,lance:maximumBid||null}:null}:null;
  const window=aiContextWindow(group.effectiveMessages||group.messages,maximumBid,timezone,group.pendingInsight?.summary_text||'',search);
  const transcript=window.messages.map((message)=>`${message.sender==='CUSTOMER'?'Cliente':'MCS'}: ${message.text}`).join('\n');
  return {transcript,user:window.user,messages:window.messages,messageCount:window.messages.length,truncated:window.truncated};
}

function validatedReading(parsed, transcript, lead, customerBodies) {
  const summary=parsed&&parsed.summary&&typeof parsed.summary==='object'?{
    want:String(parsed.summary.want||'').trim().slice(0,700),money:String(parsed.summary.money||'').trim().slice(0,700),missing:String(parsed.summary.missing||'').trim().slice(0,700)
  }:{want:'',money:'',missing:''};
  const raw=(Array.isArray(parsed&&parsed.items)?parsed.items:[]).filter((item)=>item&&AI_TYPES.has(item.type)&&typeof item.evidence==='string'&&customerBodies.some((body)=>body.includes(item.evidence)));
  const prepared=prepareItems(validItems(transcript,raw),lead).map((item)=>item.type==='budget'?{...item,manualReview:true}:item);
  const items=prepared.map((item)=>{
    // Evidence may legitimately change between readings.  The durable identity is
    // the destination and resulting value, so confirmed/discarded facts stay gone.
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify(stableValue([item.type,item.point||null,item.value,item.finalWishes||null]))).digest('hex');
    return {fingerprint,item,evidence:item.evidence,manualReview:Boolean(item.manualReview)};
  });
  return {summary,items};
}

async function readConversation(ctx, group, options={}) {
  if(!group.lastCustomer)throw new Error('AI_NO_CUSTOMER_MESSAGE');
  if(!options.manual&&group.mcsCount<AI_MIN_MCS_MESSAGES)throw new Error('AI_NOT_ELIGIBLE');
  await reserveCall(ctx,options.manual?'MANUAL':'ROTINA');
  let order=null;
  if(group.refs.length){
    const runs=(await Promise.all(group.refs.map((ref)=>allRows(ctx,'calc_runs',{select:'id,created_at,zip,estado,lance,pagamento,dados,is_test','dados->>ref':'ilike.'+ref,order:'created_at.asc'})))).flat();
    const links=await allRows(ctx,'calculator_request_links',{select:'calc_sid,calc_ref,logical_mode,contact_id,journey_id',environment:'eq.'+ctx.environment});
    order=groupCalculatorByRef(consolidateCalcRuns(runs,links)).find((candidate)=>group.refs.includes(candidate.ref))||null;
  }
  const prompt=readingPrompt(group,order&&order.budgetCents?Number(order.budgetCents)/100:null,order);
  try {
    const parsed=await anthropicJson(
      'Você analisa conversas da My Car Scout. Responda SOMENTE um objeto JSON com summary {want,money,missing} e items. '+
      'Cada item deve usar apenas estes tipos: call_result, checklist, budget, payment, deadline, wishlist, phone, promise, return, stage, disable. '+
      'Cada item precisa de evidence copiada literalmente de uma única mensagem do Cliente e o valor precisa estar provado nessa mesma frase. Nunca use fala da MCS como evidência. '+
      'Para budget, value é o valor total em dólares. Para checklist, point é 1 a 6 e value é OK. Não invente nada. O resumo é em português e Dinheiro diferencia o lance da calculadora do valor falado. missing lista só o que o tipo de busca (busca.tipos) ainda precisa e que não está na conversa nem em busca.calculadora. Regra da mesa: quem busca POR CARRO (Find One: carro, faixa de ano e de milhagem) nunca recebe pergunta de lance, orçamento ou valor; quem busca POR VALOR (carro e lance máximo) nunca recebe pergunta de ano ou milhagem; não sugira perguntar o que o cliente ou a calculadora já informaram. Acrescente pending {situation,heat,summary,nextStep,translation}: situation é MCS_PENDING, CUSTOMER_PENDING, IN_PROGRESS ou CLOSED; heat é HOT, WARM ou COLD; translation só quando a última mensagem estiver em outro idioma. summary, nextStep e translation sempre em português.',
      prompt.user,options.fetchImpl
    );
    const zip=(group.contact.location_text||'').match(/\b\d{5}\b/)?.[0]||'';
    const lead={wishes:mergeWishlists([],group.journey.criteria_json?.wishlists||[]),timezone:timezoneForZip(zip)};
    const validated=validatedReading(parsed,prompt.transcript,lead,prompt.messages.filter((message)=>message.sender==='CUSTOMER').map((message)=>message.text));
    const summary={...validated.summary,contextTruncated:prompt.truncated};
    const stored=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_ai_replace_reading',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_journey:group.journey.id,p_chat:group.chatId,
        p_summary:summary,p_items:validated.items,p_message_count:prompt.messageCount,p_last_customer:group.lastCustomer.id,
        p_last_customer_at:new Date(stampOf(group.lastCustomer)).toISOString(),p_actor:options.actor||null})
    });
    // storeDailyInsight takes the pendências shape (latest, chat). Without it nothing was stored, and a stale
    // insight kept the conversation due for a new paid reading on every run.
    await storeDailyInsight(ctx,{...group,latest:group.effectiveMessages.at(-1),chat:{id:group.chatId}},parsed.pending||{summary:validated.summary.want+' '+validated.summary.money+' '+validated.summary.missing}).catch(()=>null);
    await recordAttempt(ctx,group,true).catch(()=>null);
    return {...stored,summary,items:validated.items};
  } catch(error) {
    if (trackableAiFailure(error)) await recordAttempt(ctx,group,false,error.message).catch(()=>null);
    throw error;
  }
}

async function markLinkState(ctx,group,latestOrderAt,retry=false){
  const payload={environment:ctx.environment,journey_id:group.journey.id,chat_id:group.chatId,
    first_customer_at:new Date(stampOf(group.firstCustomer)).toISOString(),last_run_at:new Date().toISOString(),last_order_seen_at:latestOrderAt||null,retry_requested:retry};
  const existing=await rows(ctx,'conversation_ai_link_state',{select:'journey_id',environment:'eq.'+ctx.environment,journey_id:'eq.'+group.journey.id,chat_id:'eq.'+group.chatId,limit:'1'});
  if(existing[0])await patchRows(ctx,'conversation_ai_link_state',{environment:'eq.'+ctx.environment,journey_id:'eq.'+group.journey.id,chat_id:'eq.'+group.chatId},payload);
  else await insert(ctx,'conversation_ai_link_state',payload,false);
}

async function suggestLink(ctx,group,orders,options={}){
  const candidates=deterministicCandidates(group,orders),latestOrderAt=orders.reduce((latest,order)=>Math.max(latest,time(order.occurredAt)||0),0);
  if(!candidates.length){await markLinkState(ctx,group,latestOrderAt?new Date(latestOrderAt).toISOString():null,false);return null;}
  try {
    await reserveCall(ctx,'ROTINA');
    const parsed=await anthropicJson('Escolha somente entre os candidatos fornecidos o pedido mais provável para esta conversa. Responda SOMENTE JSON {"ref":"ABCDE" ou null,"reasons":["motivo curto"]}. Não invente dados.',JSON.stringify({
      contato:group.contact.display_name,mensagens:group.customerMessages.slice(-10).map((message)=>message.body_text),candidatos:candidates.map((candidate)=>({ref:candidate.ref,nome:candidate.contactName,carro:candidate.vehicleText,valor:candidate.budgetCents?Number(candidate.budgetCents)/100:null,data:candidate.occurredAt,sinais:candidate.reasons}))
    }),options.fetchImpl);
    const chosen=candidates.find((candidate)=>candidate.ref===String(parsed.ref||'').trim().toUpperCase());
    await markLinkState(ctx,group,latestOrderAt?new Date(latestOrderAt).toISOString():null,false);
    if(!chosen){await recordAttempt(ctx,group,true).catch(()=>null);return null;}
    const phones=await rows(ctx,'contact_phones',{select:'phone_e164',environment:'eq.'+ctx.environment,contact_id:'eq.'+group.journey.contact_id,is_current:'eq.true',order:'is_primary.desc,created_at.asc',limit:'1'});
    const motives=(Array.isArray(parsed.reasons)?parsed.reasons:chosen.reasons).map((value)=>String(value).slice(0,180)).slice(0,5).join(', ');
    const existing=await rows(ctx,'whatsapp_link_suggestions',{select:'id',environment:'eq.'+ctx.environment,source_journey_id:'eq.'+group.journey.id,target_ref:'eq.'+chosen.ref,limit:'1'});
    await patchRows(ctx,'whatsapp_link_suggestions',{environment:'eq.'+ctx.environment,source_journey_id:'eq.'+group.journey.id,status:'eq.PENDING',suggestion_kind:'eq.AI'},{status:'REJECTED',resolved_at:new Date().toISOString()});
    const payload={source_chat_id:group.chatId,target_contact_id:null,target_journey_id:null,target_ref:chosen.ref,phone_e164:phones[0]?.phone_e164||'+10000000000',status:'PENDING',motives,suggestion_kind:'AI',candidate_latest_at:chosen.occurredAt,resolved_at:null,resolved_by:null};
    if(existing[0])await patchRows(ctx,'whatsapp_link_suggestions',{environment:'eq.'+ctx.environment,id:'eq.'+existing[0].id},payload);
    else await insert(ctx,'whatsapp_link_suggestions',{environment:ctx.environment,source_contact_id:group.journey.contact_id,source_journey_id:group.journey.id,...payload},false);
    await recordAttempt(ctx,group,true).catch(()=>null);
    return {ref:chosen.ref,motives};
  } catch(error) {
    if (trackableAiFailure(error)) await recordAttempt(ctx,group,false,error.message).catch(()=>null);
    throw error;
  }
}

// Cases the panel no longer works (closed, switched off, discarded, out of the funnel, "não é lead",
// or a client who asked not to be contacted) get no paid automatic reading. Manual reading still works.
async function stoppedJourneys(ctx,groups,read=allRows){
  const { dispositionIndex }=require('./panel-disposition');
  const { outOfFunnelIndex }=require('./panel-triage');
  const { optOutOf }=require('./panel-opt-out');
  const env='eq.'+ctx.environment;
  const [toggles,dispositions,refs]=await Promise.all([
    read(ctx,'journey_toggle_states',{select:'journey_id,enabled,off_reason',environment:env}).catch(()=>[]),
    read(ctx,'panel_item_dispositions',{select:'item_kind,item_key,status,discard_reason,updated_at,cleared_at',environment:env,cleared_at:'is.null'}).catch(()=>[]),
    read(ctx,'journey_refs',{select:'journey_id,ref_code',environment:env}).catch(()=>[])
  ]);
  const journeys=[...new Map(groups.map((group)=>[group.journey.id,group.journey])).values()];
  const triageOut=await outOfFunnelIndex(ctx,journeys,refs,read).catch(()=>new Set());
  const disposition=dispositionIndex(dispositions),toggleByJourney=new Map(toggles.map((row)=>[row.journey_id,row]));
  const refsByJourney=new Map();
  refs.forEach((row)=>{if(!refsByJourney.has(row.journey_id))refsByJourney.set(row.journey_id,[]);refsByJourney.get(row.journey_id).push(String(row.ref_code||'').trim().toUpperCase());});
  const stopped=new Set();
  for(const group of groups){
    const journey=group.journey;
    if(triageOut.has(journey.id)||journey.status==='ENCERRADO'||group.contact?.is_lead===false||toggleByJourney.get(journey.id)?.enabled===false||optOutOf(group.messages)){stopped.add(journey.id);continue;}
    const own=[String(journey.reference_code||'').trim().toUpperCase(),...(refsByJourney.get(journey.id)||[])].filter(Boolean);
    if(disposition(journey.id,own)?.status==='DISCARDED')stopped.add(journey.id);
  }
  return stopped;
}

async function runCron(ctx,options={}){
  const groups=await allConversationData(ctx),orders=await calculatorOrders(ctx),now=Date.now(),cutoff=now-30*DAY_MS;
  const stopped=await stoppedJourneys(ctx,groups,options.allRows||allRows);
  const eligible=[];
  for(const group of groups){
    if(!group.lastCustomer||stampOf(group.lastCustomer)<cutoff)continue;
    if(stopped.has(group.journey.id))continue;
    if(!automaticAttemptAllowed(group,now))continue;
    const latestId=group.effectiveMessages.at(-1)?.id;
    const latestCustomerIsLive=group.lastCustomer.source_kind!=='WHATSAPP_HISTORY';
    const readingDue=latestCustomerIsLive&&group.mcsCount>=AI_MIN_MCS_MESSAGES&&stampOf(group.lastCustomer)<=now-10*60000&&(
      group.reading?.last_customer_message_id!==group.lastCustomer.id || (group.pendingInsight && group.pendingInsight.last_ai_message_id!==latestId)
    );
    const candidates=!group.refs.length?deterministicCandidates(group,orders):[];
    const newest=candidates.reduce((latest,order)=>Math.max(latest,time(order.occurredAt)||0),0);
    const state=group.linkState;
    const withinWindow=!group.firstCustomer||!newest||newest<=stampOf(group.firstCustomer)+DAY_MS;
    const suggestionDue=latestCustomerIsLive&&!group.refs.length&&group.firstCustomer&&withinWindow&&(!state||state.retry_requested||(newest&&newest>Date.parse(state.last_order_seen_at||0)));
    if(readingDue||suggestionDue)eligible.push({group,readingDue,suggestionDue});
  }
  eligible.sort((a,b)=>stampOf(b.group.lastCustomer)-stampOf(a.group.lastCustomer));
  const output={processed:0,readings:0,suggestions:0,errors:0,limited:false};
  for(const entry of eligible.slice(0,20)){
    output.processed++;
    try {
      if(entry.readingDue){await readConversation(ctx,entry.group,options);output.readings++;}
      if(entry.suggestionDue&&entry.group.refs.length===0){const suggested=await suggestLink(ctx,entry.group,orders,options);if(suggested)output.suggestions++;}
    } catch(error) { if(error.message==='AI_DAILY_LIMIT'){output.limited=true;break;}output.errors++; }
  }
  return output;
}

async function latestAiForJourney(ctx,journeyId){
  const readings=await rows(ctx,'conversation_ai_readings',{select:'id,summary_json,message_count,last_customer_at,created_at,chat_id',environment:'eq.'+ctx.environment,journey_id:'eq.'+journeyId,status:'eq.ACTIVE',order:'created_at.desc',limit:'1'});
  const reading=readings[0]||null;
  const [items,suggestions]=await Promise.all([
    reading?allRows(ctx,'conversation_ai_items',{select:'id,item_json,evidence_text,manual_review,status,created_at',environment:'eq.'+ctx.environment,reading_id:'eq.'+reading.id,status:'eq.PENDING',order:'created_at.asc'}):Promise.resolve([]),
    rows(ctx,'whatsapp_link_suggestions',{select:'id,target_ref,motives,status,created_at',environment:'eq.'+ctx.environment,source_journey_id:'eq.'+journeyId,status:'eq.PENDING',suggestion_kind:'eq.AI',order:'created_at.desc',limit:'1'})
  ]);
  return {reading:reading?{...reading,items:items.map((item)=>({...item,...item.item_json,evidence:item.evidence_text}))}:null,suggestion:suggestions[0]||null};
}

module.exports={stoppedJourneys,AI_MIN_MCS_MESSAGES,AI_CONTEXT_MAX_CHARS,AI_CONTEXT_MAX_MESSAGES,AI_FAILURE_BACKOFF_MS,aiContextWindow,anthropicJson,allConversationData,automaticAttemptAllowed,calculatorOrders,deterministicCandidates,firstJson,latestAiForJourney,readConversation,reserveCall,runCron,suggestLink,validatedReading};

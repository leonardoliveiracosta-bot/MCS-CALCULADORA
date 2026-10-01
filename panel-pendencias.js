'use strict';

const { allRows, insert, patchRows, rows, supabase } = require('./panel-server');
const { contactIndex, insightUsable } = require('./panel-contact');
const { score, loadScoreVehicles } = require('./panel-ready');
const { toggleEnabled } = require('./panel-domain');

const THREE_DAYS = 3 * 86400000;
const GENERAL_MAX_MESSAGES = 150;
const GENERAL_MAX_CHARS = 40000;
// Anthropic calls have a 20-second timeout.  Leave room for the database write
// so one Vercel Cron invocation remains below the requested ~50 seconds.
const GENERAL_MAX_SECONDS = 28;

const SITUATIONS = Object.freeze({
  NO_RESPONSE: { key:'NO_RESPONSE', label:'🔴 Sem resposta', tone:'red' },
  MCS_PENDING: { key:'MCS_PENDING', label:'🟠 Parada com você', tone:'orange' },
  CUSTOMER_PENDING: { key:'CUSTOMER_PENDING', label:'🟡 Parada com o cliente', tone:'yellow' },
  IN_PROGRESS: { key:'IN_PROGRESS', label:'🟢 Em andamento', tone:'green' },
  CLOSED: { key:'CLOSED', label:'⚪ Concluída / sem interesse', tone:'gray' }
});

function at(message) { return Date.parse(message?.occurred_at_utc || message?.occurred_at_local || message?.created_at || 0) || 0; }
function clean(value, limit=2000) { return String(value || '').replace(/\s+/g,' ').trim().slice(0,limit); }
function phoneFor(list) { return list.find((entry)=>entry.is_current!==false&&entry.is_primary) || list.find((entry)=>entry.is_current!==false) || list[0] || null; }
function refFor(journey, refs) { return [journey.reference_code,...refs.filter((row)=>row.journey_id===journey.id).map((row)=>row.ref_code)].map((value)=>String(value||'').trim().toUpperCase()).find((value)=>/^[A-HJ-NP-Z2-9]{5}$/.test(value)) || null; }
function fixedSituation(group, insight, now=Date.now()) {
  // M5: "não é lead" is never a pending conversation. A closed ficha is pending only when the
  // customer wrote after it was closed ("voltou a falar"); an older last message stays closed.
  if (group.contact.is_lead === false) return 'CLOSED';
  if (group.journey.status === 'ENCERRADO' || group.enabled === false) {
    const closedAt = Math.max(Date.parse(group.journey.closed_at || 0) || 0, Date.parse(group.switchedAt || 0) || 0);
    return group.latest.direction === 'CUSTOMER' && at(group.latest) > closedAt ? 'NO_RESPONSE' : 'CLOSED';
  }
  if (group.latest.direction === 'CUSTOMER') return 'NO_RESPONSE';
  if (insight && insight.last_ai_message_id === group.latest.id && SITUATIONS[insight.situation]) return insight.situation;
  return now-at(group.latest) > THREE_DAYS ? 'CUSTOMER_PENDING' : 'IN_PROGRESS';
}
function statusFromAI(value) {
  const normalized=String(value||'').trim().toUpperCase();
  return ['MCS_PENDING','CUSTOMER_PENDING','IN_PROGRESS','CLOSED'].includes(normalized) ? normalized : 'UNKNOWN';
}
function heatFromAI(value) { const heat=String(value||'').trim().toUpperCase(); return ['HOT','WARM','COLD'].includes(heat) ? heat : 'COLD'; }
function formatSegment(messages, start, accumulated) {
  const selected=[]; let size=JSON.stringify({acumulado:clean(accumulated,8000),mensagens:selected}).length; let index=start;
  while(index<messages.length && selected.length<GENERAL_MAX_MESSAGES) {
    const message=messages[index];
    const row={quem:message.direction==='CUSTOMER'?'Cliente':'MCS',texto:String(message.body_text||''),quando:new Date(at(message)).toISOString()};
    const added=JSON.stringify(row).length + 2;
    if(selected.length && size+added>GENERAL_MAX_CHARS) break;
    if(!selected.length && size+added>GENERAL_MAX_CHARS) throw new Error('MESSAGE_TOO_LONG');
    selected.push(row); size+=added; index++;
  }
  return {messages:selected,nextIndex:index,user:JSON.stringify({acumulado:clean(accumulated,8000),mensagens:selected})};
}
function modelPrices(model) {
  const name=String(model||'').toLowerCase();
  if(name.includes('opus-5-5')) return {input:4,output:20};
  if(name.includes('sonnet-5')) return {input:2,output:10};
  if(name.includes('haiku')) return {input:1,output:5};
  return {input:4,output:20};
}
function maximumCostUsd(model) { const price=modelPrices(model); return ((40000*price.input)+(2400*price.output))/1000000; }
function usageCostUsd(usage, model) {
  const price=modelPrices(model), input=Number(usage?.input_tokens||0)+Number(usage?.cache_creation_input_tokens||0)+Number(usage?.cache_read_input_tokens||0), output=Number(usage?.output_tokens||0);
  return (input*price.input+output*price.output)/1000000;
}
function firstJson(text) {
  const source=String(text||'');
  for(let start=source.indexOf('{');start>=0;start=source.indexOf('{',start+1)){
    let depth=0,quoted=false,escaped=false;
    for(let i=start;i<source.length;i++){
      const c=source[i];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}
      else if(c==='"')quoted=true;else if(c==='{')depth++;else if(c==='}'&&--depth===0){try{return JSON.parse(source.slice(start,i+1));}catch(_){break;}}
    }
  }
  throw new Error('AI_RESPONSE_INVALID');
}
async function callAnthropic(system,user,options={}) {
  if(!process.env.ANTHROPIC_API_KEY||!process.env.ANTHROPIC_MODEL)throw new Error('AI_UNAVAILABLE');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000),fetchImpl=options.fetchImpl||fetch;
  try{
    const response=await fetchImpl('https://api.anthropic.com/v1/messages',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json','x-api-key':process.env.ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:process.env.ANTHROPIC_MODEL,max_tokens:1200,temperature:0,system,messages:[{role:'user',content:user}]})});
    if(!response.ok)throw new Error('AI_UNAVAILABLE');
    const payload=await response.json(),text=(payload.content||[]).filter((part)=>part.type==='text').map((part)=>part.text).join('\n');
    return {parsed:firstJson(text),usage:payload.usage||{}};
  }catch(error){if(error.message==='AI_RESPONSE_INVALID')throw error;throw new Error('AI_UNAVAILABLE');}finally{clearTimeout(timer);}
}

async function conversationGroups(ctx) {
  const [journeys,contacts,phones,chats,links,messages,refs,toggles,insights,resolutions,calcRuns,checklist,promises,vehicles]=await Promise.all([
    allRows(ctx,'journeys',{select:'id,contact_id,reference_code,status,stage,stage_frozen,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,qualified_at,closed_at,vehicle_text,created_at,updated_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'contacts',{select:'id,display_name,is_lead,location_text',environment:'eq.'+ctx.environment}),
    allRows(ctx,'contact_phones',{select:'contact_id,phone_e164,phone_raw,is_primary,is_current',environment:'eq.'+ctx.environment}),
    allRows(ctx,'chats',{select:'id,contact_id,channel,is_group',environment:'eq.'+ctx.environment}),
    allRows(ctx,'message_journeys',{select:'journey_id,message_id',environment:'eq.'+ctx.environment,undone_at:'is.null'}),
    allRows(ctx,'messages',{select:'id,chat_id,channel,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,source_kind,whatsapp_delivered_at,whatsapp_read_at,created_at,undone_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'journey_refs',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment}),
    allRows(ctx,'journey_toggle_states',{select:'journey_id,enabled,switched_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'conversation_pending_insights',{select:'journey_id,chat_id,situation,heat,summary_text,next_step_text,translation_text,last_ai_message_id,updated_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'conversation_pending_resolutions',{select:'journey_id,chat_id,resolved_message_id',environment:'eq.'+ctx.environment,undone_at:'is.null'}),
    allRows(ctx,'calc_runs',{select:'id,created_at,dados,is_test',order:'created_at.asc'}),
    allRows(ctx,'journey_checklist',{select:'journey_id,status',environment:'eq.'+ctx.environment}),
    allRows(ctx,'promises',{select:'journey_id,status,due_at',environment:'eq.'+ctx.environment}),
    loadScoreVehicles(ctx).catch(()=>[])
  ]);
  const effectiveMessages=messages.filter((message)=>!message.undone_at),contactsIndex=contactIndex({calcRuns,messages:effectiveMessages,messageLinks:links});
  const byJourney=new Map(journeys.map((row)=>[row.id,row])),byContact=new Map(contacts.map((row)=>[row.id,row])),byChat=new Map(chats.map((row)=>[row.id,row])),byMessage=new Map(effectiveMessages.map((row)=>[row.id,row])),toggleByJourney=new Map(toggles.map((row)=>[row.journey_id,row])),insightByKey=new Map(insights.map((row)=>[row.journey_id+'|'+row.chat_id,row])),resolutionByKey=new Map(resolutions.map((row)=>[row.journey_id+'|'+row.chat_id,row]));
  const grouped=new Map();
  for(const link of links){const journey=byJourney.get(link.journey_id),message=byMessage.get(link.message_id),chat=message&&byChat.get(message.chat_id);if(!journey||!message||!chat||chat.is_group||chat.channel!=='WHATSAPP')continue;const key=journey.id+'|'+chat.id;if(!grouped.has(key))grouped.set(key,{key,journey,chat,contact:byContact.get(journey.contact_id)||{},messages:[]});grouped.get(key).messages.push(message);}
  const result=[];
  for(const group of grouped.values()){
    group.messages.sort((a,b)=>at(a)-at(b)||String(a.id).localeCompare(String(b.id)));group.latest=group.messages.filter((message)=>!message.is_automatic).at(-1)||group.messages.at(-1);if(!group.latest)continue;
    group.phones=phones.filter((row)=>row.contact_id===group.journey.contact_id);group.phone=phoneFor(group.phones);group.ref=refFor(group.journey,refs);const facts=contactsIndex.facts({journeyId:group.journey.id,ref:group.ref,refs:refs.filter((row)=>row.journey_id===group.journey.id).map((row)=>row.ref_code)});if(!facts.entered)continue;group.contactFacts=facts;group.insight=insightByKey.get(group.key)||null;group.resolution=resolutionByKey.get(group.key)||null;const toggle=toggleByJourney.get(group.journey.id);group.enabled=toggleEnabled(group.journey.status,toggle);group.switchedAt=toggle?.switched_at||null;group.ready=score({zip:group.contact.location_text?.match(/\b\d{5}\b/)?.[0]||'',budgetCents:group.journey.budget_cents}, {...group.journey,phones:group.phones,enabled:group.enabled}, {checklist,promises,messages:group.messages.map((message)=>({...message,journey_id:group.journey.id}))}, vehicles);result.push(group);
  }
  return result;
}

function itemFromGroup(group, now=Date.now()) {
  const situation=fixedSituation(group,group.insight,now),latestAt=at(group.latest),resolution=group.resolution;
  const resolved=Boolean(resolution&&resolution.resolved_message_id===group.latest.id);
  return {journeyId:group.journey.id,chatId:group.chat.id,contactId:group.journey.contact_id,name:group.contact.display_name||'Contato sem nome',phone:group.phone?.phone_e164||group.phone?.phone_raw||null,ref:group.ref,
    situation,...(()=>{/* A13: the AI heat counts only while it is valid (same rule as the other screens). */const valid=insightUsable(group.insight,{...group.journey,enabled:group.enabled},group.latest.id,now);return {heat:valid?heatFromAI(group.insight.heat):(group.ready?.score>=60?'HOT':group.ready?.score>=35?'WARM':'COLD'),heatSource:valid?'AI':'CALCULATED'};})(),aiSummary:group.insight?.summary_text||'',aiNextStep:group.insight?.next_step_text||'',daysStalled:Math.max(0,Math.floor((now-latestAt)/86400000)),latestMessage:group.latest.body_text||'',latestDirection:group.latest.direction,latestAt:new Date(latestAt).toISOString(),
    translation:group.insight?.last_ai_message_id===group.latest.id?group.insight.translation_text||'':'',summary:group.insight?.last_ai_message_id===group.latest.id?group.insight.summary_text||'':'',nextStep:group.insight?.last_ai_message_id===group.latest.id?group.insight.next_step_text||'':'',resolved,isLead:group.contact.is_lead!==false,contactAt:group.contactFacts?.latestAt?new Date(group.contactFacts.latestAt).toISOString():null,contactChannel:group.contactFacts?.channel||null};
}
function sortPending(items, mode) { return items.slice().sort((a,b)=>{if(mode==='oldest')return Date.parse(a.latestAt)-Date.parse(b.latestAt)||a.name.localeCompare(b.name);if(mode==='recent')return Date.parse(b.latestAt)-Date.parse(a.latestAt)||a.name.localeCompare(b.name);const heat={HOT:0,WARM:1,COLD:2},situation={NO_RESPONSE:0,MCS_PENDING:1,CUSTOMER_PENDING:2,IN_PROGRESS:3,CLOSED:4};return (heat[a.heat]-heat[b.heat])||(situation[a.situation]-situation[b.situation])||(Date.parse(a.latestAt)-Date.parse(b.latestAt))||a.name.localeCompare(b.name);}); }
async function pendingSnapshot(ctx) {
  const [groups,run,history]=await Promise.all([conversationGroups(ctx),rows(ctx,'conversation_general_read_runs',{select:'status,total_conversations,completed_conversations,budget_usd,spent_usd,reserved_usd,last_error,started_at,updated_at',environment:'eq.'+ctx.environment,limit:'1'}),rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'in.(history,mixed)',order:'received_at.desc',limit:'1'})]);
  const now=Date.now(),items=groups.map((group)=>itemFromGroup(group,now)),counts={NO_RESPONSE:0,MCS_PENDING:0,CUSTOMER_PENDING:0,IN_PROGRESS:0,CLOSED:0};items.forEach((item)=>{if(!item.resolved)counts[item.situation]++;});
  return {groups,items,counts,run:run[0]||{status:'IDLE',total_conversations:0,completed_conversations:0,budget_usd:20,spent_usd:0,reserved_usd:0},lastHistoryAt:history[0]?.received_at||null};
}
async function generalStatus(ctx) { const snapshot=await pendingSnapshot(ctx); return {run:snapshot.run,lastHistoryAt:snapshot.lastHistoryAt,historyReady:!snapshot.lastHistoryAt||Date.now()-Date.parse(snapshot.lastHistoryAt)>=30*60000,counts:snapshot.counts,items:snapshot.items}; }
async function startGeneralRead(ctx) {
  const snapshot=await pendingSnapshot(ctx);if(snapshot.lastHistoryAt&&Date.now()-Date.parse(snapshot.lastHistoryAt)<30*60000){const error=new Error('HISTORY_STILL_ARRIVING');error.lastHistoryAt=snapshot.lastHistoryAt;throw error;}
  const payload=snapshot.groups.map((group)=>({journeyId:group.journey.id,chatId:group.chat.id,lastMessageId:group.latest.id,messageCount:group.messages.length}));
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_pending_start_general_read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_rows:payload})});
}
function validatedGeneral(parsed) {
  const source=parsed&&typeof parsed==='object'?parsed:{};return {accumulated:clean(source.accumulated,10000),situation:statusFromAI(source.situation),heat:heatFromAI(source.heat),summary:clean(source.summary,1800),nextStep:clean(source.nextStep,900),translation:clean(source.translation,1800)};
}
async function generalBatch(ctx, options={}) {
  const deadline=Date.now()+GENERAL_MAX_SECONDS*1000,output={processed:0,completed:0,paused:false,limited:false,unavailable:false};const groups=await conversationGroups(ctx),byKey=new Map(groups.map((group)=>[group.journey.id+'|'+group.chat.id,group]));
  while(Date.now()<deadline){
    const reserve=maximumCostUsd(process.env.ANTHROPIC_MODEL);const claimed=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_pending_claim_general_read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_reserve_usd:reserve})});
    const claim=Array.isArray(claimed)?claimed[0]:null;if(!claim)break;const group=byKey.get(claim.journey_id+'|'+claim.chat_id);
    if(!group){await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_pending_finish_general_read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_journey:claim.journey_id,p_chat:claim.chat_id,p_next:claim.message_count,p_summary:claim.accumulated_summary||'',p_completed:false,p_actual_usd:0,p_reserved_usd:claim.reserved_usd,p_error:'CONVERSATION_NOT_FOUND'})});output.paused=true;break;}
    try{
      const segment=formatSegment(group.messages.slice(0,claim.message_count),Number(claim.next_message_index||0),claim.accumulated_summary||'');const final=segment.nextIndex>=Number(claim.message_count);const system=final
        ? 'Você revisa uma conversa da My Car Scout. Responda SOMENTE JSON {accumulated,situation,heat,summary,nextStep,translation}. situation é MCS_PENDING, CUSTOMER_PENDING, IN_PROGRESS ou CLOSED; heat é HOT, WARM ou COLD. Resumo, próximo passo e tradução em português. Regra da mesa: quem busca POR CARRO (Find One: carro, faixa de ano e de milhagem) nunca recebe pergunta de lance, orçamento ou valor; quem busca POR VALOR (carro e lance máximo) nunca recebe pergunta de ano ou milhagem; não sugira perguntar o que o cliente ou a calculadora já informaram. translation só recebe texto se a última mensagem estiver em outro idioma. Não invente fatos.'
        : 'Você resume uma parte de uma conversa da My Car Scout. Responda SOMENTE JSON {accumulated}. Preserve fatos, promessas, interesse, carro, dinheiro e próximo passo, em português, sem inventar.';
      const answer=await callAnthropic(system,segment.user,options),parsed=validatedGeneral(answer.parsed),actual=usageCostUsd(answer.usage,process.env.ANTHROPIC_MODEL);
      const fallback=fixedSituation(group,null),finalSituation=parsed.situation==='UNKNOWN'?fallback:parsed.situation;
      const latest=group.messages[Math.min(group.messages.length,Number(claim.message_count))-1];await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_pending_finish_general_read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_journey:claim.journey_id,p_chat:claim.chat_id,p_next:segment.nextIndex,p_summary:parsed.accumulated,p_completed:final,p_situation:final?finalSituation:null,p_heat:final?parsed.heat:null,p_final_summary:final?parsed.summary:null,p_next_step:final?parsed.nextStep:null,p_translation:final?parsed.translation:null,p_last_message:final?latest.id:null,p_actual_usd:actual,p_reserved_usd:claim.reserved_usd,p_error:null})});output.processed++;if(final)output.completed++;
    }catch(error){await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_pending_finish_general_read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_journey:claim.journey_id,p_chat:claim.chat_id,p_next:claim.next_message_index,p_summary:claim.accumulated_summary||'',p_completed:false,p_actual_usd:0,p_reserved_usd:claim.reserved_usd,p_error:error.message==='AI_UNAVAILABLE'?'IA_UNAVAILABLE':'GENERAL_READ_FAILED'})}).catch(()=>null);output.unavailable=error.message==='AI_UNAVAILABLE';output.paused=true;break;}
  }
  const state=await generalStatus(ctx);output.status=state.run.status;output.limited=state.run.status==='LIMIT';return output;
}
async function storeDailyInsight(ctx, group, values) {
  if(!group?.latest)return null;const situation=group.latest.direction==='CUSTOMER'?'NO_RESPONSE':statusFromAI(values.situation),heat=heatFromAI(values.heat);
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/conversation_pending_insights?on_conflict=environment,journey_id,chat_id',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({environment:ctx.environment,journey_id:group.journey.id,chat_id:group.chat.id,situation,heat,summary_text:clean(values.summary,1800),next_step_text:clean(values.nextStep,900),translation_text:clean(values.translation,1800)||null,last_ai_message_id:group.latest.id,updated_at:new Date().toISOString()})});
}
async function resolvePending(ctx, body) {
  const group=(await conversationGroups(ctx)).find((entry)=>entry.journey.id===body.journeyId&&entry.chat.id===body.chatId);if(!group)throw new Error('CONVERSATION_NOT_FOUND');
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/conversation_pending_resolutions?on_conflict=environment,journey_id,chat_id',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({environment:ctx.environment,journey_id:group.journey.id,chat_id:group.chat.id,resolved_message_id:group.latest.id,resolved_at:new Date().toISOString(),resolved_by:ctx.panel.id,undone_at:null,undone_by:null})});
}

async function unresolvePending(ctx, body) {
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/conversation_pending_resolutions?environment=eq.'+ctx.environment+'&journey_id=eq.'+body.journeyId+'&chat_id=eq.'+body.chatId+'&undone_at=is.null',{method:'PATCH',headers:{'content-type':'application/json',prefer:'return=minimal'},body:JSON.stringify({undone_at:new Date().toISOString(),undone_by:ctx.panel.id})});
}

module.exports={GENERAL_MAX_CHARS,GENERAL_MAX_MESSAGES,SITUATIONS,callAnthropic,conversationGroups,fixedSituation,formatSegment,generalBatch,generalStatus,itemFromGroup,maximumCostUsd,modelPrices,pendingSnapshot,resolvePending,unresolvePending,sortPending,startGeneralRead,statusFromAI,storeDailyInsight,usageCostUsd,validatedGeneral};

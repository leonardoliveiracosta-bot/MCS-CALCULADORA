'use strict';
const {supabase,patchRows}=require('./panel-server');
const {explicitRefs,isCalculatorTemplate,messageMode}=require('./panel-ref-proof');
const {latestActiveUpload}=require('./panel-manheim-state');
const {linkFor,listCars}=require('./panel-option-links');
const {isEnabled,sendMessage,recordSent}=require('./whatsapp-auto-reply');

// Three messages, each on its own: the link, who reaches out next, and what comes after the choice.
const LINK_LEADS={en:'Options for your search',pt:'Opções para sua busca',es:'Opciones para tu búsqueda'};
const EXPLANATIONS={
  en:'Our buying specialist will contact you to confirm exactly what you want and narrow down the options.',
  pt:'Nosso especialista em compras vai entrar em contato para confirmar exatamente o que você procura e refinar as opções.',
  es:'Nuestro especialista en compras se pondrá en contacto contigo para confirmar exactamente lo que buscas y afinar las opciones.'
};
const DETAILS={
  en:'Once you choose, you\u2019ll receive photos, the vehicle history and the full listing, so you can review everything before bidding.',
  pt:'Depois da sua escolha, você recebe as fotos, o histórico do veículo e o anúncio completo, para revisar tudo antes do lance.',
  es:'Una vez que elijas, recibirás las fotos, el historial del vehículo y el anuncio completo, para que revises todo antes de pujar.'
};
const langOf=(language)=>{const lang=String(language||'en').toLowerCase().split(/[-_]/)[0];return EXPLANATIONS[lang]?lang:'en';};
function explanation(language){return EXPLANATIONS[langOf(language)];}
function details(language){return DETAILS[langOf(language)];}
function linkMessage(code,language,count=null){
  const lang=langOf(language),n=Number.isInteger(count)&&count>0?count:null;
  const lead=n===null?LINK_LEADS[lang]:lang==='pt'?`Encontramos ${n} ${n===1?'opção':'opções'} para sua busca`:lang==='es'?`Encontramos ${n} ${n===1?'opción':'opciones'} para tu búsqueda`:`We found ${n} ${n===1?'option':'options'} for your search`;
  return lead+':\nhttps://www.mycarscout.net/o/'+code;
}
async function call(ctx,name,args){
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/'+name,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(8000),body:JSON.stringify(args)});
}
const services={call,latestActiveUpload,linkFor,sendMessage,recordSent,
  saveLinkBody:async(ctx,id,body)=>{const rows=await patchRows(ctx,'whatsapp_auto_options',{environment:'eq.'+ctx.environment,id:'eq.'+id,stage:'eq.LINK_SENDING'},{link_body:body},true);return Boolean(rows?.length);},
  prepareOptions:(...args)=>require('./whatsapp-options-prepare').prepareOptions(...args),
  queueTimer:(...args)=>require('./whatsapp-options-queue').queueTimer(...args),
  queueProbe:(...args)=>require('./whatsapp-options-queue').queueProbe(...args)};
const STEPS=['LINK','EXPLANATION','DETAILS'];
function enoughTime(deadlineAt){return !deadlineAt||deadlineAt-Date.now()>=10000;}
function failureCode(error){const code=String(error?.message||'');return /^D360_[A-Z0-9_]{3,80}$/.test(code)?code:'AUTO_OPTIONS_FAILED';}
function enabled(){return isEnabled()&&String(process.env.AUTO_OPTIONS_ENABLED||'true').toLowerCase()!=='false'&&(!process.env.VERCEL_ENV||process.env.VERCEL_ENV==='production');}
async function optionCount(ctx,key,deps){
  const upload=await deps.latestActiveUpload(ctx);
  if(!upload)return 0;
  // Same pagination and deduplication as the public link, including all offer groups.
  const cars=await listCars(ctx,upload.id,key,deps.call);
  return cars.some(car=>car.estimatedMarketReference>0)?cars.length:0;
}
async function publishTimer(ctx,jobId,step,dueAt,deps){
  const adjusted=await deps.call(ctx,'panel_whatsapp_options_business_due',{p_environment:ctx.environment,p_job:jobId,p_step:step});
  dueAt=adjusted?.dueAt||dueAt;
  await deps.queueTimer(jobId,step,dueAt,ctx.environment);
  await deps.call(ctx,'panel_whatsapp_auto_options_timer_queued',{p_environment:ctx.environment,p_job:jobId,p_step:step});
}

// Only the live receiver calls this. Neither historical imports nor retries backfill sends.
async function maybeAutoOptions(ctx,rawId,item,result,options={},deps=services){
  if(!isEnabled()||String(process.env.AUTO_OPTIONS_ENABLED||'true').toLowerCase()==='false')return {sent:false,reason:'DISABLED'};
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production')return {sent:false,reason:'OUTSIDE_PRODUCTION'};
  if(result?.duplicate||result?.vitrineHandled||!result?.contactId||!result?.messageId||!result?.journeyId||item.direction!=='CUSTOMER'||item.eventField!=='messages'||item.source_kind!=='WHATSAPP_WEBHOOK')return {sent:false,reason:'NOT_LIVE_INBOUND'};
  if(!options.greeting?.sent&&!['RECENT_MESSAGE','CALCULATOR_ALREADY_KNOWN'].includes(options.greeting?.reason))return {sent:false,reason:'GREETING_NOT_READY'};
  const refs=explicitRefs(item.body),mode=messageMode(item.body);
  if(refs.length!==1||!mode||!isCalculatorTemplate(item.body))return {sent:false,reason:'NO_CALCULATOR_REF'};
  // An opt-out accompanied by a pasted calculator request must not trigger an offer.
  if(/\b(stop|unsubscribe|do not contact|don't contact|não me contate|nao me contate|no me contactes|cancelar)\b/i.test(item.body))return {sent:false,reason:'OPT_OUT'};
  const identity={p_environment:ctx.environment,p_contact:result.contactId,p_journey:result.journeyId,p_inbound_message:result.messageId,p_inbound_wamid:item.messageId,p_ref:refs[0],p_mode:mode,p_phone:item.phone||null,p_user_id:item.userId||null};
  let job=null,scheduled=false;
  const advance=async(stage,wamid=null,error=null)=>{
    const changed=await deps.call(ctx,'panel_whatsapp_auto_options_advance',{p_environment:ctx.environment,p_job:job.id,p_stage:stage,p_wamid:wamid,p_error:error});
    if(!changed?.updated)throw Error('AUTO_OPTIONS_STATE_CONFLICT');
  };
  try{
    if(!enoughTime(options.deadlineAt))return {sent:false,reason:'DEADLINE'};
    const context=await deps.call(ctx,'panel_whatsapp_auto_options_context',identity);
    if(!context?.eligible)return {sent:false,reason:context?.reason||'NOT_ELIGIBLE'};
    // New requests are not matched until the panel opens. Reserve the timer first;
    // its worker prepares this demand without depending on a human opening the panel.
    if(!enoughTime(options.deadlineAt))return {sent:false,reason:'DEADLINE'};
    const code=await deps.linkFor(ctx,context.key,null);
    const link=linkMessage(code,context.language),body=explanation(context.language),after=details(context.language);
    const claim=await deps.call(ctx,'panel_whatsapp_auto_options_claim',{...identity,p_link:link,p_explanation:body,p_details:after});
    if(!claim?.claimed)return {sent:false,reason:claim?.reason||'NOT_ELIGIBLE'};
    job=claim;
    const timer=await deps.call(ctx,'panel_whatsapp_auto_options_schedule_business',{p_environment:ctx.environment,p_job:job.id,p_raw:rawId,p_phone:item.phone||null,p_user_id:item.userId||null,p_greeting_wamid:options.greeting?.messageId||null});
    if(!timer?.scheduled){await advance('FAILED',null,timer?.reason||'TIMER_FAILED');return {sent:false,reason:timer?.reason||'TIMER_FAILED'};}
    scheduled=true;
    await publishTimer(ctx,job.id,'LINK',timer.dueAt,deps);
    return {sent:false,scheduled:true,jobId:job.id};
  }catch(error){
    const reason=failureCode(error);
    // Once the timer exists, the recovery cron can safely republish it using the same key.
    if(job&&!scheduled)await advance('FAILED',null,reason).catch(()=>null);
    // No automatic retry after an uncertain provider response: never duplicate customer sends.
    console.error('[whatsapp-auto-options]',{reason,claimed:Boolean(job)});
    return {sent:false,scheduled,reason};
  }
}

// Each queue event sends at most one message; the database owns timing and order.
async function processOptionsTimer(ctx,message,deps=services){
  if(!enabled()||message?.environment!==ctx.environment||!STEPS.includes(message?.step)||!require('./panel-server').isUuid(message?.jobId))return {sent:false,reason:'DISABLED_OR_INVALID'};
  const {jobId,step}=message;
  const args={p_environment:ctx.environment,p_job:jobId};
  const advance=(stage,wamid=null,error=null)=>deps.call(ctx,'panel_whatsapp_auto_options_advance',{...args,p_stage:stage,p_wamid:wamid,p_error:error});
  const business=await deps.call(ctx,'panel_whatsapp_options_business_due',{...args,p_step:step});
  if(business?.deferred&&Date.parse(business.dueAt)>Date.now()){await publishTimer(ctx,jobId,step,business.dueAt,deps);return {sent:false,deferred:true};}
  const context=await deps.call(ctx,'panel_whatsapp_auto_options_step_context',{...args,p_step:step});
  if(context?.resumeExplanation){await publishTimer(ctx,jobId,'EXPLANATION',context.dueAt,deps);return {sent:false,resumed:true};}
  if(context?.resumeDetails){await publishTimer(ctx,jobId,'DETAILS',context.dueAt,deps);return {sent:false,resumed:true};}
  if(!context?.ready){
    if(context?.reason==='NOT_DUE')throw Object.assign(Error('TIMER_NOT_DUE'),{afterSeconds:Math.max(1,Math.ceil((Date.parse(context.dueAt)-Date.now())/1000))});
    if(!['STATE_CONFLICT','NOT_SCHEDULED'].includes(context?.reason))await advance('FAILED',null,context?.reason||'NOT_ELIGIBLE');
    return {sent:false,reason:context?.reason||'NOT_ELIGIBLE'};
  }
  let count=null;
  if(step==='LINK'){
    const prepared=await deps.prepareOptions(ctx,jobId,context.key);
    if(prepared?.reason){
      if(!['STATE_CONFLICT','NOT_SCHEDULED'].includes(prepared.reason))await advance('FAILED',null,prepared.reason);
      return {sent:false,reason:prepared.reason};
    }
    count=await optionCount(ctx,context.key,deps);
    if(!count){
      await advance('FAILED',null,'NO_OPTIONS');return {sent:false,reason:'NO_OPTIONS'};
    }
  }
  // Matching may cross 18:00; check again immediately before claiming a provider send.
  const beforeSend=await deps.call(ctx,'panel_whatsapp_options_business_due',{...args,p_step:step});
  if(beforeSend?.deferred&&Date.parse(beforeSend.dueAt)>Date.now()){await publishTimer(ctx,jobId,step,beforeSend.dueAt,deps);return {sent:false,deferred:true};}
  if(step==='LINK'){
    const code=(String(context.body||'').match(/https:\/\/www\.mycarscout\.net\/o\/([A-Za-z0-9_-]{32,80})/)||[])[1];
    if(!code){await advance('FAILED',null,'LINK_INVALID');return {sent:false,reason:'LINK_INVALID'};}
    const body=linkMessage(code,context.language,count);
    context.body=body;
  }
  // With a third message the explanation is not the end: it waits for the details (a job without one ends as before).
  const sending=step+'_SENDING';
  const sentStage=step==='LINK'?'LINK_SENT':step==='EXPLANATION'&&context.hasDetails?'EXPLANATION_SENT':'COMPLETE';
  // A duplicate callback losing this atomic claim must never fail another worker's send.
  const claimed=await advance(sending);
  if(!claimed?.updated)return {sent:false,reason:claimed?.reason||'STATE_CONFLICT'};
  let confirmed;
  try{
    // Only the worker that won the send claim may save the counted text.
    // Automatic-message classification then reads the exact body sent to the client.
    if(step==='LINK'&&!await deps.saveLinkBody(ctx,jobId,context.body))throw Error('AUTO_OPTIONS_STATE_CONFLICT');
    const wamid=await deps.sendMessage(context.recipient,context.body,8000);
    confirmed=await advance(sentStage,wamid);
    if(!confirmed?.updated)throw Error('AUTO_OPTIONS_STATE_CONFLICT');
    try{await deps.recordSent(ctx,context.rawId,context.recipient,wamid,context.body,8000);}
    catch(_){await advance(sentStage,wamid,'PANEL_RECORD_FAILED').catch(()=>null);}
  }catch(error){
    const reason=failureCode(error);
    await advance('FAILED',null,reason).catch(()=>null);
    console.error('[whatsapp-auto-options]',{reason,step});
    return {sent:false,reason}; // Never retry an uncertain WhatsApp side effect.
  }
  // Publication failures may retry this event: LINK_SENT resumes the explanation only, EXPLANATION_SENT the details only.
  if(step==='LINK')await publishTimer(ctx,jobId,'EXPLANATION',confirmed.explanationDueAt,deps);
  if(sentStage==='EXPLANATION_SENT')await publishTimer(ctx,jobId,'DETAILS',confirmed.detailsDueAt,deps);
  return {sent:true,jobId,step};
}
async function recoverOptionsTimers(ctx,deps=services){
  if(!enabled())return {queued:0};
  const timers=await deps.call(ctx,'panel_whatsapp_auto_options_pending_timers',{p_environment:ctx.environment});
  let queued=0;
  for(const timer of timers||[]){
    try{
      if(timer.step==='PROBE'){
        await deps.queueProbe(timer.seconds,ctx.environment,{probeId:timer.id,requestedAt:timer.requestedAt});
        await deps.call(ctx,'panel_whatsapp_auto_options_timer_queued',{p_environment:ctx.environment,p_job:timer.id,p_step:'PROBE'});
      }else await publishTimer(ctx,timer.id,timer.step,timer.dueAt,deps);
      queued++;
    }
    catch(_){console.error('[whatsapp-auto-options]',{reason:'TIMER_PUBLISH_FAILED',step:timer.step});}
  }
  return {queued};
}
async function recordOptionsProbe(ctx,message,deps=services){
  if(message?.kind!=='PROBE'||message.environment!==ctx.environment||![35,90].includes(message.seconds)||!require('./panel-server').isUuid(message.probeId))throw Error('PROBE_INVALID');
  return deps.call(ctx,'panel_whatsapp_options_probe_received',{p_environment:ctx.environment,p_probe:message.probeId,p_seconds:message.seconds});
}
module.exports={EXPLANATIONS,DETAILS,explanation,details,linkMessage,maybeAutoOptions,processOptionsTimer,recoverOptionsTimers,recordOptionsProbe};

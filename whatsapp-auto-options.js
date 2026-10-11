'use strict';
const {supabase}=require('./panel-server');
const {explicitRefs,isCalculatorTemplate,messageMode}=require('./panel-ref-proof');
const {latestActiveUpload}=require('./panel-manheim-state');
const {linkFor,publicCar}=require('./panel-option-links');
const {isEnabled,sendMessage,recordSent}=require('./whatsapp-auto-reply');

const EXPLANATIONS={
  en:`Just so you know how to read the options I sent you, the value on each car is our market reference, based on recent dealer wholesale sales of comparable cars. It can include adjustments for miles, condition and our team's pricing review.

That reference comes from the market where dealers buy, before retail markup. Our goal from here is to find the right car and buy it for you below that reference.`,
  pt:`Para entender as opções que enviei, o valor de cada carro é a nossa referência de mercado, baseada em vendas recentes de carros semelhantes no atacado entre lojistas. Ela pode incluir ajustes por milhas, condição e revisão de preço da nossa equipe.

Essa referência vem do mercado onde os lojistas compram, antes da margem de revenda. Nosso objetivo daqui em diante é encontrar o carro certo e comprá-lo para você abaixo dessa referência.`,
  es:`Para entender las opciones que te envié, el valor de cada auto es nuestra referencia de mercado, basada en ventas recientes de autos similares al por mayor entre concesionarios. Puede incluir ajustes por millas, condición y la revisión de precios de nuestro equipo.

Esa referencia viene del mercado donde compran los concesionarios, antes del margen de venta al público. Nuestro objetivo ahora es encontrar el auto adecuado y comprarlo para ti por debajo de esa referencia.`
};
function explanation(language){return EXPLANATIONS[String(language||'en').toLowerCase().split(/[-_]/)[0]]||EXPLANATIONS.en;}
function linkMessage(code,language){const lang=String(language||'en').toLowerCase().split(/[-_]/)[0];return ({pt:'Opções atuais',es:'Opciones actuales'}[lang]||'Current options')+':\nhttps://www.mycarscout.net/o/'+code;}
async function call(ctx,name,args){
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/'+name,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(8000),body:JSON.stringify(args)});
}
const services={call,latestActiveUpload,linkFor,sendMessage,recordSent};
function enoughTime(deadlineAt){return !deadlineAt||deadlineAt-Date.now()>=10000;}
function failureCode(error){const code=String(error?.message||'');return /^D360_[A-Z0-9_]{3,80}$/.test(code)?code:'AUTO_OPTIONS_FAILED';}

// Only the live receiver calls this. Neither historical imports nor retries backfill sends.
async function maybeAutoOptions(ctx,rawId,item,result,options={},deps=services){
  if(!isEnabled()||String(process.env.AUTO_OPTIONS_ENABLED||'true').toLowerCase()==='false')return {sent:false,reason:'DISABLED'};
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production')return {sent:false,reason:'OUTSIDE_PRODUCTION'};
  if(result?.duplicate||result?.vitrineHandled||!result?.contactId||!result?.messageId||!result?.journeyId||item.direction!=='CUSTOMER'||item.eventField!=='messages'||item.source_kind!=='WHATSAPP_WEBHOOK')return {sent:false,reason:'NOT_LIVE_INBOUND'};
  if(!options.greeting?.sent&&options.greeting?.reason!=='RECENT_MESSAGE')return {sent:false,reason:'GREETING_NOT_READY'};
  const refs=explicitRefs(item.body),mode=messageMode(item.body);
  if(refs.length!==1||!mode||!isCalculatorTemplate(item.body))return {sent:false,reason:'NO_CALCULATOR_REF'};
  // An opt-out accompanied by a pasted calculator request must not trigger an offer.
  if(/\b(stop|unsubscribe|do not contact|don't contact|não me contate|nao me contate|no me contactes|cancelar)\b/i.test(item.body))return {sent:false,reason:'OPT_OUT'};
  const identity={p_environment:ctx.environment,p_contact:result.contactId,p_journey:result.journeyId,p_inbound_message:result.messageId,p_inbound_wamid:item.messageId,p_ref:refs[0],p_mode:mode,p_phone:item.phone||null,p_user_id:item.userId||null};
  let job=null;
  const advance=async(stage,wamid=null,error=null)=>{
    const changed=await deps.call(ctx,'panel_whatsapp_auto_options_advance',{p_environment:ctx.environment,p_job:job.id,p_stage:stage,p_wamid:wamid,p_error:error});
    if(!changed?.updated)throw Error('AUTO_OPTIONS_STATE_CONFLICT');
  };
  try{
    if(!enoughTime(options.deadlineAt))return {sent:false,reason:'DEADLINE'};
    const context=await deps.call(ctx,'panel_whatsapp_auto_options_context',identity);
    if(!context?.eligible)return {sent:false,reason:context?.reason||'NOT_ELIGIBLE'};
    const upload=await deps.latestActiveUpload(ctx);
    if(!upload)return {sent:false,reason:'NO_OPTIONS'};
    let available=false;
    for(const group of ['LANE','OFFLANE','INCOMPLETE']){
      if(!enoughTime(options.deadlineAt))return {sent:false,reason:'DEADLINE'};
      const page=await deps.call(ctx,'panel_manheim_offer_page',{p_environment:ctx.environment,p_upload_id:upload.id,p_demand_key:context.key,p_group:group,p_offset:0,p_limit:1});
      if((page||[]).some(row=>row?.id&&publicCar(row).estimatedMarketReference>0)){available=true;break;}
    }
    if(!available)return {sent:false,reason:'NO_OPTIONS'};
    if(!enoughTime(options.deadlineAt))return {sent:false,reason:'DEADLINE'};
    const code=await deps.linkFor(ctx,context.key,null);
    const link=linkMessage(code,context.language),body=explanation(context.language);
    const claim=await deps.call(ctx,'panel_whatsapp_auto_options_claim',{...identity,p_link:link,p_explanation:body});
    if(!claim?.claimed)return {sent:false,reason:claim?.reason||'NOT_ELIGIBLE'};
    job=claim;
    for(const [stage,sentStage,text] of [['LINK_SENDING','LINK_SENT',link],['EXPLANATION_SENDING','COMPLETE',body]]){
      if(!enoughTime(options.deadlineAt))throw Error('D360_DEADLINE');
      await advance(stage);
      const wamid=await deps.sendMessage(item,text,8000);
      // Store the provider id before recording the chat, so the DB trigger marks it automatic.
      await advance(sentStage,wamid);
      try{await deps.recordSent(ctx,rawId,item,wamid,text);}catch(_){await advance(sentStage,wamid,'PANEL_RECORD_FAILED');}
    }
    return {sent:true,jobId:job.id};
  }catch(error){
    const reason=failureCode(error);
    if(job)await advance('FAILED',null,reason).catch(()=>null);
    // No automatic retry after an uncertain provider response: never duplicate customer sends.
    console.error('[whatsapp-auto-options]',{reason,claimed:Boolean(job)});
    return {sent:false,reason};
  }
}
module.exports={EXPLANATIONS,explanation,linkMessage,maybeAutoOptions};

'use strict';
const {normalizePhone}=require('./panel-phone');
const {supabase}=require('./panel-server');

const AUTO_REPLY_TEXT=`We help you buy where dealers buy. Start here to estimate your total cost or tell us which car to find:

https://mycarscout.net/msc-calculadora.html`;

function isEnabled(){return String(process.env.AUTO_REPLY_ENABLED||'').trim().toLowerCase()==='true';}
function testNumbers(){return new Set(String(process.env.AUTO_REPLY_TEST_NUMBERS||'').split(',').map(normalizePhone).filter(Boolean));}
function errorCode(error){
  const text=String(error?.message||error||'');
  if(/^D360_[A-Z0-9_]{3,80}$/.test(text))return text;
  return 'AUTO_REPLY_FAILED';
}
async function finish(ctx,inboundId,status,sentId=null,code=null){
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_finish_auto_reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_inbound_wamid:inboundId,p_status:status,p_sent_wamid:sentId,p_error_code:code})});
}
async function sendMessage(item,body=AUTO_REPLY_TEXT,timeoutMs=null){
  // Preview e desenvolvimento na Vercel nunca chamam o 360dialog real.
  if(process.env.VERCEL_ENV&&process.env.VERCEL_ENV!=='production')throw Error('D360_BLOCKED_OUTSIDE_PRODUCTION');
  const key=process.env.D360_API_KEY;
  if(!key)throw Error('D360_KEY_MISSING');
  const target=item.phone?{to:item.phone.replace(/^\+/,'')}:item.userId?{recipient:item.userId}:null;
  if(!target)throw Error('D360_RECIPIENT_MISSING');
  let response;
  try{
    response=await fetch('https://waba-v2.360dialog.io/messages',{method:'POST',headers:{'content-type':'application/json','D360-API-KEY':key},...(timeoutMs?{signal:AbortSignal.timeout(timeoutMs)}:{}),body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',...target,type:'text',text:{body}})});
  }catch(_){throw Error('D360_NETWORK_ERROR');}
  if(!response.ok)throw Error('D360_HTTP_'+response.status);
  let payload;
  try{payload=await response.json();}catch(_){throw Error('D360_RESPONSE_INVALID');}
  const messageId=String(payload?.messages?.[0]?.id||'').trim();
  if(!messageId)throw Error('D360_RESPONSE_INVALID');
  // Cópia para o n8n do Rene, em segundo plano; nunca muda o envio.
  try{require('./whatsapp-forward').forwardOutbound({to:item.phone||item.userId,text:body,messageId});}catch(_){}
  return messageId;
}
async function recordSent(ctx,rawId,item,messageId,body=AUTO_REPLY_TEXT,timeoutMs=null){
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_apply_message',{method:'POST',headers:{'content-type':'application/json'},...(timeoutMs?{signal:AbortSignal.timeout(timeoutMs)}:{}),body:JSON.stringify({p_environment:ctx.environment,p_raw:rawId,p_item:{messageId,phone:item.phone||null,userId:item.userId||null,username:item.username||null,name:item.name||null,direction:'MCS',body,timestamp:String(Math.floor(Date.now()/1000)),refs:[],source_kind:'WHATSAPP_WEBHOOK'}})});
}
async function maybeAutoReply(ctx,rawId,item,result){
  if(result?.vitrineHandled)return {sent:false,reason:'VITRINE_INTEREST'};
  if(!result?.messageId||!result?.contactId||item.direction!=='CUSTOMER'||item.eventField!=='messages')return {sent:false,reason:'NOT_LIVE_INBOUND'};
  const normalized=normalizePhone(item.phone),isTest=Boolean(normalized&&testNumbers().has(normalized));
  if(!isEnabled()&&!isTest)return {sent:false,reason:'DISABLED'};
  // A calculator request is already the next step; never send that person back to the calculator.
  if(require('./panel-ref-proof').isCalculatorTemplate(item.body))return {sent:false,reason:'CALCULATOR_ALREADY_KNOWN'};
  try{
    const known=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_has_calculator_request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_contact:result.contactId})});
    if(known===true)return {sent:false,reason:'CALCULATOR_ALREADY_KNOWN'};
    if(known!==false)return {sent:false,reason:'CALCULATOR_CHECK_FAILED'};
  }catch(_){return {sent:false,reason:'CALCULATOR_CHECK_FAILED'};}
  let claim;
  try{
    claim=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_claim_auto_reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_contact:result.contactId,p_inbound_message:result.messageId,p_inbound_wamid:item.messageId,p_is_test:isTest})});
  }catch(_){return {sent:false,reason:'CLAIM_FAILED'};}
  if(!claim?.claimed)return {sent:false,reason:claim?.reason||'NOT_ELIGIBLE'};
  let sentId;
  try{sentId=await sendMessage(item);}catch(error){await finish(ctx,item.messageId,'FAILED',null,errorCode(error)).catch(()=>null);return {sent:false,reason:errorCode(error)};}
  await finish(ctx,item.messageId,'SENT',sentId,null).catch(()=>null);
  try{await recordSent(ctx,rawId,item,sentId);}catch(_){await finish(ctx,item.messageId,'SENT',sentId,'PANEL_RECORD_FAILED').catch(()=>null);return {sent:true,recorded:false,messageId:sentId};}
  return {sent:true,recorded:true,messageId:sentId};
}

module.exports={AUTO_REPLY_TEXT,isEnabled,testNumbers,sendMessage,maybeAutoReply,recordSent};

'use strict';
const {normalizePhone}=require('./panel-phone');
const {supabase}=require('./panel-server');

const AUTO_REPLY_TEXT=`Hi, this is an automatic message from My Car Scout
We've had a high volume of messages, so the key details come first. When our team joins the conversation, we start with the car you want and your numbers, not from scratch

1. We offer an auction buying service through dealer wholesale auctions, you choose the car and set your limit, we handle the purchase
2. These auctions are closed to the public. Through us, that door is open. No license or auction account needed
3. You buy where dealers buy, before the car ever reaches their lot. Different cars come in and go out every day. Every car has an auction date: once it sells, it's gone
4. Not buying this week? Your budget sets the target. We hunt the specific car when you're ready. The market refreshes daily, so we time it right
5. Before we bid, you see everything: photos, CARFAX, condition details, seller announcements. No test drive exists at auction, so every available fact reaches you first
6. To bid, we require a refundable deposit. It locks your max in place. We never bid above it. No purchase? You get it back, or it stays valid for your next search
7. Financing is also an option, subject to lender approval. Cars up to $7,000 are cash only

Reply YES and a real person will review what you're looking for. Demand is high, and a quick reply isn't always a good reply. We'll make your reply count.`;

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
async function sendMessage(item){
  const key=process.env.D360_API_KEY;
  if(!key)throw Error('D360_KEY_MISSING');
  const target=item.phone?{to:item.phone.replace(/^\+/,'')}:item.userId?{recipient:item.userId}:null;
  if(!target)throw Error('D360_RECIPIENT_MISSING');
  let response;
  try{
    response=await fetch('https://waba-v2.360dialog.io/messages',{method:'POST',headers:{'content-type':'application/json','D360-API-KEY':key},body:JSON.stringify({messaging_product:'whatsapp',recipient_type:'individual',...target,type:'text',text:{body:AUTO_REPLY_TEXT}})});
  }catch(_){throw Error('D360_NETWORK_ERROR');}
  if(!response.ok)throw Error('D360_HTTP_'+response.status);
  let payload;
  try{payload=await response.json();}catch(_){throw Error('D360_RESPONSE_INVALID');}
  const messageId=String(payload?.messages?.[0]?.id||'').trim();
  if(!messageId)throw Error('D360_RESPONSE_INVALID');
  return messageId;
}
async function recordSent(ctx,rawId,item,messageId){
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_apply_message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_raw:rawId,p_item:{messageId,phone:item.phone||null,userId:item.userId||null,username:item.username||null,name:item.name||null,direction:'MCS',body:AUTO_REPLY_TEXT,timestamp:String(Math.floor(Date.now()/1000)),refs:[],source_kind:'WHATSAPP_WEBHOOK'}})});
}
async function maybeAutoReply(ctx,rawId,item,result){
  if(!result?.messageId||!result?.contactId||item.direction!=='CUSTOMER'||item.eventField!=='messages')return {sent:false,reason:'NOT_LIVE_INBOUND'};
  const normalized=normalizePhone(item.phone),isTest=Boolean(normalized&&testNumbers().has(normalized));
  if(!isEnabled()&&!isTest)return {sent:false,reason:'DISABLED'};
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

'use strict';
const crypto=require('node:crypto');
const {waitUntil}=require('@vercel/functions');const {SERVER_ENVIRONMENT,configuration,jsonBody,send}=require('../../panel-server');
const {rawEvent,processRaw}=require('../../whatsapp-receiver');
const {sendCustomerMessagePushes}=require('../../panel-push');

// Within the function's 60 seconds (vercel.json): up to 25 s to store the event, 40 s of processing
// after the answer (+5 s to let the last write finish).
const LIMITS={rawEventMs:25000,processingMs:40000}; // tests shorten them
module.exports=async(req,res)=>{
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const expected=process.env.WHATSAPP_WEBHOOK_SECRET;
  const supplied=req.headers['x-mcs-webhook-secret'];
  if(!expected||typeof supplied!=='string'||Buffer.byteLength(supplied)>256||
     !crypto.timingSafeEqual(crypto.createHash('sha256').update(supplied).digest(),crypto.createHash('sha256').update(expected).digest()))
    return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||!SERVER_ENVIRONMENT)return send(res,503,{error:'RECEIVER_UNAVAILABLE'});
  try{
    if(Number(req.headers['content-length']||0)>3*1024*1024)return send(res,413,{error:'PAYLOAD_TOO_LARGE'});
    const payload=await jsonBody(req,3*1024*1024);
    if(!payload||typeof payload!=='object'||Array.isArray(payload))return send(res,400,{error:'PAYLOAD_INVALID'});
    const ctx={config,environment:SERVER_ENVIRONMENT};
    let row;
    // Durable before any acknowledgment. A slow database answers 503 in time (WhatsApp delivers again
    // later; a repeated event is ignored) instead of holding the request until the 60-second limit.
    try{row=await rawEvent(ctx,payload,{timeoutMs:LIMITS.rawEventMs});}
    catch(error){if(error?.name==='TimeoutError'||error?.name==='AbortError')return send(res,503,{error:'RECEIVER_BUSY'});throw error;}
    if(row){
      // The processing after the answer has its own deadline: what does not fit stays PENDING or
      // PROCESSING and the maintenance cron finishes it (it never sends anything).
      const task=processRaw(ctx,row,{live:true,deadlineAt:Date.now()+LIMITS.processingMs})
        .then((result)=>sendCustomerMessagePushes(ctx,result?.pushMessages||[]).catch(()=>null))
        .catch(()=>{}); // Status is persisted by processRaw; no message text in logs.
      const bounded=Promise.race([task,new Promise((resolve)=>{const timer=setTimeout(resolve,LIMITS.processingMs+5000);timer.unref?.();})]);
      (typeof req.waitUntil==='function'?req.waitUntil:waitUntil)(bounded);
    }
    return send(res,200,{received:true});
  }catch(error){
    return send(res,error.message==='PAYLOAD_TOO_LARGE'?413:500,{error:error.message==='PAYLOAD_TOO_LARGE'?'PAYLOAD_TOO_LARGE':'RECEIVER_UNAVAILABLE'});
  }
};
module.exports.LIMITS=LIMITS;

'use strict';
const crypto=require('node:crypto');
const {waitUntil}=require('@vercel/functions');
const {SERVER_ENVIRONMENT,configuration,jsonBody,send}=require('../../panel-server');
const {rawEvent,processRaw}=require('../../whatsapp-receiver');

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
    const row=await rawEvent(ctx,payload); // Durable before any acknowledgment.
    if(row){
      const task=processRaw(ctx,row).catch(()=>{}); // Status is persisted by processRaw; no message text in logs.
      (typeof req.waitUntil==='function'?req.waitUntil:waitUntil)(task);
    }
    return send(res,200,{received:true});
  }catch(error){
    return send(res,error.message==='PAYLOAD_TOO_LARGE'?413:500,{error:error.message==='PAYLOAD_TOO_LARGE'?'PAYLOAD_TOO_LARGE':'RECEIVER_UNAVAILABLE'});
  }
};

'use strict';
const {configuration,SERVER_ENVIRONMENT,jsonBody}=require('../../panel-server');
const {TOPIC,queueClient}=require('../../whatsapp-options-queue');
const {processOptionsTimer,recordOptionsProbe}=require('../../whatsapp-auto-options');

// queue/v2beta makes this function private to Vercel's queue infrastructure.
const callback=queueClient().handleNodeCallback(async(message,metadata)=>{
  if(metadata.topicName!==TOPIC||SERVER_ENVIRONMENT!=='production')return;
  const config=configuration();
  if(!config)throw Error('OPTIONS_TIMER_UNAVAILABLE');
  const ctx={config,environment:SERVER_ENVIRONMENT};
  if(message?.kind==='PROBE'){
    console.info('[whatsapp-options-probe]',{probeId:message.probeId,seconds:message.seconds,elapsedMs:Date.now()-message.requestedAt});
    await recordOptionsProbe(ctx,message);
    return;
  }
  await processOptionsTimer(ctx,message);
},{retry:(error)=>({afterSeconds:error?.afterSeconds||10})});
module.exports=async(req,res)=>{
  req.body=await jsonBody(req,16*1024);
  return callback(req,res);
};

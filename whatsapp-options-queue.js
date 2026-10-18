'use strict';
const TOPIC='mcs-whatsapp-options';
let client;
function queueClient(){
  if(!client)client=new (require('@vercel/queue').QueueClient)({region:'iad1'});
  return client;
}
async function queueTimer(jobId,step,dueAt,environment){
  const due=Date.parse(dueAt);
  if(!Number.isFinite(due)||!['LINK','EXPLANATION','DETAILS'].includes(step))throw Error('TIMER_INVALID');
  return queueClient().send(TOPIC,{jobId,step,environment},{
    delaySeconds:Math.max(0,Math.ceil((due-Date.now())/1000)),
    retentionSeconds:600,idempotencyKey:'auto-options:'+environment+':'+jobId+':'+step
  });
}
// Operational check exercises delayed delivery without a contact, job or WhatsApp call.
async function queueProbe(seconds,environment,options={}){
  if(![35,90].includes(seconds))throw Error('PROBE_INVALID');
  const probeId=options.probeId||require('node:crypto').randomUUID(),requestedAt=options.requestedAt||Date.now();
  const receipt=await queueClient().send(TOPIC,{kind:'PROBE',probeId,requestedAt,seconds,environment},{delaySeconds:seconds,retentionSeconds:180,idempotencyKey:'options-probe:'+probeId});
  return {probeId,seconds,requestedAt,messageId:receipt.messageId};
}
module.exports={TOPIC,queueClient,queueTimer,queueProbe};

'use strict';
const {supabase}=require('./panel-server');
const PIXEL='2308379543262592';
// This module receives only delivery metadata and an already hashed phone from
// the service-only database outbox. No conversation, vehicle, price or Ref.
function configuration(env=process.env){
  if(env.VERCEL_ENV!=='production'||env.META_RECEIVED_LEADS_ENABLED!=='true')return null;
  const since=Date.parse(env.META_RECEIVED_LEADS_SINCE||'');
  if(!Number.isFinite(since)||!env.META_CAPI_ACCESS_TOKEN||!/^v\d+\.0$/.test(env.META_GRAPH_VERSION||''))return null;
  return {token:env.META_CAPI_ACCESS_TOKEN,version:env.META_GRAPH_VERSION,since:new Date(since).toISOString()};
}
function eventFor(row,now=Date.now()){
  const time=Date.parse(row?.occurred_at),age=now-time;
  if(!/^[a-f0-9]{64}$/.test(row?.id||'')||!/^[a-f0-9]{64}$/.test(row?.phone_hash||'')||
    !Number.isFinite(time)||age<0||age>=7*86400000||!['VALOR','CARRO'].includes(row?.logical_mode)||!['WHATSAPP','SMS'].includes(row?.channel))return null;
  return {event_name:'Lead',event_time:Math.floor(time/1000),event_id:'mcs_received_'+row.id,
    action_source:'chat',user_data:{ph:[row.phone_hash]},custom_data:{logical_mode:row.logical_mode,channel:row.channel}};
}
async function rpc(ctx,name,args){return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/'+name,{
  method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(8000),body:JSON.stringify(args)});}
async function deliver(event,config,fetcher=fetch){
  // The token is a header: it is never embedded in a URL or logged.
  const response=await fetcher('https://graph.facebook.com/'+config.version+'/'+PIXEL+'/events',{
    method:'POST',headers:{authorization:'Bearer '+config.token,'content-type':'application/json'},
    signal:AbortSignal.timeout(8000),body:JSON.stringify({data:[event]})});
  const body=await response.json().catch(()=>null);
  return {accepted:response.ok&&body?.events_received===1,code:response.ok?'META_NOT_ACCEPTED':'META_HTTP_'+response.status};
}
async function processReceivedLeads(ctx,{deadlineAt=Date.now()+22000}={},deps={rpc,deliver,configuration}){
  const config=deps.configuration();
  if(!config||ctx.environment!=='production')return {disabled:true};
  const jobs=await deps.rpc(ctx,'mcs_meta_received_claim',{p_since:config.since,p_limit:10});
  let accepted=0,failed=0;
  for(const row of jobs||[]){
    if(Date.now()+9000>deadlineAt)break; // unprocessed leases become available again
    const event=eventFor(row);
    let result={accepted:false,code:'INVALID_EVENT'};
    if(event){try{result=await deps.deliver(event,config);}catch(_){result={accepted:false,code:'META_UNAVAILABLE'};}}
    await deps.rpc(ctx,'mcs_meta_received_finish',{p_id:row.id,p_claim:row.claim_id,p_accepted:result.accepted,p_error:result.accepted?null:result.code});
    if(result.accepted)accepted++;else failed++;
  }
  return {claimed:(jobs||[]).length,accepted,failed};
}
module.exports={PIXEL,configuration,eventFor,deliver,processReceivedLeads};

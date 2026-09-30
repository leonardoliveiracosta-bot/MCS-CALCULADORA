'use strict';

const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {runCron}=require('../../panel-ai');
const {generalBatch,generalStatus}=require('../../panel-pendencias');
const {runCaptureCheck,recordCaptureFailure}=require('../../panel-capture');
const {recoverStalledEvents,resolveStoredItemErrors}=require('../../whatsapp-maintenance');

function equalSecret(actual,expected){
  const left=Buffer.from(String(actual||'')),right=Buffer.from(String(expected||''));
  return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);
}

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  const startedAt=Date.now();
  try{
    const ctx={config,environment:SERVER_ENVIRONMENT};
    let whatsappMaintenance={done:0,reprocessed:0,deferred:0,failed:0};
    try{
      // Up to 5 interrupted events per cycle, never past 20 seconds (it used to be one per cycle).
      whatsappMaintenance=await recoverStalledEvents(ctx,{maxEvents:5,deadlineAt:Date.now()+20000});
      await resolveStoredItemErrors(ctx);
    }catch(error){console.error('[whatsapp-maintenance]',{operation:'cron',message:String(error?.message||'UNKNOWN')});}
    // A resumable full reading has priority only while it is actively running.
    // Paused, budget-limited, completed, and idle runs must not stop the normal
    // day-to-day analysis cycle.
    const state=await generalStatus(ctx);
    const active=state?.run?.status==='ACTIVE';
    const pending=active
      ? await generalBatch(ctx).catch((error)=>({error:error.message==='AI_UNAVAILABLE'?'AI_UNAVAILABLE':'PENDING_FAILED'}))
      : state;
    const result=active
      ? {processed:0,readings:0,suggestions:0,errors:0,limited:false}
      : await runCron(ctx);
    let capture;
    try { capture=await runCaptureCheck(ctx); }
    catch (error) { capture={error:'CAPTURE_CHECK_FAILED'}; await recordCaptureFailure(ctx,error.message).catch(()=>{}); }
    // As leituras da OpenAI (conferência do Manheim, PESQUISAS e triagem da ENTRADA) rodam no
    // openai-cron, com a janela inteira só para elas; este cron fica com o Claude e a manutenção.
    return send(res,200,{...result,pending,capture,whatsappMaintenance});
  }catch(error){
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[panel-ai-cron]',{requestId,route:'/api/panel/ai-cron',message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});
    return send(res,503,{error:'AI_UNAVAILABLE',requestId});
  }
};

module.exports.equalSecret=equalSecret;

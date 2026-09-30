'use strict';
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {cleanupMcsMedia,enqueueRecentMedia,processMediaJobs,recoverMediaJobs}=require('../../whatsapp-media');
const RECENT_MS=2*3600000;
function equalSecret(actual,expected){const left=Buffer.from(String(actual||'')),right=Buffer.from(String(expected||''));return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);}
module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  // Every minute: the recent hours only. The 30-day safety net and the MCS media cleanup (full reads)
  // run every half hour: on 29/09, with the database overloaded, the per-minute full reads went past
  // the 60-second limit and piled up on the next run.
  try{const started=Date.now(),ctx={config,environment:SERVER_ENVIRONMENT},full=new Date(started).getUTCMinutes()%30===0;await recoverMediaJobs(ctx);const cleaned=full?await cleanupMcsMedia(ctx):{skipped:true},queued=await enqueueRecentMedia(ctx,full?{maxEvents:1000,deadlineAt:started+22000}:{maxEvents:200,sinceMs:RECENT_MS,deadlineAt:started+22000}),processed=await processMediaJobs(ctx,{maxJobs:20,deadlineAt:started+50000});return send(res,200,{full,cleaned,queued,processed});}
  catch(error){const requestId=crypto.randomUUID().slice(0,8);console.error('[whatsapp-media]',{operation:'cron',requestId,message:String(error?.message||'UNKNOWN')});return send(res,503,{error:'MEDIA_MAINTENANCE_FAILED',requestId});}
};
module.exports.equalSecret=equalSecret;

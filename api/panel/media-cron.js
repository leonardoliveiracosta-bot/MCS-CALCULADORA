'use strict';
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {enqueueRecentMedia,processMediaJobs,recoverMediaJobs}=require('../../whatsapp-media');
function equalSecret(actual,expected){const left=Buffer.from(String(actual||'')),right=Buffer.from(String(expected||''));return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);}
module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  try{const started=Date.now(),ctx={config,environment:SERVER_ENVIRONMENT};await recoverMediaJobs(ctx);const queued=await enqueueRecentMedia(ctx,{maxEvents:1000,deadlineAt:started+12000}),processed=await processMediaJobs(ctx,{maxJobs:8,deadlineAt:started+48000});return send(res,200,{queued,processed});}
  catch(error){const requestId=crypto.randomUUID().slice(0,8);console.error('[whatsapp-media]',{operation:'cron',requestId,message:String(error?.message||'UNKNOWN')});return send(res,503,{error:'MEDIA_MAINTENANCE_FAILED',requestId});}
};
module.exports.equalSecret=equalSecret;

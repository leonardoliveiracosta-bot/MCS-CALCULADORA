'use strict';

const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {runCron}=require('../../panel-ai');
const {generalBatch}=require('../../panel-pendencias');

function equalSecret(actual,expected){
  const left=Buffer.from(String(actual||'')),right=Buffer.from(String(expected||''));
  return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);
}

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  try{
    const ctx={config,environment:SERVER_ENVIRONMENT};
    // A resumable full reading has priority while active. Its database lease makes
    // this safe if Vercel retries a cron invocation.
    const pending=await generalBatch(ctx).catch((error)=>({error:error.message==='AI_UNAVAILABLE'?'AI_UNAVAILABLE':'PENDING_FAILED'}));
    const result=pending.status==='ACTIVE'||pending.status==='PAUSED'||pending.status==='LIMIT'
      ? {processed:0,readings:0,suggestions:0,errors:0,limited:false}
      : await runCron(ctx);
    return send(res,200,{...result,pending});
  }catch(_){return send(res,503,{error:'AI_UNAVAILABLE'});}
};

module.exports.equalSecret=equalSecret;

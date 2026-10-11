'use strict';
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {equalSecret}=require('../panel/media-cron');
const {recoverOptionsTimers}=require('../../whatsapp-auto-options');
module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  try{
    return send(res,200,await recoverOptionsTimers({config,environment:SERVER_ENVIRONMENT}));
  }
  catch(_){console.error('[whatsapp-auto-options]',{reason:'TIMER_RECOVERY_FAILED'});return send(res,503,{error:'TIMER_RECOVERY_FAILED'});}
};

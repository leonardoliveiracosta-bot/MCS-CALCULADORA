'use strict';
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {processReceivedLeads}=require('../../meta-received-leads');
module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const wanted='Bearer '+String(process.env.CRON_SECRET||'');
  const actual=String(req.headers?.authorization||'');
  if(!process.env.CRON_SECRET||Buffer.byteLength(actual)!==Buffer.byteLength(wanted)||!crypto.timingSafeEqual(Buffer.from(actual),Buffer.from(wanted)))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'UNAVAILABLE'});
  try{return send(res,200,await processReceivedLeads({config,environment:SERVER_ENVIRONMENT}));}
  catch(_){return send(res,503,{error:'MEASUREMENT_UNAVAILABLE'});}
};

'use strict';
const {SERVER_ENVIRONMENT,configuration,supabase,send,isUuid}=require('../panel-server');
const {verifiedRef,PARTNER_URL}=require('../finance-handoff-server');
module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const config=configuration();if(!config)return send(res,503,{error:'FINANCE_UNAVAILABLE'});
  const ref=verifiedRef(req,config.secretKey,SERVER_ENVIRONMENT);
  if(!ref)return send(res,200,{authorized:false});
  try{
    const runs=await supabase(config.url,config.secretKey,'/rest/v1/calc_runs?select=id,dados&dados->>ref=eq.'+ref+'&dados->>tipo=eq.finance&is_test=eq.'+(SERVER_ENVIRONMENT!=='production')+'&limit=2');
    if(!Array.isArray(runs)||runs.length!==1||!isUuid(runs[0].id))return send(res,200,{authorized:false});
    const contacts=await supabase(config.url,config.secretKey,'/rest/v1/site_contact_requests?select=id&request_key=eq.'+runs[0].id+'&environment=eq.'+SERVER_ENVIRONMENT+'&source=eq.finance&consent_version=eq.finance-contact-v1&limit=1');
    if(!contacts?.length)return send(res,200,{authorized:false});
    return send(res,200,{authorized:true,destination:PARTNER_URL});
  }catch(_){return send(res,503,{error:'FINANCE_UNAVAILABLE'});}
};

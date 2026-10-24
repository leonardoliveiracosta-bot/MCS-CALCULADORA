'use strict';
const {SERVER_ENVIRONMENT,configuration,supabase,send,isUuid,jsonBody}=require('../panel-server');
const {verifiedRef,PARTNER_URL}=require('../finance-handoff-server');
const {originAllowed}=require('./contact-request');
module.exports=async(req,res)=>{
  if(!['GET','POST'].includes(req.method))return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const departing=req.method==='POST';
  if(departing&&(!originAllowed(req)||!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||'')))return send(res,403,{error:'REQUEST_NOT_ALLOWED'});
  const config=configuration();if(!config)return send(res,503,{error:'FINANCE_UNAVAILABLE'});
  const ref=verifiedRef(req,config.secretKey,SERVER_ENVIRONMENT);
  if(!ref)return send(res,departing?403:200,{authorized:false});
  try{
    let method;
    if(departing){const body=await jsonBody(req,512);if(!['manual','automatic'].includes(body?.method))return send(res,400,{error:'FINANCE_INVALID'});method=body.method;}
    const runs=await supabase(config.url,config.secretKey,'/rest/v1/calc_runs?select=id,dados&dados->>ref=eq.'+ref+'&dados->>tipo=eq.finance&is_test=eq.'+(SERVER_ENVIRONMENT!=='production')+'&limit=2');
    if(!Array.isArray(runs)||runs.length!==1||!isUuid(runs[0].id))return send(res,departing?403:200,{authorized:false});
    const contacts=await supabase(config.url,config.secretKey,'/rest/v1/site_contact_requests?select=id&request_key=eq.'+runs[0].id+'&environment=eq.'+SERVER_ENVIRONMENT+'&source=eq.finance&consent_version=eq.finance-contact-v1&limit=1');
    if(!contacts?.length)return send(res,departing?403:200,{authorized:false});
    if(departing){
      const handoff=await supabase(config.url,config.secretKey,'/rest/v1/rpc/mcs_finance_partner_handoff',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:SERVER_ENVIRONMENT,p_request_key:runs[0].id,p_method:method})});
      if(!handoff?.at||!Number.isFinite(Date.parse(handoff.at)))throw Error('HANDOFF_FAILED');
      return send(res,200,{authorized:true,destination:PARTNER_URL,handedOffAt:handoff.at});
    }
    return send(res,200,{authorized:true,destination:PARTNER_URL});
  }catch(error){if(error instanceof SyntaxError||error.message==='PAYLOAD_TOO_LARGE')return send(res,400,{error:'FINANCE_INVALID'});return send(res,503,{error:'FINANCE_UNAVAILABLE'});}
};

'use strict';
const crypto=require('node:crypto');
const {isIP}=require('node:net');
const model=require('../finance-model');
const contactModel=require('../finance-contact');
const {SERVER_ENVIRONMENT,configuration,jsonBody,isUuid,supabase,send}=require('../panel-server');
const {originAllowed}=require('./contact-request');
const {grantCookie}=require('../finance-handoff-server');
function inputOf(body){if(!body||!isUuid(body.requestId)||!['en','es','pt'].includes(body.language)||!model.valid(body.answers))return null;const contact=contactModel.normalize(body.contact);if(!contact)return null;return {requestId:body.requestId,language:body.language,contact,answers:Object.fromEntries(model.fields.map(key=>[key,body.answers[key]]))};}
module.exports=async(req,res)=>{
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!originAllowed(req)||!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||''))return send(res,403,{error:'REQUEST_NOT_ALLOWED'});
  const config=configuration();if(!config)return send(res,503,{error:'FINANCE_UNAVAILABLE'});
  try{
    const input=inputOf(await jsonBody(req,4096));if(!input)return send(res,400,{error:'FINANCE_INVALID'});
    const candidate=String(req.headers?.['x-vercel-forwarded-for']||req.headers?.['x-forwarded-for']||req.socket?.remoteAddress||'').split(',').at(-1).trim();
    const ipHash=crypto.createHmac('sha256',config.secretKey).update(isIP(candidate)?candidate:'unknown').digest('hex');
    const result=await supabase(config.url,config.secretKey,'/rest/v1/rpc/mcs_finance_contact_create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:SERVER_ENVIRONMENT,p_request_key:input.requestId,p_name:input.contact.name,p_phone:input.contact.phone,p_language:input.language,p_answers:input.answers,p_ip_hash:ipHash})});
    if(!result||!/^[A-HJ-NP-Z2-9]{5}$/.test(result.ref))throw Error('SAVE_FAILED');
    res.setHeader('Set-Cookie',grantCookie(req,config.secretKey,SERVER_ENVIRONMENT,result.ref));
    return send(res,200,{ok:true,ref:result.ref});
  }catch(error){
    if(error.code==='FINANCE_RATE_LIMIT')return send(res,429,{error:'FINANCE_RATE_LIMIT'});
    if(error.code==='FINANCE_KEY_CONFLICT')return send(res,409,{error:'FINANCE_KEY_CONFLICT'});
    if(error.code==='FINANCE_INVALID'||error instanceof SyntaxError||error.message==='PAYLOAD_TOO_LARGE')return send(res,400,{error:'FINANCE_INVALID'});
    return send(res,503,{error:'FINANCE_UNAVAILABLE'});
  }
};
module.exports.inputOf=inputOf;

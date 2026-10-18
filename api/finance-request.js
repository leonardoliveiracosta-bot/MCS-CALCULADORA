'use strict';
const crypto=require('node:crypto');
const model=require('../finance-model');
const {SERVER_ENVIRONMENT,configuration,jsonBody,isUuid,supabase,send}=require('../panel-server');
const {originAllowed}=require('./contact-request');
function inputOf(body){if(!body||!isUuid(body.requestId)||!['en','es','pt'].includes(body.language)||!model.valid(body.answers))return null;return {requestId:body.requestId,language:body.language,answers:Object.fromEntries(model.fields.map(key=>[key,body.answers[key]]))};}
function same(row,input){return row&&row.dados?.tipo==='finance'&&row.idioma===input.language&&model.fields.every(key=>row.dados.finance?.[key]===input.answers[key]);}
function reference(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';return Array.from({length:5},()=>alphabet[crypto.randomInt(alphabet.length)]).join('');}
module.exports=async(req,res)=>{
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!originAllowed(req)||!/^application\/json(?:\s*;|$)/i.test(req.headers?.['content-type']||''))return send(res,403,{error:'REQUEST_NOT_ALLOWED'});
  const config=configuration();if(!config)return send(res,503,{error:'FINANCE_UNAVAILABLE'});
  try{
    const input=inputOf(await jsonBody(req,2048));if(!input)return send(res,400,{error:'FINANCE_INVALID'});
    const path='/rest/v1/calc_runs',select='select=id,idioma,dados,is_test';
    const existing=await supabase(config.url,config.secretKey,path+'?'+select+'&id=eq.'+input.requestId);
    if(existing?.length){if(!same(existing[0],input)||existing[0].is_test!==(SERVER_ENVIRONMENT!=='production'))return send(res,409,{error:'FINANCE_KEY_CONFLICT'});return send(res,200,{ok:true,ref:existing[0].dados.ref});}
    let ref,available=false;for(let i=0;i<8;i++){ref=reference();const found=await supabase(config.url,config.secretKey,path+'?select=id&dados->>ref=eq.'+ref+'&limit=1');if(!found?.length){available=true;break;}}
    if(!available)throw Error('REF_UNAVAILABLE');
    const row={id:input.requestId,pagamento:'fin',idioma:input.language,origem:'finance',is_test:SERVER_ENVIRONMENT!=='production',dados:{sid:'finance-'+input.requestId,ref:ref,tipo:'finance',evento:'whatsapp',canal:'whatsapp',quando:new Date().toISOString(),finance:input.answers}};
    const inserted=await supabase(config.url,config.secretKey,path+'?on_conflict=id',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify(row)});
    const saved=inserted?.[0]||(await supabase(config.url,config.secretKey,path+'?'+select+'&id=eq.'+input.requestId))?.[0];
    if(!same(saved,input))return send(res,409,{error:'FINANCE_KEY_CONFLICT'});
    return send(res,200,{ok:true,ref:saved.dados.ref});
  }catch(error){return send(res,error instanceof SyntaxError||error.message==='PAYLOAD_TOO_LARGE'?400:503,{error:'FINANCE_UNAVAILABLE'});}
};
module.exports.inputOf=inputOf;

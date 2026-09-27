'use strict';
const { requirePanel, jsonBody, allRows, supabase, send } = require('../../panel-server');
const normalized=(value)=>String(value||'').trim().replace(/\s+/g,' ').toLocaleLowerCase('en-US');
module.exports=async(req,res)=>{
 const ctx=await requirePanel(req,res);if(!ctx)return;
 if(req.method==='GET')return send(res,200,{items:await allRows(ctx,'panel_automatic_messages',{select:'id,body_normalized,enabled,created_at',environment:'eq.'+ctx.environment,order:'created_at.asc'})});
 if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
 const body=await jsonBody(req);
 try{
  if(body.action==='save'){const text=normalized(body.text);if(!text||text.length>25000)return send(res,400,{error:'AUTOMATIC_TEXT_INVALID'});await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/panel_automatic_messages?on_conflict=environment,body_normalized',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({environment:ctx.environment,body_normalized:text,enabled:true})});}
  else if(body.action==='delete'&&/^[0-9a-f-]{36}$/i.test(String(body.id||'')))await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/panel_automatic_messages?id=eq.'+body.id+'&environment=eq.'+ctx.environment,{method:'DELETE',headers:{prefer:'return=minimal'}});
  else return send(res,400,{error:'AUTOMATIC_ACTION_INVALID'});
  return send(res,200,{ok:true});
 }catch(_){return send(res,500,{error:'AUTOMATIC_MESSAGES_FAILED'});}
};

'use strict';
const { requirePanel, jsonBody, isUuid, supabase, send } = require('../../panel-server');

module.exports = async (req,res) => {
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const ctx=await requirePanel(req,res);if(!ctx)return;
  const body=await jsonBody(req);if(!isUuid(body.messageId)||typeof body.automatic!=='boolean')return send(res,400,{error:'MESSAGE_AUTOMATIC_INVALID'});
  try{
    const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_set_message_automatic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_message:body.messageId,p_automatic:body.automatic})});
    return send(res,200,result||{updated:true});
  }catch(_){return send(res,409,{error:'MESSAGE_AUTOMATIC_FAILED'});}
};

'use strict';
const { requirePanel,jsonBody,send }=require('../../panel-server');
const vendedor=require('../../panel-vendedor');
module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{const {status,...out}=await vendedor.handle(ctx,await jsonBody(req,512*1024));return send(res,status,out);}
  catch(_){return send(res,503,{error:'AI_UNAVAILABLE'});}
};

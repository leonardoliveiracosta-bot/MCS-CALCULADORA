'use strict';

// Claude dentro do painel, sem ninguém abrir uma aba: lê as conversas novas ou alteradas (assunto e Refs
// escritas) em lotes retomáveis. Mesmo segredo e mesma regra do ai-cron; o saldo pré-pago do Claude e as
// reservas continuam sendo os de sempre (nada aqui muda o consumo permitido).
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {classifyConversations}=require('../../panel-subject');
const {reconcileIdentity}=require('../../panel-identity');
const {equalSecret}=require('./ai-cron');

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  try{
    const ctx={config,environment:SERVER_ENVIRONMENT};
    const startedAt=Date.now();
    const subjects=await classifyConversations(ctx,{max:15,concurrency:3,deadlineAt:startedAt+38000});
    // A Ref the Claude found and the rule verified is applied right away (the same proofs and limits as always).
    const identity=subjects.verifiedRefs>0?await reconcileIdentity(ctx,{max:150,deadlineAt:startedAt+52000}).catch(()=>({error:'IDENTITY_RECONCILE_FAILED'})):null;
    return send(res,200,{subjects,identity});
  }catch(error){
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[panel-subject-cron]',{requestId,message:String(error?.message||'UNKNOWN')});
    return send(res,503,{error:'AI_UNAVAILABLE',requestId});
  }
};

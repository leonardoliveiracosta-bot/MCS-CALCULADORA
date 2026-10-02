'use strict';

// Claude dentro do painel, sem ninguém abrir uma aba. Um ciclo só, com um prazo único (a função morre aos 60 s):
//  0. destino de toda mensagem da calculadora (Ref -> telefone -> ficha nova -> fila; determinístico e sem custo);
//  1. prints de SMS guardados e não salvos (relê o que falhou por motivo passageiro, salva o que a Ref prova);
//  2. identidade por Ref de todas as fichas (determinística e sem custo);
//  3. leitura do Claude das conversas novas ou alteradas (assunto e Refs escritas), só com o prazo que sobrar.
// Mesmo segredo e mesma regra do ai-cron; o saldo pré-pago do Claude e as reservas são os de sempre.
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {classifyConversations}=require('../../panel-subject');
const {reconcileIdentity}=require('../../panel-identity');
const {resumePrints}=require('../../panel-print-resume');
const {equalSecret}=require('./ai-cron');
const {routeCalculatorMessages}=require('../../panel-calc-route');

const CYCLE_MS=45000;

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  const startedAt=Date.now(),deadlineAt=startedAt+CYCLE_MS;
  const left=()=>deadlineAt-Date.now();
  const ctx={config,environment:SERVER_ENVIRONMENT};
  const guarded=async(name,work)=>{try{return await work();}catch(error){console.error('['+name+']',{message:String(error?.message||'UNKNOWN')});return {error:name.toUpperCase()+'_FAILED'};}};
  try{
    // No stage starts a paid or long piece of work it cannot finish before the cycle deadline.
    const calculator=await guarded('calc-route',()=>routeCalculatorMessages(ctx,{max:60,deadlineAt:Date.now()+Math.min(8000,left()-30000)}));
    const prints=left()>20000?await guarded('print-resume',()=>resumePrints(ctx,{max:3,deadlineAt:Date.now()+Math.min(14000,left()-18000)})):{skipped:true};
    const identity=left()>12000?await guarded('identity',()=>reconcileIdentity(ctx,{max:120,deadlineAt:Date.now()+Math.min(9000,left()-8000)})):{skipped:true};
    const subjects=left()>12000?await guarded('subject',()=>classifyConversations(ctx,{max:12,concurrency:3,deadlineAt:Date.now()+left()-10000})):{skipped:true};
    return send(res,200,{calculator,prints,identity,subjects,tookMs:Date.now()-startedAt});
  }catch(error){
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[panel-subject-cron]',{requestId,message:String(error?.message||'UNKNOWN')});
    return send(res,503,{error:'AI_UNAVAILABLE',requestId});
  }
};

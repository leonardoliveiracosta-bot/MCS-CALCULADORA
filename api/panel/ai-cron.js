'use strict';

const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {runCron}=require('../../panel-ai');
const {generalBatch,generalStatus}=require('../../panel-pendencias');
const {runCaptureCheck,recordCaptureFailure}=require('../../panel-capture');
const {recoverStalledEvents,resolveStoredItemErrors}=require('../../whatsapp-maintenance');
const {runTriage}=require('../../panel-triage');
const manheimAudit=require('../../panel-manheim-audit');
const {manheimView}=require('../../panel-buscas-view');
const searchRequestsModule=require('../../panel-search-requests');
const pesquisas=require('./pesquisas');

function equalSecret(actual,expected){
  const left=Buffer.from(String(actual||'')),right=Buffer.from(String(expected||''));
  return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);
}

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  const startedAt=Date.now();
  try{
    const ctx={config,environment:SERVER_ENVIRONMENT};
    let whatsappMaintenance={done:0,reprocessed:0,deferred:0,failed:0};
    try{
      // Up to 5 interrupted events per cycle, never past 20 seconds (it used to be one per cycle).
      whatsappMaintenance=await recoverStalledEvents(ctx,{maxEvents:5,deadlineAt:Date.now()+20000});
      await resolveStoredItemErrors(ctx);
    }catch(error){console.error('[whatsapp-maintenance]',{operation:'cron',message:String(error?.message||'UNKNOWN')});}
    // A resumable full reading has priority only while it is actively running.
    // Paused, budget-limited, completed, and idle runs must not stop the normal
    // day-to-day analysis cycle.
    const state=await generalStatus(ctx);
    const active=state?.run?.status==='ACTIVE';
    const pending=active
      ? await generalBatch(ctx).catch((error)=>({error:error.message==='AI_UNAVAILABLE'?'AI_UNAVAILABLE':'PENDING_FAILED'}))
      : state;
    const result=active
      ? {processed:0,readings:0,suggestions:0,errors:0,limited:false}
      : await runCron(ctx);
    let capture;
    try { capture=await runCaptureCheck(ctx); }
    catch (error) { capture={error:'CAPTURE_CHECK_FAILED'}; await recordCaptureFailure(ctx,error.message).catch(()=>{}); }
    // Ordem: a conferência do Manheim primeiro (sem ela V1/V2 ficam presas), depois PESQUISAS e,
    // com o tempo que sobra, a triagem da ENTRADA (cada uma respeita o próprio prazo).
    // Conferência dos matches do Manheim: segurança do disparo feito logo depois do upload.
    let matchAudit;
    // Only with time left: the BUSCAS base is a large read; the next cron picks it up otherwise.
    try { matchAudit=manheimAudit.status()!=='LIGADA'?{skipped:manheimAudit.status()}:Date.now()>startedAt+30000?{skipped:'SEM_TEMPO'}:await manheimAudit.runAudit(ctx,await manheimView(ctx,{auditInput:true}),{deadlineAt:startedAt+45000}); }
    catch (error) { matchAudit={error:'AUDIT_FAILED'};console.error('[manheim-audit]',{message:String(error?.code||error?.message||'UNKNOWN')}); }
    // PESQUISAS (OpenAI): lê conversas novas ou com mensagem nova desde a última leitura, até 5 por
    // ciclo, dentro do teto do provedor. Conteúdo já lido não é relido (mesmo hash não paga de novo).
    // Só classifica e organiza pedidos; nunca responde ao cliente.
    let searchRequests;
    try { searchRequests=searchRequestsModule.extractionStatus()!=='LIGADA'?{skipped:searchRequestsModule.extractionStatus()}:Date.now()>startedAt+47000?{skipped:'SEM_TEMPO'}:await pesquisas.extractHistory(ctx,5,{deadlineAt:startedAt+52000}); }
    catch (error) { searchRequests={error:'SEARCH_REQUESTS_FAILED'};console.error('[pesquisas-cron]',{message:String(error?.code||error?.message||'UNKNOWN')}); }
    // Triagem da ENTRADA (OpenAI): só com ENTRADA_OPENAI_ENABLED=1; falha nunca derruba o cron.
    let triage;
    try { triage=await runTriage(ctx,{deadlineAt:startedAt+55000}); }
    catch (error) { triage={error:'TRIAGE_FAILED'};console.error('[panel-triage]',{message:String(error?.code||error?.message||'UNKNOWN')}); }
    return send(res,200,{...result,pending,capture,whatsappMaintenance,triage,searchRequests,matchAudit});
  }catch(error){
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[panel-ai-cron]',{requestId,route:'/api/panel/ai-cron',message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});
    return send(res,503,{error:'AI_UNAVAILABLE',requestId});
  }
};

module.exports.equalSecret=equalSecret;

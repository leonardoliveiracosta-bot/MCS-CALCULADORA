'use strict';

// Leituras da OpenAI a cada 5 minutos, com a janela da função só para elas (o ai-cron fica com
// o Claude e a manutenção do WhatsApp). Ordem:
//  1. Ao mesmo tempo: conferência dos matches do Manheim (sem ela, V1/V2 de um pedido não
//     conferido ficam presas) e PESQUISAS (conversas novas ou com mensagem nova, quem escreveu por
//     último primeiro, sem limite de quantidade: só a janela do ciclo e o teto da OpenAI).
//  2. Triagem da ENTRADA com o tempo que sobra.
// Cada uma respeita a própria flag, o teste mínimo do modelo e o teto de US$ 50 da OpenAI.
// Só classificam e organizam: nada é enviado nem respondido ao cliente.
const crypto=require('node:crypto');
const {configuration,SERVER_ENVIRONMENT,send}=require('../../panel-server');
const {runTriage}=require('../../panel-triage');
const manheimAudit=require('../../panel-manheim-audit');
const {manheimView}=require('../../panel-buscas-view');
const searchRequests=require('../../panel-search-requests');
const pesquisas=require('./pesquisas');

function equalSecret(actual,expected){
  const left=Buffer.from(String(actual||'')),right=Buffer.from(String(expected||''));
  return left.length===right.length&&left.length>0&&crypto.timingSafeEqual(left,right);
}
const failed=(tag,code)=>(error)=>{console.error(tag,{message:String(error?.code||error?.message||'UNKNOWN')});return {error:code};};

module.exports=async(req,res)=>{
  if(req.method!=='GET')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  if(!process.env.CRON_SECRET)return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  if(!equalSecret(req.headers?.authorization,'Bearer '+process.env.CRON_SECRET))return send(res,401,{error:'UNAUTHORIZED'});
  const config=configuration();
  if(!config||SERVER_ENVIRONMENT!=='production')return send(res,503,{error:'CRON_NOT_CONFIGURED'});
  const startedAt=Date.now();
  const ctx={config,environment:SERVER_ENVIRONMENT};
  const [matchAudit,reading]=await Promise.all([
    manheimAudit.status()!=='LIGADA'?{skipped:manheimAudit.status()}
      :manheimView(ctx,{auditInput:true}).then((view)=>manheimAudit.runAudit(ctx,view,{deadlineAt:startedAt+57000})).catch(failed('[manheim-audit]','AUDIT_FAILED')),
    searchRequests.extractionStatus()!=='LIGADA'?{skipped:searchRequests.extractionStatus()}
      :pesquisas.extractHistory(ctx,Infinity,{deadlineAt:startedAt+50000,concurrency:4}).catch(failed('[pesquisas-cron]','SEARCH_REQUESTS_FAILED'))
  ]);
  const triage=await runTriage(ctx,{deadlineAt:startedAt+57000}).catch(failed('[panel-triage]','TRIAGE_FAILED'));
  return send(res,200,{matchAudit,searchRequests:reading,triage});
};

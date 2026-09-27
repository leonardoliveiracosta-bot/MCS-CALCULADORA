'use strict';

const { isUuid, jsonBody, requirePanel, send, supabase } = require('../../panel-server');
const { generalBatch, generalStatus, pendingSnapshot, resolvePending, unresolvePending, sortPending, startGeneralRead } = require('../../panel-pendencias');
const { decorateWithSearchStage, loadSearchStageIndex } = require('../../panel-search-stage');

function csvCell(value) { const text=String(value ?? '');return /[",\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text; }
function sheet(items) {
  const header=['nome','telefone','Ref','situação','dias parado','última mensagem','tradução','resumo','próximo passo'];
  const text=[header.join(',')];
  for(const item of items)text.push([item.name,item.phone||'',item.ref||'',item.situation,item.daysStalled,item.latestMessage,item.translation,item.summary,item.nextStep].map(csvCell).join(','));
  return text.join('\r\n');
}
function visible(snapshot, query) {
  const situation=String(query.situation||'all'),withRef=String(query.withRef||'')==='true',items=snapshot.items.filter((item)=>!item.resolved).filter((item)=>situation==='all'||item.situation===situation).filter((item)=>!withRef||Boolean(item.ref));
  return sortPending(items,String(query.sort||'hot'));
}

module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  try{
    if(req.method==='GET'){
      const snapshot=await pendingSnapshot(ctx),items=visible(snapshot,req.query||{});
      if(String(req.query?.download||'')==='csv'){
        res.setHeader('Cache-Control','no-store, max-age=0');res.setHeader('X-Robots-Tag','noindex, nofollow');res.setHeader('Content-Type','text/csv; charset=utf-8');res.setHeader('Content-Disposition','attachment; filename="pendencias-mcs.csv"');return res.status(200).send('\uFEFF'+sheet(items));
      }
      const stageIndex=await loadSearchStageIndex(ctx);return send(res,200,{items:items.map((item)=>decorateWithSearchStage(item,stageIndex)),counts:snapshot.counts,run:snapshot.run,lastHistoryAt:snapshot.lastHistoryAt,historyReady:!snapshot.lastHistoryAt||Date.now()-Date.parse(snapshot.lastHistoryAt)>=30*60000});
    }
    if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
    const body=await jsonBody(req,32*1024);
    if(body.action==='start_general')return send(res,201,await startGeneralRead(ctx));
    if(body.action==='continue_general')return send(res,200,await generalBatch(ctx));
    if(body.action==='pause_general'||body.action==='resume_general'){
      const status=body.action==='pause_general'?'PAUSED':'ACTIVE';const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_pending_set_general_status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_status:status})});return send(res,200,result);
    }
    if(body.action==='increase_budget'){
      if(body.confirm!==true)return send(res,400,{error:'BUDGET_CONFIRMATION_REQUIRED'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_pending_add_general_budget',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_add_usd:10})});return send(res,200,result);
    }
    if(body.action==='resolve'){
      if(!isUuid(body.journeyId)||!isUuid(body.chatId))return send(res,400,{error:'CONVERSATION_ID_INVALID'});await resolvePending(ctx,body);return send(res,200,{resolved:true});
    }
    if(body.action==='unresolve'){
      if(!isUuid(body.journeyId)||!isUuid(body.chatId))return send(res,400,{error:'CONVERSATION_ID_INVALID'});await unresolvePending(ctx,body);return send(res,200,{resolved:false});
    }
    return send(res,400,{error:'ACTION_INVALID'});
  }catch(error){
    if(error.message==='HISTORY_STILL_ARRIVING')return send(res,409,{error:error.message,lastHistoryAt:error.lastHistoryAt});
    if(['AI_UNAVAILABLE','AI_RESPONSE_INVALID'].includes(error.message))return send(res,503,{error:'AI_UNAVAILABLE',message:'IA indisponível'});
    if(['PENDING_RUN_UNAVAILABLE','PENDING_BUDGET_INVALID'].includes(error.message))return send(res,409,{error:error.message});
    return send(res,500,{error:'PENDING_UNAVAILABLE'});
  }
};

'use strict';
const crypto=require('node:crypto');
const { digest, validItems, prepareItems } = require('../../../panel-note');
const { jsonBody, requirePanel, safeText, send, supabase, isUuid } = require('../../../panel-server');
const { leadData } = require('../../../panel-lead');
const { anthropicJson, reserveCall } = require('../../../panel-ai');
module.exports=async(req,res)=>{
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),20000);
  const ctx=await requirePanel(req,res);if(!ctx){clearTimeout(timer);return;}
  let body,lead,note,ref;
  try {
    body=await jsonBody(req,20*1024);
    ref=String(body.ref||'').trim().toUpperCase();note=safeText(body.note,12000,true);
    if(!note)return send(res,400,{error:'NOTE_REQUIRED'});
    if(controller.signal.aborted)throw new Error('TIMEOUT');
    lead=await Promise.race([leadData(ctx,req,ref,body.journeyId),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new Error('TIMEOUT')),{once:true}))]);
    if(!lead)return send(res,404,{error:'LEAD_NOT_FOUND'});
    const current={ref:lead.ref,timezone:lead.timezone,name:lead.record?.contact?.display_name||lead.order?.contactName||null,
      maxBid:lead.maxBidCents?lead.maxBidCents/100:null,totalCeiling:lead.totalCeilingCents?lead.totalCeilingCents/100:null,payment:lead.payment,
      deadline:lead.record?.customer_deadline_text||lead.order?.deadlineText||null,wishes:lead.wishes,checklist:lead.checklist,stage:lead.record?.stage||'NOVO'};
    await reserveCall(ctx);
    const parsed=await anthropicJson(
      'Organize a anotação em JSON {"items":[...]}. Cada item cita trecho literal contínuo que comprova especificamente o destino e valor. Sem invenções. Tipos: call_result (ANSWERED/NO_ANSWER/LATER/IN_PERSON/DEPOSIT), checklist (point 1..6, value OK), budget (teto TOTAL confirmado em dólares, nunca lance máximo), payment (cash/fin), deadline (now/30d/3m/none), wishlist (value {operation:include/remove/reorder/update,car:{make,model,yearMin,yearMax,maxMiles},preference}), phone ({number,owner}), promise/return ({text,at} data/hora local ISO), stage, disable ({reason} sugestão). Só inclua datas expressas na anotação; converta as relativas no fuso do cliente. Retorne somente JSON.',
      JSON.stringify({note,current,now:new Date().toISOString()})
    );
    const items=prepareItems(validItems(note,parsed.items),lead);
    return send(res,200,{items,signature:digest(ctx.config.secretKey,lead.ref,note,items)});
  } catch (_) {
    if(note&&/^[A-HJ-NP-Z2-9]{5}$/.test(ref)&&(!body?.journeyId||isUuid(body.journeyId))) {
      try {
        const key=isUuid(body?.fallbackKey)?body.fallbackKey:crypto.randomUUID();
        await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_confirm_lead_note',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          p_environment:ctx.environment,p_actor:ctx.panel.id,p_ref:ref,p_journey:body.journeyId||null,p_body:note,p_items:[],p_key:key,
          p_initial:lead?{name:lead.order?.contactName,vehicle:lead.order?.vehicleText,wishes:lead.wishes,maxBidCents:lead.maxBidCents,payment:lead.payment,deadline:lead.order?.deadlineText}:{}
        })});
        return send(res,200,{saved:true,message:'Anotação salva; distribuição indisponível agora — tentar de novo'});
      }catch(error){return send(res,error.status||503,{error:'DISTRIBUTION_AND_SAVE_FAILED'});}
    }
    return send(res,503,{error:'DISTRIBUTION_UNAVAILABLE'});
  }finally{clearTimeout(timer);}
};
// Kept as a testable compatibility export; parsing itself is centralized in panel-ai.
module.exports.firstJson=require('../../../panel-ai').firstJson;

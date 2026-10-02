'use strict';

const {allConversationData,calculatorOrders,deterministicCandidates,readConversation}=require('../../panel-ai');
const {insert,isUuid,jsonBody,patchRows,requirePanel,rows,send,supabase}=require('../../panel-server');

async function resolveSuggestion(ctx,id,link){
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_resolve_suggestion_undoable',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_id:id,p_actor:ctx.panel.id,p_link:link})
  });
}

module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  try{
    if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
    const body=await jsonBody(req,32*1024);
    if(!isUuid(body.journeyId))return send(res,400,{error:'JOURNEY_ID_INVALID'});
    if(body.action==='read'){
      const groups=(await allConversationData(ctx)).filter((group)=>group.journey.id===body.journeyId&&group.lastCustomer);
      groups.sort((a,b)=>Date.parse(b.lastCustomer.occurred_at_utc||b.lastCustomer.created_at)-Date.parse(a.lastCustomer.occurred_at_utc||a.lastCustomer.created_at));
      const group=body.chatId?groups.find((candidate)=>candidate.chatId===body.chatId):groups[0];
      if(!group)return send(res,409,{error:'AI_NO_CUSTOMER_MESSAGE',message:'Não há mensagem do cliente para ler.'});
      // The same click also reads the conversation for PESQUISAS (car and criteria for the ficha).
      const [reading,extraction]=await Promise.allSettled([readConversation(ctx,group,{manual:true,actor:ctx.panel.id}),require('./pesquisas').extractNow(ctx,group.chatId)]);
      if(reading.status==='rejected')throw reading.reason;
      return send(res,201,{...reading.value,searchExtraction:extraction.status==='fulfilled'?extraction.value:{error:'SEARCH_REQUESTS_FAILED'}});
    }
    if(body.action==='confirm'){
      if(!isUuid(body.readingId)||!isUuid(body.confirmationKey)||!Array.isArray(body.itemIds)||!body.itemIds.length||body.itemIds.some((id)=>!isUuid(id)))return send(res,400,{error:'AI_SELECTION_REQUIRED'});
      const journey=(await rows(ctx,'journeys',{select:'id,contact_id,reference_code,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_text',environment:'eq.'+ctx.environment,id:'eq.'+body.journeyId,limit:'1'}))[0];
      if(!journey)return send(res,404,{error:'JOURNEY_NOT_FOUND'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_ai_confirm_items',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_actor:ctx.panel.id,p_journey:body.journeyId,
          p_reading:body.readingId,p_item_ids:body.itemIds,p_key:body.confirmationKey,p_initial:{vehicle:journey.vehicle_text,wishes:journey.criteria_json?.wishlists||[],maxBidCents:journey.budget_cents,payment:journey.payment_text,deadline:journey.customer_deadline_text}})
      });
      return send(res,201,result);
    }
    if(body.action==='discard'){
      if(!isUuid(body.readingId))return send(res,400,{error:'AI_READING_INVALID'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_ai_discard_reading',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_actor:ctx.panel.id,p_journey:body.journeyId,p_reading:body.readingId})
      });
      return send(res,200,result);
    }
    if(body.action==='suggestion'){
      if(!isUuid(body.suggestionId)||typeof body.link!=='boolean')return send(res,400,{error:'SUGGESTION_INVALID'});
      return send(res,200,await resolveSuggestion(ctx,body.suggestionId,body.link));
    }
    if(body.action==='suggestion_undo'){
      if(!isUuid(body.suggestionId))return send(res,400,{error:'SUGGESTION_INVALID'});
      return send(res,200,await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_link_ref_undo',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_id:body.suggestionId,p_actor:ctx.panel.id})}));
    }
    if(body.action==='alternatives'){
      const group=(await allConversationData(ctx)).find((candidate)=>candidate.journey.id===body.journeyId&&candidate.lastCustomer);
      if(!group)return send(res,404,{error:'CONVERSATION_NOT_FOUND'});
      const candidates=deterministicCandidates(group,await calculatorOrders(ctx));
      return send(res,200,{items:candidates.map((candidate)=>({ref:candidate.ref,name:candidate.contactName,vehicle:candidate.vehicleText,budgetCents:candidate.budgetCents,occurredAt:candidate.occurredAt}))});
    }
    if(body.action==='choose'){
      const ref=String(body.ref||'').trim().toUpperCase();
      const group=(await allConversationData(ctx)).find((candidate)=>candidate.journey.id===body.journeyId&&candidate.lastCustomer);
      if(!group)return send(res,404,{error:'CONVERSATION_NOT_FOUND'});
      const candidate=deterministicCandidates(group,await calculatorOrders(ctx)).find((item)=>item.ref===ref);
      if(!candidate)return send(res,409,{error:'SUGGESTION_UNAVAILABLE'});
      const phone=(await rows(ctx,'contact_phones',{select:'phone_e164',environment:'eq.'+ctx.environment,contact_id:'eq.'+group.journey.contact_id,is_current:'eq.true',order:'is_primary.desc,created_at.asc',limit:'1'}))[0]?.phone_e164||'+10000000000';
      let suggestion=(await rows(ctx,'whatsapp_link_suggestions',{select:'id',environment:'eq.'+ctx.environment,source_journey_id:'eq.'+body.journeyId,target_ref:'eq.'+ref,limit:'1'}))[0];
      const payload={source_chat_id:group.chatId,target_ref:ref,target_contact_id:null,target_journey_id:null,phone_e164:phone,status:'PENDING',motives:'Escolhido manualmente',suggestion_kind:'AI',candidate_latest_at:candidate.occurredAt,resolved_at:null,resolved_by:null};
      await patchRows(ctx,'whatsapp_link_suggestions',{environment:'eq.'+ctx.environment,source_journey_id:'eq.'+body.journeyId,status:'eq.PENDING',suggestion_kind:'eq.AI'},{status:'REJECTED',resolved_at:new Date().toISOString(),resolved_by:ctx.panel.id});
      if(suggestion)await patchRows(ctx,'whatsapp_link_suggestions',{environment:'eq.'+ctx.environment,id:'eq.'+suggestion.id},payload);
      else suggestion=(await insert(ctx,'whatsapp_link_suggestions',{environment:ctx.environment,source_contact_id:group.journey.contact_id,source_journey_id:body.journeyId,...payload}))[0];
      return send(res,200,await resolveSuggestion(ctx,suggestion.id,true));
    }
    return send(res,400,{error:'ACTION_INVALID'});
  }catch(error){
    // A RAISE inside the RPC arrives as error.code (see panel-server supabase()).
    const code=String(error&&(error.code||error.message)||'');
    if(code==='AI_DAILY_LIMIT')return send(res,429,{error:code,message:'limite do dia atingido'});
    if(code==='AI_BALANCE_LIMIT')return send(res,402,{error:code,message:'Claude sem saldo pré-pago'});
    if(['AI_UNAVAILABLE','AI_RESPONSE_INVALID'].includes(code))return send(res,503,{error:'AI_UNAVAILABLE',message:'IA indisponível'});
    if(['AI_REF_REQUIRED','AI_ITEMS_UNAVAILABLE','REF_ALREADY_LINKED','JOURNEY_FROZEN','JOURNEY_MERGED','CONFIRMATION_KEY_REUSED','UNDO_UNAVAILABLE','UNDO_EXPIRED','UNDO_NOT_ALLOWED','SUGGESTION_UNAVAILABLE'].includes(code))return send(res,409,{error:code});
    if(code==='JOURNEY_NOT_FOUND')return send(res,404,{error:code});
    return send(res,500,{error:'AI_ACTION_FAILED'});
  }
};

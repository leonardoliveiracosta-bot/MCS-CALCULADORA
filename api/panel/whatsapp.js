'use strict';
const crypto=require('node:crypto');
const {allRows,isUuid,jsonBody,patchRows,requirePanel,rows,send,supabase}=require('../../panel-server');
const {normalizedItems,processItem,processRaw,resolveItemError,saveItemError}=require('../../whatsapp-receiver');
const {recoverStalledEvents,reprocessItemError,resolveStoredItemErrors}=require('../../whatsapp-maintenance');
const {activeRows:activeTriage}=require('../../panel-triage');

module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  try{
    if(req.method==='GET'){
      await resolveStoredItemErrors(ctx).catch((error)=>console.error('[whatsapp-maintenance]',{operation:'resolve',message:String(error?.message||'UNKNOWN')}));
      await recoverStalledEvents(ctx,{maxEvents:3,deadlineAt:Date.now()+25000}).catch((error)=>console.error('[whatsapp-maintenance]',{operation:'recover',message:String(error?.message||'UNKNOWN')}));
      const [latest,inbound,echo,errors,ignored,itemErrors,suggestions,phoneReviews]=await Promise.all([
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'neq.PANEL_SEND',order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'eq.messages',status:'eq.DONE',order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'eq.smb_message_echoes',status:'eq.DONE',order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'id,event_type,status,error_code,received_at,processing_started_at,attempts',environment:'eq.'+ctx.environment,status:'in.(ERROR,PENDING,PROCESSING)',order:'received_at.desc',limit:'50'}),
        rows(ctx,'whatsapp_raw_events',{select:'id,event_type,status,error_code,received_at',environment:'eq.'+ctx.environment,status:'eq.IGNORED',event_type:'neq.statuses',order:'received_at.desc',limit:'20'}),
        rows(ctx,'whatsapp_item_errors',{select:'id,raw_event_id,item_index,error_code,status,attempts,processing_started_at,created_at',environment:'eq.'+ctx.environment,status:'neq.RESOLVED',order:'created_at.desc',limit:'50'}),
        allRows(ctx,'whatsapp_link_suggestions',{select:'id,phone_e164,source_contact_id,source_journey_id,target_contact_id,target_journey_id,target_ref,motives,suggestion_kind,created_at',environment:'eq.'+ctx.environment,status:'eq.PENDING',order:'created_at.desc'})
        ,allRows(ctx,'whatsapp_phone_reviews',{select:'id,phone_e164,candidate_contact_ids,created_at',environment:'eq.'+ctx.environment,status:'eq.PENDING',order:'created_at.desc'})
      ]);
      // Triagem: a conversa classificada fora do funil comercial sai da pendência (a sugestão fica guardada).
      // Only the chats of the suggestions' source contacts (a short list), never every triaged chat.
      const sourceContacts=[...new Set(suggestions.map((item)=>item.source_contact_id).filter(isUuid))];
      const triage=sourceContacts.length?await activeTriage(ctx):[];
      const triageChats=triage.length?await allRows(ctx,'chats',{select:'id,contact_id',environment:'eq.'+ctx.environment,contact_id:'in.('+sourceContacts.join(',')+')'}):[];
      const contactOfChat=new Map(triageChats.map((chat)=>[chat.id,chat.contact_id]));
      const decisionsByContact=new Map();triage.forEach((row)=>{const contactId=contactOfChat.get(row.chat_id);if(!contactId)return;if(!decisionsByContact.has(contactId))decisionsByContact.set(contactId,[]);decisionsByContact.get(contactId).push(row.decision);});
      const outOfFunnel=(contactId)=>{const decisions=decisionsByContact.get(contactId)||[];return decisions.length>0&&decisions.every((decision)=>decision==='FORA_DO_FUNIL');};
      const commercialSuggestions=suggestions.filter((item)=>!outOfFunnel(item.source_contact_id));
      const contactIds=[...new Set(suggestions.flatMap((item)=>[item.source_contact_id,item.target_contact_id]).filter(Boolean).concat(phoneReviews.flatMap((item)=>(item.candidate_contact_ids||[]).filter(Boolean))))];
      const contacts=contactIds.length?await rows(ctx,'contacts',{select:'id,display_name,is_lead',environment:'eq.'+ctx.environment,id:'in.('+contactIds.join(',')+')'}):[];
      const names=new Map(contacts.map(x=>[x.id,x.display_name]));
      return send(res,200,{lastEventAt:latest[0]?.received_at||null,lastInboundAt:inbound[0]?.received_at||null,lastEchoAt:echo[0]?.received_at||null,
        errors:errors.filter(x=>x.status!=='PROCESSING'||Date.now()-Date.parse(x.processing_started_at||0)>120000),ignored,itemErrors,
        suggestions:commercialSuggestions.map(x=>({...x,sourceName:names.get(x.source_contact_id),targetName:names.get(x.target_contact_id),sourceIsLead:contacts.find(c=>c.id===x.source_contact_id)?.is_lead!==false})),
        phoneReviews:phoneReviews.map(x=>({...x,candidates:(x.candidate_contact_ids||[]).map(id=>({id,name:names.get(id)||'Contato',isLead:contacts.find(c=>c.id===id)?.is_lead!==false}))}))});
    }
    if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
    const body=await jsonBody(req,4096);
    if(body.action==='reprocess'){
      if(!isUuid(body.id))return send(res,400,{error:'EVENT_ID_INVALID'});
      let event=(await rows(ctx,'whatsapp_raw_events',{select:'id,event_type,payload_json,status,attempts,received_at,processing_started_at',environment:'eq.'+ctx.environment,id:'eq.'+body.id,limit:'1'}))[0];
      if(!event)return send(res,404,{error:'EVENT_NOT_FOUND'});
      if(event.status==='PROCESSING'&&Date.now()-Date.parse(event.processing_started_at||0)>120000){
        await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+event.id,environment:'eq.'+ctx.environment,status:'eq.PROCESSING'},{status:'ERROR',error_code:'PROCESSING_INTERRUPTED',processing_started_at:null});
        event={...event,status:'ERROR'};
      }
      if(!['ERROR','PENDING'].includes(event.status))return send(res,409,{error:'EVENT_NOT_REPROCESSABLE'});
      const result=await processRaw(ctx,event);
      return send(res,result.error?409:200,result.error?{error:'PROCESSING_FAILED'}:result);
    }
    if(body.action==='dismiss_item'){
      if(!isUuid(body.id))return send(res,400,{error:'ITEM_ID_INVALID'});
      const itemError=(await rows(ctx,'whatsapp_item_errors',{select:'id,raw_event_id,error_code,status',environment:'eq.'+ctx.environment,id:'eq.'+body.id,limit:'1'}))[0];
      if(!itemError)return send(res,404,{error:'ITEM_ERROR_NOT_FOUND'});
      if(itemError.error_code!=='HISTORY_DECLINED'||itemError.status==='RESOLVED')return send(res,409,{error:'ITEM_NOT_DISMISSIBLE'});
      const resolved=await patchRows(ctx,'whatsapp_item_errors',{id:'eq.'+itemError.id,environment:'eq.'+ctx.environment,error_code:'eq.HISTORY_DECLINED',status:'neq.RESOLVED'},{status:'RESOLVED',processing_started_at:null,resolved_at:new Date().toISOString()},true);
      if(!resolved.length)return send(res,409,{error:'ITEM_NOT_DISMISSIBLE'});
      const remaining=await rows(ctx,'whatsapp_item_errors',{select:'id',environment:'eq.'+ctx.environment,raw_event_id:'eq.'+itemError.raw_event_id,status:'neq.RESOLVED',limit:'1'});
      if(!remaining.length)await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+itemError.raw_event_id,environment:'eq.'+ctx.environment},{error_code:null});
      return send(res,200,{resolved:true});
    }
    if(body.action==='reprocess_item'){
      if(!isUuid(body.id))return send(res,400,{error:'ITEM_ID_INVALID'});
      const itemError=(await rows(ctx,'whatsapp_item_errors',{select:'id,raw_event_id,item_index,item_json,error_code,status,attempts,processing_started_at',environment:'eq.'+ctx.environment,id:'eq.'+body.id,limit:'1'}))[0];
      if(!itemError)return send(res,404,{error:'ITEM_ERROR_NOT_FOUND'});
      const out=await reprocessItemError(ctx,itemError);
      if(out.busy)return send(res,409,{error:'ITEM_ALREADY_PROCESSING'});
      if(out.failed)return send(res,409,{error:'ITEM_PROCESSING_FAILED'});
      return send(res,200,{resolved:true,review:Boolean(out.review),duplicate:Boolean(out.duplicate)});
    }
    if(body.action==='suggestion'){
      if(!isUuid(body.id)||typeof body.link!=='boolean')return send(res,400,{error:'SUGGESTION_INVALID'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_resolve_suggestion',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_id:body.id,p_actor:ctx.panel.id,p_link:body.link})});
      return send(res,200,result);
    }
    if(body.action==='phone_review'){
      if(!isUuid(body.id)||!isUuid(body.contactId))return send(res,400,{error:'PHONE_REVIEW_INVALID'});
      const review=(await rows(ctx,'whatsapp_phone_reviews',{select:'id,raw_event_id,item_index,item_json,candidate_contact_ids,status',environment:'eq.'+ctx.environment,id:'eq.'+body.id,limit:'1'}))[0];
      if(!review||review.status!=='PENDING'||!(review.candidate_contact_ids||[]).includes(body.contactId))return send(res,409,{error:'PHONE_REVIEW_UNAVAILABLE'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_apply_message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_raw:review.raw_event_id,p_item:{...review.item_json,forceContactId:body.contactId}})});
      await patchRows(ctx,'whatsapp_phone_reviews',{id:'eq.'+review.id,environment:'eq.'+ctx.environment,status:'eq.PENDING'},{status:'LINKED',resolved_at:new Date().toISOString(),resolved_by:ctx.panel.id},true);
      await resolveItemError(ctx,review.raw_event_id,review.item_index).catch(()=>null);
      const remaining=await rows(ctx,'whatsapp_item_errors',{select:'id',environment:'eq.'+ctx.environment,raw_event_id:'eq.'+review.raw_event_id,status:'neq.RESOLVED',limit:'1'});
      if(!remaining.length)await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+review.raw_event_id,environment:'eq.'+ctx.environment},{error_code:null});
      return send(res,200,result);
    }
    if(body.action==='contact_lead'){
      if(!isUuid(body.contactId)||typeof body.isLead!=='boolean')return send(res,400,{error:'CONTACT_LEAD_INVALID'});
      const changed=await patchRows(ctx,'contacts',{id:'eq.'+body.contactId,environment:'eq.'+ctx.environment},{is_lead:body.isLead,lead_excluded_at:body.isLead?null:new Date().toISOString(),lead_excluded_by:body.isLead?null:ctx.panel.id,updated_at:new Date().toISOString()},true);
      if(!changed.length)return send(res,404,{error:'CONTACT_NOT_FOUND'});
      return send(res,200,{updated:true});
    }
    return send(res,400,{error:'ACTION_INVALID'});
  }catch(error){
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[panel-whatsapp]',{requestId,route:'/api/panel/whatsapp',message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});
    return send(res,500,{error:'WHATSAPP_PANEL_UNAVAILABLE',requestId});
  }
};

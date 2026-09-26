'use strict';
const {allRows,isUuid,jsonBody,patchRows,requirePanel,rows,send,supabase}=require('../../panel-server');
const {processRaw}=require('../../whatsapp-receiver');

module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  try{
    if(req.method==='GET'){
      const [latest,inbound,echo,errors,ignored,itemErrors,suggestions,phoneReviews]=await Promise.all([
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'eq.messages',status:'eq.DONE',order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'eq.smb_message_echoes',status:'eq.DONE',order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'id,event_type,status,error_code,received_at,attempts',environment:'eq.'+ctx.environment,status:'in.(ERROR,PENDING,PROCESSING)',order:'received_at.desc',limit:'50'}),
        rows(ctx,'whatsapp_raw_events',{select:'id,event_type,status,error_code,received_at',environment:'eq.'+ctx.environment,status:'eq.IGNORED',order:'received_at.desc',limit:'20'}),
        rows(ctx,'whatsapp_item_errors',{select:'id,raw_event_id,item_index,error_code,created_at',environment:'eq.'+ctx.environment,order:'created_at.desc',limit:'50'}),
        allRows(ctx,'whatsapp_link_suggestions',{select:'id,phone_e164,source_contact_id,target_contact_id,target_journey_id,created_at',environment:'eq.'+ctx.environment,status:'eq.PENDING',order:'created_at.desc'})
        ,allRows(ctx,'whatsapp_phone_reviews',{select:'id,phone_e164,candidate_contact_ids,created_at',environment:'eq.'+ctx.environment,status:'eq.PENDING',order:'created_at.desc'})
      ]);
      const contactIds=[...new Set(suggestions.flatMap(x=>[x.source_contact_id,x.target_contact_id]).concat(phoneReviews.flatMap(x=>x.candidate_contact_ids||[])))];
      const contacts=contactIds.length?await rows(ctx,'contacts',{select:'id,display_name,is_lead',environment:'eq.'+ctx.environment,id:'in.('+contactIds.join(',')+')'}):[];
      const names=new Map(contacts.map(x=>[x.id,x.display_name]));
      return send(res,200,{lastEventAt:latest[0]?.received_at||null,lastInboundAt:inbound[0]?.received_at||null,lastEchoAt:echo[0]?.received_at||null,
        errors:errors.filter(x=>x.status!=='PROCESSING'||Date.now()-Date.parse(x.received_at)>120000),ignored,itemErrors,
        suggestions:suggestions.map(x=>({...x,sourceName:names.get(x.source_contact_id),targetName:names.get(x.target_contact_id)})),
        phoneReviews:phoneReviews.map(x=>({...x,candidates:(x.candidate_contact_ids||[]).map(id=>({id,name:names.get(id)||'Contato'}))}))});
    }
    if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
    const body=await jsonBody(req,4096);
    if(body.action==='reprocess'){
      if(!isUuid(body.id))return send(res,400,{error:'EVENT_ID_INVALID'});
      let event=(await rows(ctx,'whatsapp_raw_events',{select:'id,event_type,payload_json,status,attempts,received_at',environment:'eq.'+ctx.environment,id:'eq.'+body.id,limit:'1'}))[0];
      if(!event)return send(res,404,{error:'EVENT_NOT_FOUND'});
      if(event.status==='PROCESSING'&&Date.now()-Date.parse(event.received_at)>120000){
        await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+event.id,environment:'eq.'+ctx.environment,status:'eq.PROCESSING'},{status:'ERROR',error_code:'PROCESSING_INTERRUPTED'});
        event={...event,status:'ERROR'};
      }
      if(!['ERROR','PENDING'].includes(event.status))return send(res,409,{error:'EVENT_NOT_REPROCESSABLE'});
      const result=await processRaw(ctx,event);
      return send(res,result.error?409:200,result.error?{error:'PROCESSING_FAILED'}:result);
    }
    if(body.action==='suggestion'){
      if(!isUuid(body.id)||typeof body.link!=='boolean')return send(res,400,{error:'SUGGESTION_INVALID'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_resolve_suggestion',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_id:body.id,p_actor:ctx.panel.id,p_link:body.link})});
      return send(res,200,result);
    }
    if(body.action==='phone_review'){
      if(!isUuid(body.id)||!isUuid(body.contactId))return send(res,400,{error:'PHONE_REVIEW_INVALID'});
      const review=(await rows(ctx,'whatsapp_phone_reviews',{select:'id,raw_event_id,item_json,candidate_contact_ids,status',environment:'eq.'+ctx.environment,id:'eq.'+body.id,limit:'1'}))[0];
      if(!review||review.status!=='PENDING'||!(review.candidate_contact_ids||[]).includes(body.contactId))return send(res,409,{error:'PHONE_REVIEW_UNAVAILABLE'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_apply_message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_raw:review.raw_event_id,p_item:{...review.item_json,forceContactId:body.contactId}})});
      await patchRows(ctx,'whatsapp_phone_reviews',{id:'eq.'+review.id,environment:'eq.'+ctx.environment,status:'eq.PENDING'},{status:'LINKED',resolved_at:new Date().toISOString(),resolved_by:ctx.panel.id},true);
      return send(res,200,result);
    }
    if(body.action==='contact_lead'){
      if(!isUuid(body.contactId)||typeof body.isLead!=='boolean')return send(res,400,{error:'CONTACT_LEAD_INVALID'});
      const changed=await patchRows(ctx,'contacts',{id:'eq.'+body.contactId,environment:'eq.'+ctx.environment},{is_lead:body.isLead,lead_excluded_at:body.isLead?null:new Date().toISOString(),lead_excluded_by:body.isLead?null:ctx.panel.id,updated_at:new Date().toISOString()},true);
      if(!changed.length)return send(res,404,{error:'CONTACT_NOT_FOUND'});
      return send(res,200,{updated:true});
    }
    return send(res,400,{error:'ACTION_INVALID'});
  }catch(_){return send(res,500,{error:'WHATSAPP_PANEL_UNAVAILABLE'});}
};

'use strict';
const {allRows,isUuid,jsonBody,patchRows,requirePanel,rows,send,supabase}=require('../../panel-server');
const {processRaw}=require('../../whatsapp-receiver');

module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  try{
    if(req.method==='GET'){
      const [latest,inbound,echo,errors,suggestions]=await Promise.all([
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'eq.messages',status:'eq.DONE',order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'received_at',environment:'eq.'+ctx.environment,event_type:'eq.smb_message_echoes',status:'eq.DONE',order:'received_at.desc',limit:'1'}),
        rows(ctx,'whatsapp_raw_events',{select:'id,event_type,status,error_code,received_at,attempts',environment:'eq.'+ctx.environment,status:'in.(ERROR,PENDING,PROCESSING)',order:'received_at.desc',limit:'50'}),
        allRows(ctx,'whatsapp_link_suggestions',{select:'id,phone_e164,source_contact_id,target_contact_id,target_journey_id,created_at',environment:'eq.'+ctx.environment,status:'eq.PENDING',order:'created_at.desc'})
      ]);
      const contactIds=[...new Set(suggestions.flatMap(x=>[x.source_contact_id,x.target_contact_id]))];
      const contacts=contactIds.length?await rows(ctx,'contacts',{select:'id,display_name',environment:'eq.'+ctx.environment,id:'in.('+contactIds.join(',')+')'}):[];
      const names=new Map(contacts.map(x=>[x.id,x.display_name]));
      return send(res,200,{lastEventAt:latest[0]?.received_at||null,lastInboundAt:inbound[0]?.received_at||null,lastEchoAt:echo[0]?.received_at||null,
        errors:errors.filter(x=>x.status!=='PROCESSING'||Date.now()-Date.parse(x.received_at)>120000),suggestions:suggestions.map(x=>({...x,sourceName:names.get(x.source_contact_id),targetName:names.get(x.target_contact_id)}))});
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
    return send(res,400,{error:'ACTION_INVALID'});
  }catch(_){return send(res,500,{error:'WHATSAPP_PANEL_UNAVAILABLE'});}
};

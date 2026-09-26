'use strict';
const crypto=require('node:crypto');
const {extractRefs}=require('./painel/parser');
const {rows,patchRows,supabase}=require('./panel-server');

function phone(value){
  const raw=String(value||'');
  if(/@g\.us|@broadcast|@newsletter/i.test(raw))return null;
  const digits=raw.replace(/\D/g,'');
  const result=digits.length===10?'1'+digits:digits;
  return /^[1-9]\d{6,14}$/.test(result)?'+'+result:null;
}
function textOf(message){
  if(message.type==='text')return message.text?.body||null;
  if(message.type==='interactive')return message.interactive?.button_reply?.title||message.interactive?.list_reply?.title||null;
  if(message.type==='button')return message.button?.text||null;
  return {image:'[imagem]',audio:'[áudio]',voice:'[áudio]',video:'[vídeo]',document:'[documento]',location:'[localização]',sticker:'[imagem]'}[message.type]||null;
}
function isGroup(message){return /@g\.us|@broadcast|@newsletter/i.test(String(message?.from||'')+' '+String(message?.to||'')+' '+String(message?.context?.group_id||''));}
function parse(payload){
  if(payload?.event==='history'){
    if(!Array.isArray(payload.data?.history))throw Error('HISTORY_INVALID');
    const business=phone(payload.data.metadata?.display_phone_number);
    const items=[];
    for(const chunk of payload.data.history){
      if(!Array.isArray(chunk.threads))continue;
      for(const thread of chunk.threads){
        if(!Array.isArray(thread.messages))throw Error('HISTORY_THREAD_INVALID');
        for(const message of thread.messages){
          if(isGroup(message)||/@g\.us|@broadcast|@newsletter/i.test(String(thread.id||'')))continue;
          const recipient=phone(thread.id||message.to),sender=phone(message.from);
          if(!recipient||!sender)continue;
          items.push({message,phone:recipient,direction:business&&sender===business?'MCS':sender===recipient?'CUSTOMER':null,name:thread.name||null});
        }
      }
    }
    return {type:'history',items};
  }
  if(payload?.event==='smb_app_state_sync'){
    if(!Array.isArray(payload.data?.state_sync))throw Error('STATE_SYNC_INVALID');
    return {type:'smb_app_state_sync',items:[]};
  }
  if(payload?.object!=='whatsapp_business_account'||!Array.isArray(payload.entry))return {type:'UNKNOWN',items:[]};
  const items=[];let type='statuses';
  for(const entry of payload.entry){
    if(!Array.isArray(entry.changes))throw Error('CHANGES_INVALID');
    for(const change of entry.changes){
      const field=change.field,value=change.value||{};
      if(field==='messages'){
        if(value.messages!==undefined&&!Array.isArray(value.messages))throw Error('MESSAGES_INVALID');
        if(!Array.isArray(value.messages))continue;
        type='messages';
        for(const message of value.messages){
          if(!message||typeof message!=='object')throw Error('MESSAGE_INVALID');
          if(isGroup(message))continue;
          const who=phone(message.from),contact=(value.contacts||[]).find((row)=>phone(row.wa_id)===who);
          if(who)items.push({message,phone:who,direction:'CUSTOMER',name:contact?.profile?.name||null});
        }
      }else if(field==='smb_message_echoes'){
        if(!Array.isArray(value.message_echoes))throw Error('ECHOES_INVALID');
        type='smb_message_echoes';
        for(const message of value.message_echoes){
          if(!message||typeof message!=='object')throw Error('ECHO_INVALID');
          if(isGroup(message))continue;
          const who=phone(message.to);
          if(who)items.push({message,phone:who,direction:'MCS',name:null});
        }
      }else if(field==='smb_app_state_sync'){
        if(!Array.isArray(value.state_sync))throw Error('STATE_SYNC_INVALID');
        type='smb_app_state_sync';
      }else if(field!=='messages'||!value.statuses)type=type==='statuses'?'UNKNOWN':type;
    }
  }
  return {type,items};
}
function normalizedItems(payload){
  const parsed=parse(payload);
  const items=parsed.items.map(({message,phone:clientPhone,direction,name})=>{
    const body=textOf(message);
    if(!message.id||!message.timestamp||!body||!direction)throw Error('MESSAGE_CONTENT_INVALID');
    return {messageId:String(message.id),phone:clientPhone,name,direction,body,timestamp:String(message.timestamp),refs:extractRefs([{body}])};
  });
  return {...parsed,items};
}
function eventKey(payload){
  const first=payload?.entry?.[0]?.changes?.[0];
  const array=first?.field==='smb_message_echoes'?first.value?.message_echoes:first?.value?.messages;
  if(Array.isArray(array)&&array.length===1&&array[0]?.id)return `${first.field}:${array[0].id}`;
  if(payload?.id&&['history','smb_app_state_sync'].includes(payload.event))return `${payload.event}:${payload.id}`;
  return 'sha256:'+crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
async function processRaw(ctx,row){
  const claimed=await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+row.id,environment:'eq.'+ctx.environment,status:'in.(PENDING,ERROR)'},
    {status:'PROCESSING',attempts:(row.attempts||0)+1,error_code:null},true);
  if(!claimed.length)return {skipped:true};
  try{
    const {type,items}=normalizedItems(row.payload_json);
    let imported=0,duplicates=0;
    for(const item of items){
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_apply_message',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_raw:row.id,p_item:item})});
      result.duplicate?duplicates++:imported++;
    }
    await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+row.id,environment:'eq.'+ctx.environment},
      {status:type==='UNKNOWN'||type==='statuses'?'IGNORED':'DONE',event_type:type,error_code:null,processed_at:new Date().toISOString()});
    return {imported,duplicates};
  }catch(error){
    await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+row.id,environment:'eq.'+ctx.environment},
      {status:'ERROR',error_code:/^[A-Z_]{3,50}$/.test(error.message)?error.message:'PROCESSING_FAILED'});
    return {error:true};
  }
}
async function rawEvent(ctx,payload){
  const key=eventKey(payload);
  const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/whatsapp_raw_events?on_conflict=environment,event_key',{
    method:'POST',headers:{'content-type':'application/json',prefer:'resolution=ignore-duplicates,return=representation'},
    body:JSON.stringify({environment:ctx.environment,event_key:key,event_type:payload?.event||payload?.entry?.[0]?.changes?.[0]?.field||'UNKNOWN',payload_json:payload})});
  if(result?.length)return result[0];
  const existing=await rows(ctx,'whatsapp_raw_events',{select:'id,status,attempts,payload_json',environment:'eq.'+ctx.environment,event_key:'eq.'+key,limit:'1'});
  return existing[0]?.status==='ERROR'?existing[0]:null;
}
module.exports={phone,parse,normalizedItems,eventKey,processRaw,rawEvent};

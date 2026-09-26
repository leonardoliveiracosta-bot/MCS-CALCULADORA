'use strict';
const crypto=require('node:crypto');
const {extractRefs}=require('./painel/parser');
const {normalizePhone}=require('./panel-phone');
const {rows,patchRows,supabase}=require('./panel-server');

const phone=normalizePhone;
function isGroup(message,threadId){return /@g\.us|@broadcast|@newsletter/i.test([message?.from,message?.to,message?.context?.group_id,threadId].join(' '));}
function content(message){
  const type=String(message?.type||'').toLowerCase();
  if(['revoked','revoke','deleted','delete'].includes(type)||message?.errors?.some?.((x)=>Number(x.code)===131051&&/revoke|delete/i.test(x.title||'')))return {ignore:true};
  if(type==='text')return {body:message.text?.body||null};
  if(type==='interactive')return {body:message.interactive?.button_reply?.title||message.interactive?.list_reply?.title||null};
  if(type==='button')return {body:message.button?.text||null};
  if(type==='reaction')return message.reaction?.emoji?{body:`[reação ${message.reaction.emoji}]`}:{ignore:true};
  if(type==='contacts')return {body:'[contato]'};
  if(['edited','edit','edited_message'].includes(type))return {body:'[mensagem editada]'};
  const marker={image:'[imagem]',audio:'[áudio]',voice:'[áudio]',video:'[vídeo]',document:'[documento]',location:'[localização]',sticker:'[imagem]'}[type];
  if(marker){const caption=String(message[type]?.caption||'').trim();return {body:caption?`${marker} ${caption}`:marker};}
  return {body:'[tipo não suportado]'};
}
function historyItems(value){
  if(!Array.isArray(value?.history))throw Error('HISTORY_INVALID');
  const business=phone(value.metadata?.display_phone_number),items=[];
  for(const chunk of value.history){
    if(chunk?.errors)continue;
    if(!Array.isArray(chunk?.threads))continue;
    for(const thread of chunk.threads){
      if(!Array.isArray(thread?.messages))continue;
      for(const message of thread.messages){
        if(isGroup(message,thread.id))continue;
        const client=phone(thread.id||message.to),sender=phone(message.from);
        if(!client||!sender){items.push({message,error:'PHONE_INVALID'});continue;}
        items.push({message,phone:client,direction:business&&sender===business?'MCS':sender===client?'CUSTOMER':null,name:thread.name||null});
      }
    }
  }
  return items;
}
function stateContacts(value){
  const state=value?.state_sync,entries=Array.isArray(state)?state:Array.isArray(state?.contacts)?state.contacts:Array.isArray(value?.contacts)?value.contacts:null;
  if(!entries)throw Error('STATE_SYNC_INVALID');
  return entries.flatMap((entry)=>{const contact=entry?.contact||entry;if(entry?.type&&entry.type!=='contact')return [];return [{phone:phone(contact?.phone_number),fullName:String(contact?.full_name||'').trim(),firstName:String(contact?.first_name||'').trim(),action:String(entry.action||''),timestamp:String(entry.metadata?.timestamp||'')}];}).filter((entry)=>entry.phone);
}
function parse(payload){
  if(payload?.event==='history')return {type:'history',items:historyItems(payload.data||{}),addressBook:[],ignoredFields:[]};
  if(payload?.event==='smb_app_state_sync')return {type:'smb_app_state_sync',items:[],addressBook:stateContacts(payload.data||{}),ignoredFields:[]};
  if(payload?.object!=='whatsapp_business_account'||!Array.isArray(payload.entry))return {type:'UNKNOWN',items:[],addressBook:[],ignoredFields:['payload']};
  const items=[],addressBook=[],types=new Set(),ignoredFields=[];
  for(const entry of payload.entry){
    if(!Array.isArray(entry.changes)){ignoredFields.push('changes');continue;}
    for(const change of entry.changes){
      const field=String(change?.field||'UNKNOWN'),value=change?.value||{};
      if(field==='messages'){
        if(Array.isArray(value.messages)){types.add('messages');for(const message of value.messages){
          if(!message||typeof message!=='object'){items.push({message,error:'MESSAGE_INVALID'});continue;}
          if(isGroup(message))continue;
          const who=phone(message.from),contact=(value.contacts||[]).find((row)=>phone(row.wa_id)===who);
          items.push({message,phone:who,direction:'CUSTOMER',name:contact?.profile?.name||null});
        }} else if(!Array.isArray(value.statuses)) ignoredFields.push('messages');
      }else if(field==='smb_message_echoes'){
        types.add(field);if(!Array.isArray(value.message_echoes)){ignoredFields.push(field);continue;}
        for(const message of value.message_echoes){if(!message||typeof message!=='object'){items.push({message,error:'ECHO_INVALID'});continue;}if(isGroup(message))continue;items.push({message,phone:phone(message.to),direction:'MCS',name:null});}
      }else if(field==='history'){types.add(field);try{items.push(...historyItems(value));}catch(_){ignoredFields.push('history inválido');}}
      else if(field==='smb_app_state_sync'){types.add(field);try{addressBook.push(...stateContacts(value));}catch(_){ignoredFields.push('smb_app_state_sync inválido');}}
      else if(field!=='messages'||!Array.isArray(value.statuses))ignoredFields.push(field);
    }
  }
  const type=types.size===1?[...types][0]:types.size?'mixed':ignoredFields.length?'UNKNOWN':'statuses';
  return {type,items,addressBook,ignoredFields:[...new Set(ignoredFields)]};
}
function normalizeParsed(payload){
  const parsed=parse(payload),items=[],itemErrors=[];
  parsed.items.forEach((candidate,index)=>{
    try{
      if(candidate.error)throw Error(candidate.error);
      const {message,phone:clientPhone,direction,name}=candidate,rendered=content(message);
      if(rendered.ignore)return;
      if(!message?.id||!message?.timestamp||!rendered.body||!direction||!clientPhone)throw Error('MESSAGE_CONTENT_INVALID');
      items.push({messageId:String(message.id),phone:clientPhone,name,direction,body:rendered.body,timestamp:String(message.timestamp),refs:extractRefs([{body:rendered.body}]),itemIndex:index});
    }catch(error){itemErrors.push({itemIndex:index,errorCode:/^[A-Z_]{3,50}$/.test(error.message)?error.message:'MESSAGE_CONTENT_INVALID',item:candidate.message||{}});}
  });
  return {...parsed,items,itemErrors};
}
function normalizedItems(payload){return normalizeParsed(payload);}
function eventKey(payload){
  const first=payload?.entry?.[0]?.changes?.[0],array=first?.field==='smb_message_echoes'?first.value?.message_echoes:first?.field==='messages'?first.value?.messages:null;
  if(Array.isArray(array)&&array.length===1&&array[0]?.id)return `${first.field}:${array[0].id}`;
  if(payload?.id&&['history','smb_app_state_sync'].includes(payload.event))return `${payload.event}:${payload.id}`;
  return 'sha256:'+crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}
async function saveAddressBook(ctx,entries){for(const entry of entries)await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/whatsapp_address_book?on_conflict=environment,phone_e164',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({environment:ctx.environment,phone_e164:entry.phone,full_name:entry.fullName||null,first_name:entry.firstName||null,source_action:entry.action||null,source_timestamp:entry.timestamp||null,updated_at:new Date().toISOString()})});}
async function saveItemError(ctx,rawId,error){await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/whatsapp_item_errors?on_conflict=raw_event_id,item_index',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({environment:ctx.environment,raw_event_id:rawId,item_index:error.itemIndex,error_code:error.errorCode,item_json:error.item})});}
async function prepareItem(ctx,rawId,item){
  if(!item.name){const book=await rows(ctx,'whatsapp_address_book',{select:'full_name,first_name',environment:'eq.'+ctx.environment,phone_e164:'eq.'+item.phone,limit:'1'});item={...item,name:book[0]?.full_name||book[0]?.first_name||null};}
  const matches=await rows(ctx,'contact_phones',{select:'contact_id',environment:'eq.'+ctx.environment,phone_e164:'eq.'+item.phone,retired_at:'is.null'});
  const contacts=[...new Set(matches.map((row)=>row.contact_id))];
  if(contacts.length<=1)return {item};
  await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/whatsapp_phone_reviews?on_conflict=raw_event_id,item_index',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({environment:ctx.environment,raw_event_id:rawId,item_index:item.itemIndex,item_json:item,phone_e164:item.phone,candidate_contact_ids:contacts})});
  return {review:true};
}
async function processRaw(ctx,row){
  const claimed=await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+row.id,environment:'eq.'+ctx.environment,status:'in.(PENDING,ERROR)'},{status:'PROCESSING',attempts:(row.attempts||0)+1,error_code:null},true);
  if(!claimed.length)return {skipped:true};
  try{
    const parsed=normalizeParsed(row.payload_json);let imported=0,duplicates=0,reviews=0,itemFailures=0;
    await saveAddressBook(ctx,parsed.addressBook);
    for(const failure of parsed.itemErrors){await saveItemError(ctx,row.id,failure);itemFailures++;}
    for(const item of parsed.items){
      try{
        const prepared=await prepareItem(ctx,row.id,item);if(prepared.review){reviews++;continue;}
        const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_whatsapp_apply_message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_raw:row.id,p_item:prepared.item})});
        if(result.review)reviews++;else if(result.duplicate)duplicates++;else imported++;
      }catch(_){await saveItemError(ctx,row.id,{itemIndex:item.itemIndex,errorCode:'ITEM_PROCESSING_FAILED',item});itemFailures++;}
    }
    const ignored=parsed.ignoredFields.length?`IGNORED:${parsed.ignoredFields.join(',').slice(0,180)}`:itemFailures?'ITEM_ERRORS:'+itemFailures:null;
    await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+row.id,environment:'eq.'+ctx.environment},{status:parsed.type==='UNKNOWN'||parsed.type==='statuses'?'IGNORED':'DONE',event_type:parsed.type,error_code:ignored,processed_at:new Date().toISOString()});
    return {imported,duplicates,reviews,itemErrors:itemFailures,ignoredFields:parsed.ignoredFields};
  }catch(error){
    await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+row.id,environment:'eq.'+ctx.environment},{status:'ERROR',error_code:/^[A-Z_:, -]{3,190}$/.test(error.message)?error.message:'PROCESSING_FAILED'});
    return {error:true};
  }
}
async function rawEvent(ctx,payload){
  const key=eventKey(payload),result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/whatsapp_raw_events?on_conflict=environment,event_key',{method:'POST',headers:{'content-type':'application/json',prefer:'resolution=ignore-duplicates,return=representation'},body:JSON.stringify({environment:ctx.environment,event_key:key,event_type:payload?.event||payload?.entry?.[0]?.changes?.[0]?.field||'UNKNOWN',payload_json:payload})});
  if(result?.length)return result[0];
  const existing=await rows(ctx,'whatsapp_raw_events',{select:'id,status,attempts,payload_json',environment:'eq.'+ctx.environment,event_key:'eq.'+key,limit:'1'});
  return existing[0]?.status==='ERROR'?existing[0]:null;
}
module.exports={phone,content,parse,normalizedItems,eventKey,processRaw,rawEvent,prepareItem};

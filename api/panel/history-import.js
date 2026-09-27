'use strict';

const crypto=require('node:crypto');
const {jsonBody,patchRows,requirePanel,rows,send}=require('../../panel-server');
const {eventKey,processRaw,rawEvent}=require('../../whatsapp-receiver');

const HISTORY_PHONE='13055400742';
const BATCH_LIMIT=10;
const FUNCTION_BUDGET_MS=8000;

function validObject(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||!['history','smb_app_state_sync'].includes(value.event)||typeof value.id!=='string'||!value.id.trim())return false;
  if(!value.data||typeof value.data!=='object'||Array.isArray(value.data))return false;
  if(value.event==='history'&&!Array.isArray(value.data.history))return false;
  if(Object.prototype.hasOwnProperty.call(value.data,'metadata')){
    const shown=String(value.data.metadata?.display_phone_number||'').replace(/\D/g,'');
    if(shown!==HISTORY_PHONE)return false;
  }
  return true;
}

async function existingRow(ctx,payload){
  return (await rows(ctx,'whatsapp_raw_events',{select:'id,event_type,status,attempts,processing_started_at,payload_json',environment:'eq.'+ctx.environment,event_key:'eq.'+eventKey(payload),limit:'1'}))[0]||null;
}

async function importOne(ctx,payload){
  let row=await rawEvent(ctx,payload);
  row=await existingRow(ctx,payload)||row;
  if(!row)throw Error('RAW_EVENT_MISSING');
  if(['DONE','IGNORED'].includes(row.status))return {alreadyExists:1};
  if(row.status==='PROCESSING'){
    if(Date.now()-Date.parse(row.processing_started_at||0)<=120000)return {inProgress:true};
    const reset=await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+row.id,environment:'eq.'+ctx.environment,status:'eq.PROCESSING'},{status:'ERROR',error_code:'PROCESSING_INTERRUPTED',processing_started_at:null},true);
    if(!reset.length)return {inProgress:true};
    row={...row,status:'ERROR',processing_started_at:null};
  }
  if(!['PENDING','ERROR'].includes(row.status))return {alreadyExists:1};
  const result=await processRaw(ctx,row,{sourceKind:'WHATSAPP_HISTORY'});
  if(result.skipped)return {inProgress:true};
  if(result.error)return {errors:1};
  return {conversations:new Set((payload.data?.history||[]).flatMap((chunk)=>chunk.threads||[]).map((thread)=>thread.id).filter(Boolean)).size,imported:Number(result.imported||0),alreadyExists:Number(result.duplicates||0),errors:Number(result.itemErrors||0)};
}

module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{
    const body=await jsonBody(req,850000),items=body?.items;
    if(!Array.isArray(items)||!items.length||items.length>BATCH_LIMIT||!items.every(validObject))return send(res,400,{error:'HISTORY_IMPORT_INVALID'});
    const started=Date.now(),summary={conversations:0,imported:0,alreadyExists:0,errors:0,inProgress:false,more:false,nextIndex:items.length};
    for(let index=0;index<items.length;index++){
      const result=await importOne(ctx,items[index]);
      summary.conversations+=result.conversations||0;summary.imported+=result.imported||0;summary.alreadyExists+=result.alreadyExists||0;summary.errors+=result.errors||0;
      if(result.inProgress)summary.inProgress=true;
      if(Date.now()-started>FUNCTION_BUDGET_MS&&index+1<items.length){summary.more=true;summary.nextIndex=index+1;break;}
    }
    return send(res,200,summary);
  }catch(error){
    const requestId=crypto.randomUUID().slice(0,8);
    console.error('[history-import]',{requestId,route:'/api/panel/history-import',message:String(error?.message||'UNKNOWN'),stack:error?.stack||null});
    return send(res,500,{error:'HISTORY_IMPORT_FAILED',requestId});
  }
};

module.exports.validObject=validObject;
module.exports.importOne=importOne;

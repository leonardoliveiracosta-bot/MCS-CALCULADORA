'use strict';

const {allRows,patchRows,rows}=require('./panel-server');
const {normalizeParsed,processRaw}=require('./whatsapp-receiver');

const unique=(values)=>[...new Set(values.filter(Boolean).map(String))];
const inFilter=(values)=>'in.('+values.map((value)=>'"'+String(value).replaceAll('"','')+'"').join(',')+')';
const errorWamid=(error)=>error?.item_json?.messageId||error?.item_json?.id||null;

async function storedWamids(ctx,wamids){
  const found=new Set();
  for(let index=0;index<wamids.length;index+=50){
    const chunk=wamids.slice(index,index+50);
    const records=await rows(ctx,'whatsapp_message_ids',{select:'wa_message_id',environment:'eq.'+ctx.environment,wa_message_id:inFilter(chunk)});
    records.forEach((record)=>found.add(record.wa_message_id));
  }
  return found;
}

function parsedWamids(payload){
  const parsed=normalizeParsed(payload);
  return unique(parsed.items.map((item)=>item.messageId).concat(parsed.itemErrors.map((error)=>error?.item?.messageId||error?.item?.id)));
}

async function resolveStoredItemErrors(ctx){
  const errors=await allRows(ctx,'whatsapp_item_errors',{select:'id,raw_event_id,item_index,item_json',environment:'eq.'+ctx.environment,status:'neq.RESOLVED'});
  if(!errors.length)return {resolved:0};
  const rawById=new Map();
  for(const rawId of unique(errors.filter((error)=>!errorWamid(error)).map((error)=>error.raw_event_id))){
    const raw=(await rows(ctx,'whatsapp_raw_events',{select:'id,payload_json',environment:'eq.'+ctx.environment,id:'eq.'+rawId,limit:'1'}))[0];
    if(raw)rawById.set(rawId,raw);
  }
  const candidates=errors.map((error)=>{
    let wamid=errorWamid(error);
    if(!wamid){
      const raw=rawById.get(error.raw_event_id);
      if(raw){
        const parsed=normalizeParsed(raw.payload_json);
        wamid=parsed.items.find((item)=>item.itemIndex===error.item_index)?.messageId
          ||parsed.itemErrors.find((item)=>item.itemIndex===error.item_index)?.item?.id||null;
      }
    }
    return {error,wamid};
  }).filter((entry)=>entry.wamid);
  const stored=await storedWamids(ctx,unique(candidates.map((entry)=>entry.wamid)));
  const touchedRaw=new Set();let resolved=0;
  for(const {error,wamid} of candidates){
    if(!stored.has(String(wamid)))continue;
    const changed=await patchRows(ctx,'whatsapp_item_errors',{id:'eq.'+error.id,environment:'eq.'+ctx.environment,status:'neq.RESOLVED'},{status:'RESOLVED',processing_started_at:null,resolved_at:new Date().toISOString()},true);
    if(changed.length){resolved++;touchedRaw.add(error.raw_event_id);}
  }
  for(const rawId of touchedRaw){
    const remaining=await rows(ctx,'whatsapp_item_errors',{select:'id',environment:'eq.'+ctx.environment,raw_event_id:'eq.'+rawId,status:'neq.RESOLVED',limit:'1'});
    if(!remaining.length)await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+rawId,environment:'eq.'+ctx.environment},{error_code:null});
  }
  return {resolved};
}

async function recoverStalledEvents(ctx,options={}){
  const cutoff=new Date(Date.now()-120000).toISOString(),limit=String(options.maxEvents||3);
  // Stuck in PROCESSING, deferred by a deadline, or never started (the webhook answered and its
  // background work was lost): all come back here, oldest first, within the time limit.
  const [processing,deferred,neverStarted]=await Promise.all([
    rows(ctx,'whatsapp_raw_events',{select:'id,event_type,payload_json,status,error_code,attempts,received_at,processing_started_at',environment:'eq.'+ctx.environment,status:'eq.PROCESSING',processing_started_at:'lt.'+cutoff,order:'processing_started_at.asc',limit}),
    rows(ctx,'whatsapp_raw_events',{select:'id,event_type,payload_json,status,error_code,attempts,received_at,processing_started_at',environment:'eq.'+ctx.environment,status:'eq.PENDING',error_code:'eq.PROCESSING_DEFERRED',order:'received_at.asc',limit}),
    rows(ctx,'whatsapp_raw_events',{select:'id,event_type,payload_json,status,error_code,attempts,received_at,processing_started_at',environment:'eq.'+ctx.environment,status:'eq.PENDING',error_code:'is.null',received_at:'lt.'+cutoff,order:'received_at.asc',limit})
  ]);
  const events=[...new Map(processing.concat(deferred,neverStarted).map((event)=>[event.id,event])).values()].sort((left,right)=>(Date.parse(left.received_at)||0)-(Date.parse(right.received_at)||0)).slice(0,Number(limit));
  const result={done:0,reprocessed:0,deferred:0,failed:0};
  for(const original of events){
    // Time limit: an event that would start after the deadline waits for the next cycle.
    if(options.deadlineAt&&Date.now()>=options.deadlineAt)break;
    let event=original;
    const wamids=parsedWamids(event.payload_json);
    if(wamids.length){
      const stored=await storedWamids(ctx,wamids);
      if(stored.size===wamids.length){
        const changed=await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+event.id,environment:'eq.'+ctx.environment,status:'eq.'+event.status},{status:'DONE',error_code:null,processed_at:new Date().toISOString(),processing_started_at:null},true);
        if(changed.length){result.done++;continue;}
      }
    }
    if(Number(event.attempts||0)>=3){
      await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+event.id,environment:'eq.'+ctx.environment,status:'eq.'+event.status},{status:'ERROR',error_code:'PROCESSING_RETRY_LIMIT',processing_started_at:null});
      result.failed++;continue;
    }
    if(event.status==='PROCESSING'){
      const reset=await patchRows(ctx,'whatsapp_raw_events',{id:'eq.'+event.id,environment:'eq.'+ctx.environment,status:'eq.PROCESSING'},{status:'ERROR',error_code:'PROCESSING_INTERRUPTED',processing_started_at:null},true);
      if(!reset.length)continue;
      event={...event,status:'ERROR',error_code:'PROCESSING_INTERRUPTED',processing_started_at:null};
    }
    const processed=await processRaw(ctx,event,{sourceKind:event.event_type==='history'?'WHATSAPP_HISTORY':'WHATSAPP_WEBHOOK',deadlineAt:options.deadlineAt});
    if(processed.pending)result.deferred++;
    else if(processed.error)result.failed++;
    else result.reprocessed++;
    if(options.deadlineAt&&Date.now()>=options.deadlineAt)break;
  }
  return result;
}

module.exports={errorWamid,parsedWamids,recoverStalledEvents,resolveStoredItemErrors,storedWamids};

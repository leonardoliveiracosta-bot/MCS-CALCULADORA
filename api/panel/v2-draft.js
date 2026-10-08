'use strict';

// V2 draft: one AI reading of the journey's conversation that pre-fills the V2 builder screen
// (the note and the WhatsApp message). The operator reviews and edits everything before anything
// is sent: nothing leaves this endpoint toward the client. AI failure keeps the defaults and
// explicitly tells the screen to show a retryable warning.
const {allRows,isUuid,jsonBody,requirePanel,rows,safeText,send}=require('../../panel-server');
const {vehicleName}=require('../../vitrine-domain');
const openAiBudget=require('../../panel-openai-budget');

const MODEL='gpt-6-luna';
const TIMEOUT_MS=25000;
const MAX_MESSAGES=20;

const SYSTEM='You help a car dealer write to a customer in simple, natural American English. Reply ONLY as JSON {"note","message"}. "note" is a short optional note about the car for the customer (max 220 characters, plain facts from the data given, never promises about price, timing or availability). "message" starts exactly with "<Name>, here\'s the car you asked to see" and may add at most one short warm sentence about this car. Never invent details that are not in the data.';

async function draft(ctx,body,services={}){
  const read=services.rows||rows,readAll=services.allRows||allRows;
  if(!isUuid(body.requestId))return {error:'V2_DRAFT_INVALID'};
  const [request]=await read(ctx,'vitrine_requests',{select:'id,vitrine_id,vitrine_car_id,journey_id,request_kind',environment:'eq.'+ctx.environment,id:'eq.'+body.requestId,limit:'1'});
  if(!request)return {error:'V2_DRAFT_REQUEST_NOT_FOUND'};
  const [[vitrine],[car],[journey]]=await Promise.all([
    read(ctx,'vitrines',{select:'id,contact_id,journey_id,reference_code,customer_name',environment:'eq.'+ctx.environment,id:'eq.'+request.vitrine_id,limit:'1'}),
    read(ctx,'vitrine_cars',{select:'id,vehicle_snapshot,customer_limit_cents',environment:'eq.'+ctx.environment,id:'eq.'+request.vitrine_car_id,vitrine_id:'eq.'+request.vitrine_id,limit:'1'}),
    request.journey_id?read(ctx,'journeys',{select:'id,contact_id,budget_cents',environment:'eq.'+ctx.environment,id:'eq.'+request.journey_id,limit:'1'}):Promise.resolve([])
  ]);
  if(!vitrine||!car)return {error:'V2_DRAFT_REQUEST_NOT_FOUND'};
  const [contact]=vitrine.contact_id?await read(ctx,'contacts',{select:'display_name',environment:'eq.'+ctx.environment,id:'eq.'+vitrine.contact_id,limit:'1'}):[];
  const name=String(vitrine.customer_name||contact?.display_name||'').trim().split(/\s+/)[0]||'Hi';
  const carName=vehicleName(car.vehicle_snapshot||{});
  // The journey's own conversation (latest messages, operator's own automatic texts excluded).
  let conversation=[];
  const journeyId=request.journey_id||vitrine.journey_id;
  if(journeyId){
    const links=await readAll(ctx,'message_journeys',{select:'message_id',environment:'eq.'+ctx.environment,journey_id:'eq.'+journeyId,undone_at:'is.null'}).catch(()=>[]);
    const ids=[...new Set(links.map((link)=>link.message_id).filter(Boolean))].slice(-200);
    if(ids.length){
      const messages=await readAll(ctx,'messages',{select:'direction,body_text,occurred_at_utc,created_at',environment:'eq.'+ctx.environment,id:'in.('+ids.join(',')+')',undone_at:'is.null',order:'created_at.desc',limit:String(MAX_MESSAGES)}).catch(()=>[]);
      conversation=messages.filter((message)=>!message.is_automatic&&message.body_text).reverse().map((message)=>({from:message.direction==='CUSTOMER'?'client':'dealer',text:String(message.body_text).slice(0,500)}));
    }
  }
  const limitCents=car.customer_limit_cents||journey?.budget_cents||null;
  const user={car:carName,limitUsd:limitCents?Math.round(Number(limitCents)/100):null,conversation};
  const budget=services.budget||openAiBudget;
  const guard=budget.guard?budget.guard(ctx,'V2_DRAFT','request:'+request.id,services.budgetServices):null;
  const body_={model:MODEL,messages:[{role:'system',content:SYSTEM},{role:'user',content:JSON.stringify({name,...user})}],
    response_format:{type:'json_schema',json_schema:{name:'v2_draft',strict:true,schema:{type:'object',properties:{note:{type:'string'},message:{type:'string'}},required:['note','message'],additionalProperties:false}}}};
  try{
    const out=await budget.paidCall(guard,{modelId:MODEL,body:body_,send:async(capped)=>{
      const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);if(timer.unref)timer.unref();
      try{
        const response=await (services.fetchImpl||fetch)('https://api.openai.com/v1/chat/completions',{method:'POST',signal:controller.signal,headers:{'content-type':'application/json',authorization:'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify(capped)});
        if(!response.ok)throw await budget.openAiFailure(response);
        const payload=await response.json();
        const usage={input:Number(payload?.usage?.prompt_tokens)||0,output:Number(payload?.usage?.completion_tokens)||0};
        return {payload,costUsd:Math.ceil((usage.input*0.10+usage.output*0.50)*1e6)/1e6};
      }catch(failure){if(failure&&failure.name==='AbortError'){const timeout=new Error('OPENAI_TIMEOUT');timeout.code='OPENAI_TIMEOUT';throw timeout;}throw failure;}
      finally{clearTimeout(timer);}
    }});
    let parsed=null;try{parsed=JSON.parse(out.payload?.choices?.[0]?.message?.content||'');}catch(_){parsed=null;}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||typeof parsed.note!=='string'||typeof parsed.message!=='string')return {note:null,message:null,fallback:true};
    if(budget.recorded)await budget.recorded(guard);
    const note=safeText(parsed.note,300)||null,message=safeText(parsed.message,600)||null;
    return {note,message,...(!note&&!message?{fallback:true}:{})};
  }catch(_){return {note:null,message:null,fallback:true};}
}

module.exports=async(req,res)=>{const ctx=await requirePanel(req,res);if(!ctx)return;
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  try{const out=await draft(ctx,await jsonBody(req,4096));
    if(out.error)return send(res,out.error==='V2_DRAFT_REQUEST_NOT_FOUND'?404:400,{error:out.error});
    return send(res,200,{note:out.note,message:out.message,...(out.fallback?{fallback:true}:{})});
  }catch(_){return send(res,500,{error:'V2_DRAFT_UNAVAILABLE'});}};
module.exports.draft=draft;

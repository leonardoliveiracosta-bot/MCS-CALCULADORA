'use strict';

const {allRows,isUuid,jsonBody,patchRows,requirePanel,send}=require('../../panel-server');
const {deposit,vehicleName}=require('../../vitrine-domain');

const since=(value,now=Date.now())=>{
  const elapsed=Math.max(0,now-Date.parse(value||now));
  const minutes=Math.floor(elapsed/60000);
  if(minutes<60)return `há ${minutes||1} min`;
  const hours=Math.floor(minutes/60);
  if(hours<24)return `há ${hours} h`;
  return `há ${Math.floor(hours/24)} dias`;
};

async function payload(ctx){
  const [requests,vitrines,cars,contacts,phones,events,journeys]=await Promise.all([
    allRows(ctx,'vitrine_requests',{select:'id,vitrine_id,vitrine_car_id,contact_id,journey_id,request_kind,referred,created_at,treated_at',environment:'eq.'+ctx.environment,treated_at:'is.null',order:'created_at.desc'}),
    allRows(ctx,'vitrines',{select:'id,contact_id,journey_id,reference_code,customer_name,version,created_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'vitrine_cars',{select:'id,vitrine_id,vehicle_snapshot,customer_limit_cents',environment:'eq.'+ctx.environment}),
    allRows(ctx,'contacts',{select:'id,display_name',environment:'eq.'+ctx.environment}),
    allRows(ctx,'contact_phones',{select:'contact_id,phone_e164,phone_raw,is_primary,is_current,retired_at',environment:'eq.'+ctx.environment}),
    allRows(ctx,'vitrine_events',{select:'vitrine_id,vitrine_car_id,event_type,created_at',environment:'eq.'+ctx.environment,order:'created_at.desc'}),
    allRows(ctx,'journeys',{select:'id,budget_cents',environment:'eq.'+ctx.environment})
  ]);
  const budgetByJourney=new Map(journeys.map((row)=>[row.id,row.budget_cents||null]));
  const vitrinesById=new Map(vitrines.map((row)=>[row.id,row]));
  const carsById=new Map(cars.map((row)=>[row.id,row]));
  const contactsById=new Map(contacts.map((row)=>[row.id,row]));
  const phoneFor=(contactId)=>{const values=phones.filter((row)=>row.contact_id===contactId&&row.is_current!==false&&!row.retired_at);const row=values.find((row)=>row.is_primary)||values[0];return row&&(row.phone_e164||row.phone_raw)||null;};
  const openRequests=requests.map((request)=>{const vitrine=vitrinesById.get(request.vitrine_id)||{};const car=carsById.get(request.vitrine_car_id)||{};const vehicle=car.vehicle_snapshot||{};const contact=contactsById.get(request.contact_id)||{};const limit=car.customer_limit_cents||null,journeyId=request.journey_id||vitrine.journey_id||null;return {id:request.id,vitrineId:request.vitrine_id,vitrineCarId:request.vitrine_car_id,customerLimitCents:limit,budgetCents:journeyId?budgetByJourney.get(journeyId)||null:null,depositUsd:limit?deposit(limit):null,kind:request.request_kind,createdAt:request.created_at,ago:since(request.created_at),referred:Boolean(request.referred),name:contact.display_name||phoneFor(request.contact_id)||'Cliente',phone:phoneFor(request.contact_id),referenceCode:vitrine.reference_code||'',journeyId:request.journey_id||vitrine.journey_id||null,car:vehicleName(vehicle),startsAt:vehicle.startsAt||vehicle.saleDate||null,endsAt:vehicle.endsAt||null,ownerName:vitrine.customer_name||'cliente',ownerRef:vitrine.reference_code||''};});
  const requestsByCar=new Map();
  requests.forEach((request)=>requestsByCar.set(request.vitrine_car_id,true));
  const signals=[];
  vitrines.forEach((vitrine)=>{
    const related=events.filter((event)=>event.vitrine_id===vitrine.id);
    const opened=related.find((event)=>event.event_type==='OPEN');
    if(opened)signals.push({vitrineId:vitrine.id,referenceCode:vitrine.reference_code,kind:'OPEN',text:`abriu o link ${since(opened.created_at)}`});
    related.filter((event)=>event.event_type==='TAP'&&Date.now()-Date.parse(event.created_at)>=15*60*1000&&!requestsByCar.has(event.vitrine_car_id)).slice(0,1).forEach(()=>signals.push({vitrineId:vitrine.id,referenceCode:vitrine.reference_code,kind:'TAP',text:'tocou e não enviou'}));
    if(vitrine.version==='V1'&&Date.now()-Date.parse(vitrine.created_at)>=3*24*60*60*1000&&!related.some((event)=>event.event_type==='TAP'))signals.push({vitrineId:vitrine.id,referenceCode:vitrine.reference_code,kind:'IDLE',text:'V1 enviada há 3 dias, nenhum toque'});
  });
  return {requests:openRequests,signals};
}

module.exports=async(req,res)=>{const ctx=await requirePanel(req,res);if(!ctx)return;try{if(req.method==='GET')return send(res,200,await payload(ctx));if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});const body=await jsonBody(req,4096);if(!isUuid(body.requestId)||!['treat','undo'].includes(body.action))return send(res,400,{error:'VITRINE_REQUEST_INVALID'});await patchRows(ctx,'vitrine_requests',{id:'eq.'+body.requestId,environment:'eq.'+ctx.environment},{treated_at:body.action==='treat'?new Date().toISOString():null});return send(res,200,{ok:true});}catch(_){return send(res,500,{error:'VITRINE_REQUEST_UNAVAILABLE'});}};
module.exports.payload=payload;

'use strict';
const {insert,rows}=require('./panel-server');
const {extractCode,vehicleName}=require('./vitrine-domain');
const {sendVitrinePush}=require('./panel-push');

async function captureVitrineInterest(ctx,item,result){
  if(item.direction!=='CUSTOMER'||!result?.messageId||!result?.contactId)return {handled:false};
  const code=extractCode(item.body); let car=null;
  if(code) car=(await rows(ctx,'vitrine_cars',{select:'id,vitrine_id,short_code,vehicle_snapshot,customer_limit_cents',environment:'eq.'+ctx.environment,short_code:'eq.'+code,limit:'1'}))[0];
  if(!car){
    const candidate=(await rows(ctx,'vitrines',{select:'id,contact_id',environment:'eq.'+ctx.environment,contact_id:'eq.'+result.contactId,expires_at:'gt.'+new Date().toISOString(),order:'created_at.desc',limit:'1'}))[0];
    if(candidate){const event=(await rows(ctx,'vitrine_events',{select:'vitrine_car_id',environment:'eq.'+ctx.environment,vitrine_id:'eq.'+candidate.id,event_type:'eq.TAP',created_at:'gte.'+new Date(Date.now()-15*60*1000).toISOString(),order:'created_at.desc',limit:'1'}))[0];if(event)car=(await rows(ctx,'vitrine_cars',{select:'id,vitrine_id,short_code,vehicle_snapshot,customer_limit_cents',environment:'eq.'+ctx.environment,id:'eq.'+event.vitrine_car_id,limit:'1'}))[0];}
  }
  if(!car)return {handled:false};
  const vitrine=(await rows(ctx,'vitrines',{select:'id,contact_id,journey_id,reference_code,customer_name,version,expires_at',environment:'eq.'+ctx.environment,id:'eq.'+car.vitrine_id,limit:'1'}))[0];
  if(!vitrine||Date.parse(vitrine.expires_at)<=Date.now())return {handled:false};
  const kind=vitrine.version==='V2'?'BID':'VIEW';const referred=vitrine.contact_id!==result.contactId;
  await insert(ctx,'vitrine_requests',{environment:ctx.environment,vitrine_id:vitrine.id,vitrine_car_id:car.id,message_id:result.messageId,contact_id:result.contactId,journey_id:result.journeyId||vitrine.journey_id,request_kind:kind,referred},false).catch(()=>null);
  const person=(await rows(ctx,'contacts',{select:'display_name',environment:'eq.'+ctx.environment,id:'eq.'+result.contactId,limit:'1'}))[0];
  const title=[person?.display_name||item.phone||'Cliente','Ref '+vitrine.reference_code,kind==='BID'?'quer dar lance no '+vehicleName(car.vehicle_snapshot):'quer ver '+vehicleName(car.vehicle_snapshot)].join(' · ');
  await sendVitrinePush(ctx,{messageId:result.messageId,journeyId:result.journeyId||vitrine.journey_id,title}).catch(()=>null);
  return {handled:true,kind};
}
module.exports={captureVitrineInterest};

'use strict';
// A separate, human-created presentation. It never invents a customer message, request or calculator Ref.
const crypto = require('node:crypto');
const {requirePanel,rows,rpc,isUuid,jsonBody,send}=require('../../panel-server');
const state=require('../../panel-manheim-state');
const offer=require('../../manheim-offer');
const {clean,publicVehicle,vehicleName,randomToken,randomCode,expiresAt}=require('../../vitrine-domain');
const {hasValidMmr}=require('../../vehicle-match');
const {parseLimit}=require('./vitrines');
const defaults={rows,rpc};
const failure=(code,status=400)=>Object.assign(Error(code),{code,status});
const eligible=p=>/^[A-HJ-NPR-Z0-9]{17}$/.test(String(p.vin||''))&&hasValidMmr(p)&&p.cleanTitle===true&&p.odometerOk===true&&!offer.carExpired(p);
function phoneOf(raw){
  const text=String(raw||'').trim();if(!text)return null;
  if(!/^[+\d\s().-]+$/.test(text))throw failure('MANUAL_PHONE_INVALID');
  let digits=text.replace(/\D/g,'');if(digits.length===10)digits='1'+digits;
  if(!/^[1-9]\d{7,14}$/.test(digits))throw failure('MANUAL_PHONE_INVALID');
  return '+'+digits;
}
async function inventory(ctx,filters,services){
  const upload=await state.latestActiveUpload(ctx,'id',services);
  if(!upload)throw failure('MANUAL_NO_BATCH',409);
  const list=await services.rows(ctx,'manheim_vehicles',{select:'id,upload_id,vehicle_json',environment:'eq.'+ctx.environment,upload_id:'eq.'+upload.id,...await state.activeFilter(ctx,services),...filters,limit:'250'});
  return offer.groupVehicles(list).filter(row=>eligible(offer.parsedOf(row)));
}
function option(row){const p=offer.parsedOf(row),price=offer.priceFor(p.mmrCents);return {id:row.id,vin:offer.vinOf(row),name:vehicleName(p),vehicle:publicVehicle(p),mmrCents:Number(p.mmrCents),pct:price.pct,referenceCents:price.finalCents};}
async function search(ctx,vin,services=defaults){
  const suffix=String(vin||'').trim().toUpperCase();
  if(!/^[A-HJ-NPR-Z0-9]{6,17}$/.test(suffix))throw failure('MANUAL_VIN_INVALID');
  const cars=await inventory(ctx,{'vehicle_json->>vin':suffix.length===17?'eq.'+suffix:'ilike.*'+suffix},services);
  return {cars:cars.map(option)};
}
async function result(ctx,vitrine,services,allCars){
  const cars=allCars ? allCars.filter(car=>car.vitrine_id===vitrine.id) : await services.rows(ctx,'vitrine_cars',{select:'id,vehicle_snapshot,photo_paths',environment:'eq.'+ctx.environment,vitrine_id:'eq.'+vitrine.id,order:'created_at.asc,id.asc',limit:'10'});
  return {vitrineId:vitrine.id,token:vitrine.token,link:'/v/'+vitrine.token,version:vitrine.version,name:vitrine.customer_name||'',phone:vitrine.recipient_phone||null,createdAt:vitrine.created_at,expiresAt:vitrine.expires_at,cars:cars.map(car=>({id:car.id,name:vehicleName(car.vehicle_snapshot),vinLast6:String(car.vehicle_snapshot?.vin||'').slice(-6),photoCount:(car.photo_paths||[]).length}))};
}
function normalized(body){
  if(!body||typeof body!=='object')throw failure('MANUAL_INVALID');
  if(!['V1','V2'].includes(body.version)||!isUuid(body.requestKey))throw failure('MANUAL_INVALID');
  if(!Array.isArray(body.cars)||!body.cars.length||body.cars.length>(body.version==='V2'?1:10))throw failure('MANUAL_CARS_INVALID');
  const cars=body.cars.map(car=>{if(!isUuid(car.id))throw failure('MANUAL_CARS_INVALID');const pct=car.pct===undefined?null:offer.validPct(car.pct);if(Number.isNaN(pct))throw failure('MANUAL_PRICE_INVALID');return {id:car.id,pct};});
  if(new Set(cars.map(car=>car.id)).size!==cars.length)throw failure('MANUAL_CARS_INVALID');
  const limit=body.version==='V2'?parseLimit(body.customerLimitCents):null;if(limit===false)throw failure('VITRINE_LIMIT_INVALID');
  return {version:body.version,name:clean(body.name,80)||null,phone:phoneOf(body.phone),cars,limit,note:body.version==='V2'?clean(body.note,800)||null:null};
}
async function create(ctx,body,services=defaults){
  const value=normalized(body),hash=crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const [prior]=await services.rows(ctx,'vitrines',{select:'*',environment:'eq.'+ctx.environment,created_by:'eq.'+ctx.panel.id,manual_request_id:'eq.'+body.requestKey,limit:'1'});
  if(prior){if(prior.manual_payload_hash!==hash)throw failure('MANUAL_DRAFT_CHANGED',409);return {...await result(ctx,prior,services),reused:true};}
  const selected=await inventory(ctx,{id:'in.('+value.cars.map(car=>car.id).join(',')+')'},services);
  if(selected.length!==value.cars.length)throw failure('MANUAL_CAR_UNAVAILABLE',409);
  const vins=selected.map(offer.vinOf);if(new Set(vins).size!==vins.length)throw failure('VITRINE_VIN_DUPLICATE');
  // Reload all sale options for the selected physical cars; every field comes from the live import.
  const current=await inventory(ctx,{'vehicle_json->>vin':'in.('+vins.join(',')+')'},services);
  const cars=value.cars.map(selection=>{
    const original=selected.find(row=>row.id===selection.id),row=current.find(row=>offer.vinOf(row)===offer.vinOf(original));
    if(!row)throw failure('MANUAL_CAR_UNAVAILABLE',409);
    const p=offer.parsedOf(row),price=offer.priceFor(p.mmrCents,selection.pct);
    return {short_code:randomCode(),vehicle_snapshot:{...publicVehicle(p),averageAuctionValue:null,estimatedMarketReference:price.finalCents/100,vin:offer.vinOf(row),manualSourceIds:p.memberMatchIds||[row.id]},customer_limit_cents:value.limit,note_text:value.note,photo_paths:[]};
  });
  const saved=await services.rpc(ctx,'panel_manual_vitrine_create',{p_environment:ctx.environment,p_actor:ctx.panel.id,p_request:body.requestKey,p_hash:hash,p_vitrine:{token:randomToken(),version:value.version,customer_name:value.name,recipient_phone:value.phone,expires_at:expiresAt(cars)},p_cars:cars});
  return result(ctx,saved,services);
}
async function history(ctx,version,services=defaults){
  const list=await services.rows(ctx,'vitrines',{select:'*',environment:'eq.'+ctx.environment,version:version==='V2'?'eq.V2':'eq.V1',manual_request_id:'not.is.null',order:'created_at.desc',limit:'20'});
  const cars=list.length?await services.rows(ctx,'vitrine_cars',{select:'id,vitrine_id,vehicle_snapshot,photo_paths',environment:'eq.'+ctx.environment,vitrine_id:'in.('+list.map(row=>row.id).join(',')+')',order:'created_at.asc,id.asc',limit:'200'}):[];
  return {items:await Promise.all(list.map(vitrine=>result(ctx,vitrine,services,cars)))};
}
module.exports=async(req,res)=>{
  const ctx=await requirePanel(req,res);if(!ctx)return;
  try{
    if(req.method==='GET')return send(res,200,req.query?.vin?await search(ctx,req.query.vin):await history(ctx,req.query?.version));
    if(req.method==='POST')return send(res,201,await create(ctx,await jsonBody(req,16384)));
    return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  }catch(error){return send(res,error.status||(['MANUAL_DRAFT_CHANGED'].includes(error.code)?409:500),{error:error.code||'MANUAL_UNAVAILABLE'});}
};
module.exports.refreshVehicle=async(ctx,snapshot,services=defaults)=>{
  const ids=Array.isArray(snapshot.manualSourceIds)?snapshot.manualSourceIds.filter(isUuid):[];
  if(!ids.length)return null;
  const matches=await inventory(ctx,{id:'in.('+ids.join(',')+')'},services);
  const found=matches.find(row=>offer.vinOf(row)===String(snapshot.vin||''));
  return found?{...snapshot,purchaseOptions:publicVehicle(offer.parsedOf(found)).purchaseOptions}:null;
};
module.exports.search=search;module.exports.create=create;module.exports.history=history;module.exports.phoneOf=phoneOf;

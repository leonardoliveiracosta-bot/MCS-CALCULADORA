'use strict';
const {insert,isUuid,jsonBody,patchRows,requirePanel,rows,safeText,send}=require('../../panel-server');
const {expiresAt,publicVehicle,randomCode,randomToken,vehicleName}=require('../../vitrine-domain');
const {parseMoneyCents}=require('../../money-text');
const {activeFilter}=require('../../panel-manheim-state');
// An undone Manheim import batch never feeds a new V1 or V2 (vitrines already created stay).
const activeBatch=async(ctx,services)=>services.activeFilter?services.activeFilter(ctx):activeFilter(ctx,{rows:services.rows||rows}).catch(()=>({}));

// MANHEIM_MATCH_AUDIT: with the audit on, a V1 or V2 comes only from a demand that was conferida
// (or approved by hand with a reason). Only that demand is held; the others stay usable. Off:
// nothing changes. A match of an older batch is held only when its own audit says so.
async function auditGate(ctx,matchIds){
  const manheimAudit=require('../../panel-manheim-audit');
  if(manheimAudit.status()!=='LIGADA')return null;
  const {manheimView}=require('../../panel-buscas-view');
  const input=await manheimView(ctx,{auditInput:true});
  const state=await manheimAudit.viewState(ctx,input);
  const live=new Map((input.matches||[]).map((match)=>[match.id,match]));
  for(const id of matchIds){
    const match=live.get(id);
    if(match){const entry=state.byDemand[match.demandKey];if(!entry||!manheimAudit.usable(entry))return 'MANHEIM_AUDIT_PENDING';continue;}
    const [stored]=await rows(ctx,'manheim_matches',{select:'upload_id,journey_id,logical_mode',environment:'eq.'+ctx.environment,id:'eq.'+id,limit:'1'});
    if(!stored||!stored.journey_id||!stored.logical_mode)continue;
    const [last]=await rows(ctx,'manheim_match_audits',{select:'status',environment:'eq.'+ctx.environment,upload_id:'eq.'+stored.upload_id,demand_key:'eq.journey:'+stored.journey_id+':'+stored.logical_mode,order:'created_at.desc',limit:'1'}).catch(()=>[]);
    if(last&&!manheimAudit.usable(last))return 'MANHEIM_AUDIT_PENDING';
  }
  return null;
}

// Public limit of a vitrine car: between US$ 1.000 and US$ 10.000.000 (customer_limit_cents is an integer).
const LIMIT_MIN_CENTS=100000;
const LIMIT_MAX_CENTS=1000000000;
// A retry within this window returns the vitrine already created instead of a duplicate.
const DEDUPE_MS=10*60*1000;

async function uniqueCode(ctx,services={rows}){ for(let i=0;i<20;i++){const code=randomCode();const found=await services.rows(ctx,'vitrine_cars',{select:'id',environment:'eq.'+ctx.environment,short_code:'eq.'+code,limit:'1'});if(!found[0])return code;} throw Error('VITRINE_CODE_EXHAUSTED'); }

/* Limit typed by the operator. A number is cents; a string is money text ("20,000", "20k", "US$ 20.000")
   read by parseMoneyCents. Returns cents, null (no limit: the block is hidden) or false (invalid). */
function parseLimit(value){
  if(value===null||value===undefined||value==='')return null;
  let cents=null;
  if(typeof value==='number')cents=Math.round(value);
  else if(typeof value==='string')cents=parseMoneyCents(value);
  else return false;
  return Number.isFinite(cents)&&cents>=LIMIT_MIN_CENTS&&cents<=LIMIT_MAX_CENTS?cents:false;
}
const carKey=(car)=>car.source_match_id?'match:'+car.source_match_id:'snapshot:'+JSON.stringify(car.vehicle_snapshot||null);
const sameSet=(left,right)=>left.length===right.length&&[...left].sort().join('|')===[...right].sort().join('|');
async function recentWithCars(ctx,filters,keys,services,now){
  const recent=await services.rows(ctx,'vitrines',{select:'id,token,reference_code,created_at',environment:'eq.'+ctx.environment,...filters,created_at:'gte.'+new Date(now-DEDUPE_MS).toISOString(),order:'created_at.desc',limit:'5'});
  for(const vitrine of recent||[]){
    const cars=await services.rows(ctx,'vitrine_cars',{select:'id,source_match_id,vehicle_snapshot',environment:'eq.'+ctx.environment,vitrine_id:'eq.'+vitrine.id});
    if(cars.length&&sameSet(cars.map(carKey),keys))return {vitrine,cars};
  }
  return null;
}

/* V1. The vitrines table has no jsonb column to keep a client requestId, so a retry is recognized by
   the same journey + the same set of cars within 10 minutes. requestId is accepted (uuid) but not stored. */
async function create(ctx,body,services={rows,insert},now=Date.now()){
  if(!isUuid(body.journeyId)||!Array.isArray(body.matchIds)||!body.matchIds.length||body.matchIds.length>12)return null;
  if(body.requestId!==undefined&&body.requestId!==null&&!isUuid(body.requestId))return null;
  if(new Set(body.matchIds).size!==body.matchIds.length)return null;
  // A26: the public limit is the maximum bid (journeys.budget_cents), never confirmed_total_ceiling_cents.
  const [journey]=await services.rows(ctx,'journeys',{select:'id,contact_id,reference_code,budget_cents',environment:'eq.'+ctx.environment,id:'eq.'+body.journeyId,limit:'1'});
  if(!journey)return null;
  const active=await activeBatch(ctx,services);
  const [contact,...matches]=await Promise.all([services.rows(ctx,'contacts',{select:'display_name',environment:'eq.'+ctx.environment,id:'eq.'+journey.contact_id,limit:'1'}),...body.matchIds.map((id)=>isUuid(id)?services.rows(ctx,'manheim_matches',{select:'id,vehicle_json',environment:'eq.'+ctx.environment,id:'eq.'+id,journey_id:'eq.'+journey.id,...active,limit:'1'}):Promise.resolve([]))]);
  const selected=matches.flat(); if(selected.length!==body.matchIds.length)return null;
  const held=await (services.auditGate||auditGate)(ctx,selected.map((match)=>match.id)); if(held)return {error:held};
  const cars=selected.map((match)=>({match,vehicle:publicVehicle(match.vehicle_json?.parsed||{})}));
  const existing=await recentWithCars(ctx,{journey_id:'eq.'+journey.id,version:'eq.V1'},selected.map((match)=>'match:'+match.id),services,now);
  if(existing)return {token:existing.vitrine.token,link:'/v/'+existing.vitrine.token,referenceCode:journey.reference_code,cars:cars.map((item)=>vehicleName(item.vehicle)),reused:true};
  const token=randomToken(); const created=await services.insert(ctx,'vitrines',{environment:ctx.environment,token,journey_id:journey.id,contact_id:journey.contact_id,reference_code:journey.reference_code||'',customer_name:contact[0]?.display_name||null,version:'V1',expires_at:expiresAt(cars),created_by:ctx.panel.id});
  const vitrine=created[0];
  for(const car of cars) await services.insert(ctx,'vitrine_cars',{environment:ctx.environment,vitrine_id:vitrine.id,source_match_id:car.match.id,short_code:await uniqueCode(ctx,services),vehicle_snapshot:car.vehicle,customer_limit_cents:journey.budget_cents||null,photo_paths:[]},false);
  return {token,link:'/v/'+token,referenceCode:journey.reference_code,cars:cars.map((item)=>vehicleName(item.vehicle))};
}
/* V2: vitrine NOVA (token novo) so com o carro pedido, ligada a V1 de origem.
   A V1 nunca e alterada: o link V1 do cliente continua sendo V1.
   Limite padrao: journeys.budget_cents (lance maximo), so quando esta na faixa valida.
   Retorna centavos, null (sem limite) ou false (valor invalido). */
function limitCents(body,journey){
  if(!Object.hasOwn(body,'customerLimitCents')){const fallback=parseLimit(journey?.budget_cents??null);return fallback===false?null:fallback;}
  return parseLimit(body.customerLimitCents);
}
async function createV2(ctx,body,services={rows,insert,patchRows},now=Date.now()){
  if(!isUuid(body.requestId))return {error:'VITRINE_V2_INVALID'};
  const [request]=await services.rows(ctx,'vitrine_requests',{select:'id,vitrine_id,vitrine_car_id,treated_at',environment:'eq.'+ctx.environment,id:'eq.'+body.requestId,limit:'1'});
  if(!request)return {error:'VITRINE_REQUEST_NOT_FOUND'};
  if(request.treated_at)return {error:'VITRINE_REQUEST_TREATED'};
  const [[origin],[car]]=await Promise.all([
    services.rows(ctx,'vitrines',{select:'id,journey_id,contact_id,reference_code,customer_name',environment:'eq.'+ctx.environment,id:'eq.'+request.vitrine_id,limit:'1'}),
    services.rows(ctx,'vitrine_cars',{select:'id,vitrine_id,source_match_id,vehicle_snapshot',environment:'eq.'+ctx.environment,id:'eq.'+request.vitrine_car_id,vitrine_id:'eq.'+request.vitrine_id,limit:'1'})
  ]);
  if(!origin)return {error:'VITRINE_NOT_FOUND'};
  if(!car||!car.vehicle_snapshot)return {error:'VITRINE_CAR_MISSING'};
  if(car.source_match_id){const held=await (services.auditGate||auditGate)(ctx,[car.source_match_id]);if(held)return {error:held};}
  if(car.source_match_id){const active=await activeBatch(ctx,services);if(Object.keys(active).length){const [live]=await services.rows(ctx,'manheim_matches',{select:'id',environment:'eq.'+ctx.environment,id:'eq.'+car.source_match_id,...active,limit:'1'});if(!live)return {error:'VITRINE_SOURCE_UNDONE'};}}
  // A26: budget_cents is the maximum bid; confirmed_total_ceiling_cents is a total cost and is never read here.
  const [journey]=origin.journey_id?await services.rows(ctx,'journeys',{select:'id,budget_cents',environment:'eq.'+ctx.environment,id:'eq.'+origin.journey_id,limit:'1'}):[];
  const limit=limitCents(body,journey);
  if(limit===false)return {error:'VITRINE_LIMIT_INVALID'};
  const note=safeText(body.noteText,1200)||null;
  // A22: a retry (for example after a photo upload failed) reuses the V2 made from the same V1 and car.
  const existing=await recentWithCars(ctx,{parent_vitrine_id:'eq.'+origin.id,version:'eq.V2'},[carKey(car)],services,now);
  if(existing){
    const reusedCar=existing.cars[0];
    if(services.patchRows)await services.patchRows(ctx,'vitrine_cars',{id:'eq.'+reusedCar.id,environment:'eq.'+ctx.environment,vitrine_id:'eq.'+existing.vitrine.id},{customer_limit_cents:limit,note_text:note});
    return {token:existing.vitrine.token,link:'/v/'+existing.vitrine.token,vitrineId:existing.vitrine.id,carId:reusedCar.id,reused:true};
  }
  const token=randomToken();
  const created=await services.insert(ctx,'vitrines',{environment:ctx.environment,token,version:'V2',parent_vitrine_id:origin.id,journey_id:origin.journey_id,contact_id:origin.contact_id,reference_code:origin.reference_code||'',customer_name:origin.customer_name||null,expires_at:expiresAt([car.vehicle_snapshot]),created_by:ctx.panel.id});
  const vitrine=created[0];
  const [newCar]=await services.insert(ctx,'vitrine_cars',{environment:ctx.environment,vitrine_id:vitrine.id,source_match_id:car.source_match_id||null,short_code:await uniqueCode(ctx,services),vehicle_snapshot:car.vehicle_snapshot,customer_limit_cents:limit,note_text:note,photo_paths:[]});
  return {token,link:'/v/'+token,vitrineId:vitrine.id,carId:newCar.id};
}
async function update(ctx,body,services={rows,patchRows}){
  if(!safeText(body.token,100,true))return null; const list=await services.rows(ctx,'vitrines',{select:'id',environment:'eq.'+ctx.environment,token:'eq.'+body.token,limit:'1'});if(!list[0])return null;
  // Validate every car before writing anything.
  const patches=[];
  if(Array.isArray(body.cars)) for(const item of body.cars){ if(!isUuid(item.id))continue; const patch={};if(Object.hasOwn(item,'customerLimitCents')){const value=parseLimit(item.customerLimitCents);if(value===false)return {error:'VITRINE_LIMIT_INVALID'};patch.customer_limit_cents=value;}if(Object.hasOwn(item,'note'))patch.note_text=safeText(item.note,1200)||null;if(Object.keys(patch).length)patches.push([item.id,patch]); }
  const version=body.version==='V2'?'V2':'V1'; await services.patchRows(ctx,'vitrines',{id:'eq.'+list[0].id,environment:'eq.'+ctx.environment},{version,updated_at:new Date().toISOString()});
  for(const [id,patch] of patches)await services.patchRows(ctx,'vitrine_cars',{id:'eq.'+id,environment:'eq.'+ctx.environment,vitrine_id:'eq.'+list[0].id},patch);
  return {token:body.token,link:'/v/'+body.token,version};
}
const statusFor=(error)=>error==='VITRINE_REQUEST_NOT_FOUND'||error==='VITRINE_NOT_FOUND'?404:error==='VITRINE_REQUEST_TREATED'||error==='VITRINE_SOURCE_UNDONE'||error==='MANHEIM_AUDIT_PENDING'?409:400;
module.exports=async(req,res)=>{const ctx=await requirePanel(req,res);if(!ctx)return;try{if(req.method==='POST'){const body=await jsonBody(req,65536);if(body.action==='create_v2'||(body.requestId&&!body.journeyId)){const out=await createV2(ctx,body);return out.error?send(res,statusFor(out.error),{error:out.error}):send(res,out.reused?200:201,out);}const out=await create(ctx,body);if(out&&out.error)return send(res,statusFor(out.error),{error:out.error});return out?send(res,out.reused?200:201,out):send(res,400,{error:'VITRINE_CREATE_INVALID'});}if(req.method==='PATCH'){const out=await update(ctx,await jsonBody(req,65536));return out?.error?send(res,400,{error:out.error}):out?send(res,200,out):send(res,400,{error:'VITRINE_UPDATE_INVALID'});}return send(res,405,{error:'METHOD_NOT_ALLOWED'});}catch(error){return send(res,500,{error:'VITRINE_UNAVAILABLE'});}};
module.exports.create=create;
module.exports.auditGate=auditGate;
module.exports.createV2=createV2;
module.exports.update=update;
module.exports.limitCents=limitCents;
module.exports.parseLimit=parseLimit;

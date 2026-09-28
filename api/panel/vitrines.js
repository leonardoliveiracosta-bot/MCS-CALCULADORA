'use strict';
const {allRows,insert,isUuid,jsonBody,patchRows,requirePanel,rows,safeText,send}=require('../../panel-server');
const {expiresAt,publicVehicle,randomCode,randomToken,vehicleName}=require('../../vitrine-domain');

async function uniqueCode(ctx){ for(let i=0;i<20;i++){const code=randomCode();const found=await rows(ctx,'vitrine_cars',{select:'id',environment:'eq.'+ctx.environment,short_code:'eq.'+code,limit:'1'});if(!found[0])return code;} throw Error('VITRINE_CODE_EXHAUSTED'); }
async function create(ctx,body){
  if(!isUuid(body.journeyId)||!Array.isArray(body.matchIds)||!body.matchIds.length||body.matchIds.length>12)return null;
  const [journey]=await rows(ctx,'journeys',{select:'id,contact_id,reference_code,budget_cents',environment:'eq.'+ctx.environment,id:'eq.'+body.journeyId,limit:'1'});
  if(!journey)return null;
  const [contact,...matches]=await Promise.all([rows(ctx,'contacts',{select:'display_name',environment:'eq.'+ctx.environment,id:'eq.'+journey.contact_id,limit:'1'}),...body.matchIds.map((id)=>isUuid(id)?rows(ctx,'manheim_matches',{select:'id,vehicle_json',environment:'eq.'+ctx.environment,id:'eq.'+id,journey_id:'eq.'+journey.id,limit:'1'}):Promise.resolve([]))]);
  const selected=matches.flat(); if(selected.length!==body.matchIds.length)return null;
  const cars=selected.map((match)=>({match,vehicle:publicVehicle(match.vehicle_json?.parsed||{})}));
  const token=randomToken(); const created=await insert(ctx,'vitrines',{environment:ctx.environment,token,journey_id:journey.id,contact_id:journey.contact_id,reference_code:journey.reference_code||'',customer_name:contact[0]?.display_name||null,version:'V1',expires_at:expiresAt(cars),created_by:ctx.panel.id});
  const vitrine=created[0];
  for(const car of cars) await insert(ctx,'vitrine_cars',{environment:ctx.environment,vitrine_id:vitrine.id,source_match_id:car.match.id,short_code:await uniqueCode(ctx),vehicle_snapshot:car.vehicle,customer_limit_cents:journey.budget_cents||null,photo_paths:[]},false);
  return {token,link:'/v/'+token,referenceCode:journey.reference_code,cars:cars.map((item)=>vehicleName(item.vehicle))};
}
async function update(ctx,body){
  if(!safeText(body.token,100,true))return null; const list=await rows(ctx,'vitrines',{select:'id',environment:'eq.'+ctx.environment,token:'eq.'+body.token,limit:'1'});if(!list[0])return null;
  const version=body.version==='V2'?'V2':'V1'; await patchRows(ctx,'vitrines',{id:'eq.'+list[0].id,environment:'eq.'+ctx.environment},{version,updated_at:new Date().toISOString()});
  if(Array.isArray(body.cars)) for(const item of body.cars){ if(!isUuid(item.id))continue; const patch={};if(Object.hasOwn(item,'customerLimitCents'))patch.customer_limit_cents=Math.max(0,Math.round(Number(item.customerLimitCents)||0))||null;if(Object.hasOwn(item,'note'))patch.note_text=safeText(item.note,1200)||null;if(Object.keys(patch).length)await patchRows(ctx,'vitrine_cars',{id:'eq.'+item.id,environment:'eq.'+ctx.environment,vitrine_id:'eq.'+list[0].id},patch); }
  return {token:body.token,link:'/v/'+body.token,version};
}
module.exports=async(req,res)=>{const ctx=await requirePanel(req,res);if(!ctx)return;try{if(req.method==='POST'){const out=await create(ctx,await jsonBody(req,65536));return out?send(res,201,out):send(res,400,{error:'VITRINE_CREATE_INVALID'});}if(req.method==='PATCH'){const out=await update(ctx,await jsonBody(req,65536));return out?send(res,200,out):send(res,400,{error:'VITRINE_UPDATE_INVALID'});}return send(res,405,{error:'METHOD_NOT_ALLOWED'});}catch(error){return send(res,500,{error:'VITRINE_UNAVAILABLE'});}};

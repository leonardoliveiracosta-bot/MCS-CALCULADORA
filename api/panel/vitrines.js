'use strict';
const {insert,isUuid,jsonBody,patchRows,requirePanel,rows,rpc,safeText,send}=require('../../panel-server');
const grouping=require('../../manheim-offer');
async function groupedFor(ctx,matches,services){
  if(services.groupedMatches)return services.groupedMatches(ctx,matches);
  if(services.rows===rows)return rpc(ctx,'panel_manheim_grouped_matches',{p_environment:ctx.environment,p_match_ids:matches.map(m=>m.id)});
  return grouping.groupVehicles(matches);
}
const {expiresAt,publicVehicle,publicResponse,randomCode,randomToken,vehicleName}=require('../../vitrine-domain');
const {parseMoneyCents}=require('../../money-text');
const {activeFilter,liveUploadFilter}=require('../../panel-manheim-state');
const {hasValidMmr}=require('../../vehicle-match');
const {journeyBlock}=require('../../panel-opt-out');
// An undone Manheim import batch never feeds a new V1 or V2 (vitrines already created stay).
const activeBatch=async(ctx,services)=>services.activeFilter?services.activeFilter(ctx):activeFilter(ctx,{rows:services.rows||rows}).catch(()=>({}));
// A match counts only while its import batch is live: activated after its last block and not undone.
async function batchesLive(ctx,uploadIds,services){
  const ids=[...new Set(uploadIds.filter(Boolean))];if(!ids.length)return true;
  const filter=services.liveUploadFilter?await services.liveUploadFilter(ctx):await liveUploadFilter(ctx,{rows:services.rows||rows}).catch(()=>({}));
  if(!Object.keys(filter).length)return true;
  const found=await services.rows(ctx,'manheim_uploads',{select:'id',environment:'eq.'+ctx.environment,id:'in.('+ids.join(',')+')',...filter,limit:String(ids.length)});
  return found.length===ids.length;
}

// MANHEIM_MATCH_AUDIT: with the audit on, a V1 or V2 comes only from a demand that was conferida
// (or approved by hand with a reason). Only that demand is held; the others stay usable. Off:
// nothing changes. A match of an older batch is held only when its own audit says so.
// demandKey (from the BUSCAS card) checks exactly that demand. Without it (V2), every demand the
// car belongs to must be released: a car that fits VALOR and CARRO appears once per demand.
async function auditGate(ctx,matchIds,demandKey=null){
  const manheimAudit=require('../../panel-manheim-audit');
  if(manheimAudit.status()!=='LIGADA')return null;
  const {manheimView}=require('../../panel-buscas-view');
  const input=await manheimView(ctx,{auditInput:true});
  const state=await manheimAudit.viewState(ctx,input);
  for(const id of matchIds){
    const held=manheimAudit.heldFor(state,input.matches,id,demandKey);
    if(held===true)return 'MANHEIM_AUDIT_PENDING';
    if(held===false)continue;
    const [stored]=await rows(ctx,'manheim_matches',{select:'upload_id,journey_id,logical_mode',environment:'eq.'+ctx.environment,id:'eq.'+id,limit:'1'});
    if(!stored||!stored.journey_id||!stored.logical_mode)continue;
    const [last]=await rows(ctx,'manheim_match_audits',{select:'status',environment:'eq.'+ctx.environment,upload_id:'eq.'+stored.upload_id,demand_key:'eq.journey:'+stored.journey_id+':'+stored.logical_mode,order:'created_at.desc',limit:'1'}).catch(()=>[]);
    if(last&&!manheimAudit.usable(last))return 'MANHEIM_AUDIT_PENDING';
  }
  return null;
}

// Match interno não é opção: um carro só entra em V1/V2 depois de selecionado pelo operador
// (manheim_option_selections, migração 20261006010000). Returns Map(matchId -> selection) or an error.
async function selectedFor(ctx,matchIds,services){
  const reader=services.selectionRows||services.rows;
  const groups=services.rows===rows?await groupedFor(ctx,matchIds.map(id=>({id})),services):[];
  const members=id=>groups.find(g=>(g.vehicle_json?.parsed?.memberMatchIds||[g.id]).includes(id))?.vehicle_json?.parsed?.memberMatchIds||[id];
  const ids=[...new Set(matchIds.flatMap(members))];
  let found;
  try{found=await reader(ctx,'manheim_option_selections',{select:'match_id,status,final_cents,manual,client_reason',environment:'eq.'+ctx.environment,match_id:'in.('+ids.join(',')+')',limit:String(ids.length)});}
  catch(error){if(error&&(error.status===404||error.status===400))return {error:'MANHEIM_SELECTION_PENDING'};throw error;}
  const byId=new Map(matchIds.map(id=>[id,(found||[]).find(row=>row.status==='SELECTED'&&members(id).includes(row.match_id))]).filter(([,row])=>row));
  return matchIds.every((id)=>byId.has(id))?{byId}:{error:'MANHEIM_OPTION_NOT_SELECTED'};
}
// The customer sees one honest reference: the MMR plus the operator's markup. Never the MMR itself
// nor the percentage.
// "Por que este carro" (written by the operator for the customer) goes with the car; the internal note never does.
const priced=(vehicle,selection)=>({...vehicle,averageAuctionValue:null,estimatedMarketReference:Math.round(grouping.clientCents(selection.final_cents)/100),selected:true,...(typeof selection.client_reason==='string'&&selection.client_reason.trim()?{whyChosen:selection.client_reason.trim().slice(0,300)}:{})});

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
  // Never a V1 for someone who asked not to be contacted, a closed/switched-off case, a discarded
  // person or "não é lead" (A11).
  const block=await journeyBlock(ctx,journey.id,services.rows).catch(()=>null);
  if(block)return {error:'VITRINE_CONTACT_BLOCKED',reason:block};
  const active=await activeBatch(ctx,services);
  const [contact,...matches]=await Promise.all([services.rows(ctx,'contacts',{select:'display_name',environment:'eq.'+ctx.environment,id:'eq.'+journey.contact_id,limit:'1'}),...body.matchIds.map((id)=>isUuid(id)?services.rows(ctx,'manheim_matches',{select:'id,upload_id,vehicle_json',environment:'eq.'+ctx.environment,id:'eq.'+id,journey_id:'eq.'+journey.id,...active,limit:'1'}):Promise.resolve([]))]);
  const original=matches.flat(); if(original.length!==body.matchIds.length)return null;
  if(original.some(match=>!hasValidMmr(match.vehicle_json?.parsed)))return {error:'MANHEIM_MATCH_WITHOUT_MMR'};
  const vins=original.map(grouping.vinOf).filter(Boolean);
  if(new Set(vins).size!==vins.length)return {error:'VITRINE_VIN_DUPLICATE'};
  const grouped=await groupedFor(ctx,original,services);
  // Leilão passado (migração 20261027010000): o carro saiu das opções e da seleção e não entra na V1; a
  // resposta diz quais saíram. Carro que sumiu por outro motivo continua recusando a V1 inteira.
  const covers=(match,id)=>(match.vehicle_json?.parsed?.memberMatchIds||[match.id]).includes(id);
  const missing=original.filter((match)=>!grouped.some((row)=>covers(row,match.id)));
  if(missing.some((match)=>!grouping.carExpired(match.vehicle_json?.parsed||{})))return {error:'MANHEIM_SALE_ENDED'};
  const ended=[...missing,...grouped.filter((match)=>grouping.carExpired(match.vehicle_json?.parsed||{}))];
  const removed=ended.map((match)=>vehicleName(match.vehicle_json?.parsed||{}));
  const selected=grouped.filter((match)=>!grouping.carExpired(match.vehicle_json?.parsed||{}));
  if(!selected.length)return {error:'MANHEIM_SALE_ENDED',removed};
  const removedOut=removed.length?{removed}:{};
  if(!(await batchesLive(ctx,selected.map((match)=>match.upload_id),services)))return null;
  // MMR is mandatory: a car without a valid MMR never goes into a V1.
  if(selected.some((match)=>!hasValidMmr(match.vehicle_json?.parsed)))return {error:'MANHEIM_MATCH_WITHOUT_MMR'};
  const demandKey=typeof body.demandKey==='string'&&/^journey:[0-9a-f-]{36}:(VALOR|CARRO)$/.test(body.demandKey)?body.demandKey:null;
  const held=await (services.auditGate||auditGate)(ctx,selected.map((match)=>match.id),demandKey); if(held)return {error:held};
  // Provenance stamp: every car must still fit the current criteria of its request in the active lot (recomputed now).
  const stampGate=services.stampGate||(services.rows===rows?require('../../panel-option-stamp').gate:null);
  if(stampGate){const stale=await stampGate(ctx,selected.map((match)=>match.id));if(stale)return {error:stale.code,reason:stale.reason,text:stale.text};}
  const selection=await selectedFor(ctx,selected.map((match)=>match.id),services); if(selection.error)return {error:selection.error};
  const cars=selected.map((match)=>({match,vehicle:{...priced(publicVehicle(match.vehicle_json?.parsed||{}),selection.byId.get(match.id)),vin:grouping.vinOf(match)}}));
  const existing=await recentWithCars(ctx,{journey_id:'eq.'+journey.id,version:'eq.V1'},selected.map((match)=>'match:'+match.id),services,now);
  if(existing)return {token:existing.vitrine.token,link:'/v/'+existing.vitrine.token,referenceCode:journey.reference_code,cars:cars.map((item)=>vehicleName(item.vehicle)),reused:true,...removedOut};
  const token=randomToken(); const created=await services.insert(ctx,'vitrines',{environment:ctx.environment,token,journey_id:journey.id,contact_id:journey.contact_id,reference_code:journey.reference_code||'',customer_name:contact[0]?.display_name||null,version:'V1',expires_at:expiresAt(cars),created_by:ctx.panel.id});
  const vitrine=created[0];
  for(const car of cars) await services.insert(ctx,'vitrine_cars',{environment:ctx.environment,vitrine_id:vitrine.id,source_match_id:car.match.id,short_code:await uniqueCode(ctx,services),vehicle_snapshot:car.vehicle,customer_limit_cents:journey.budget_cents||null,photo_paths:[]},false);
  return {token,link:'/v/'+token,referenceCode:journey.reference_code,cars:cars.map((item)=>vehicleName(item.vehicle)),...removedOut};
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
  if(car.source_match_id){const held=await (services.auditGate||auditGate)(ctx,[car.source_match_id]);if(held)return {error:held};
    // MMR is mandatory and must be confirmed on the original match: a missing original (or one
    // without a valid MMR) never becomes a V2.
    const [source]=await services.rows(ctx,'manheim_matches',{select:'id,vehicle_json',environment:'eq.'+ctx.environment,id:'eq.'+car.source_match_id,limit:'1'});
    if(!source)return {error:'VITRINE_SOURCE_MISSING'};
    if(!hasValidMmr(source.vehicle_json?.parsed))return {error:'MANHEIM_MATCH_WITHOUT_MMR'};
    const [current]=await groupedFor(ctx,[source],services);
    if(!current)return {error:'MANHEIM_SALE_ENDED'};
    const sales=publicVehicle(current.vehicle_json?.parsed||{}).purchaseOptions;
    if(car.vehicle_snapshot.purchaseOptions||sales.some(s=>s.lane||s.run||s.buyNowPrice||s.startsAt||s.endsAt))car.vehicle_snapshot={...car.vehicle_snapshot,purchaseOptions:sales};
    // A car shown under the selection rule keeps needing it: removed from the selection, no V2.
    // V1 made before the selection existed (no "selected" mark) keeps working as it was.
    if(car.vehicle_snapshot.selected===true){const selection=await selectedFor(ctx,[car.source_match_id],services);if(selection.error)return {error:selection.error};}}
  if(car.source_match_id){const active=await activeBatch(ctx,services);if(Object.keys(active).length){const [live]=await services.rows(ctx,'manheim_matches',{select:'id,upload_id',environment:'eq.'+ctx.environment,id:'eq.'+car.source_match_id,...active,limit:'1'});if(!live||!(await batchesLive(ctx,[live.upload_id],services)))return {error:'VITRINE_SOURCE_UNDONE'};}}
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
// IMPORTAÇÕES · Fotos da V2: read-only list of the V2 that are still open, with each car and how many
// photos it already has. Nothing is created, published or sent here.
async function listV2(ctx,services={rows},now=Date.now()){
  const vitrines=await services.rows(ctx,'vitrines',{select:'id,token,reference_code,customer_name,expires_at,created_at',environment:'eq.'+ctx.environment,version:'eq.V2',expires_at:'gt.'+new Date(now).toISOString(),order:'created_at.desc',limit:'100'});
  if(!vitrines.length)return {v2:[]};
  const cars=await services.rows(ctx,'vitrine_cars',{select:'id,vitrine_id,vehicle_snapshot,photo_paths',environment:'eq.'+ctx.environment,vitrine_id:'in.('+vitrines.map((item)=>item.id).join(',')+')'});
  return {v2:vitrines.map((item)=>({vitrineId:item.id,link:'/v/'+item.token,customerName:item.customer_name||null,referenceCode:item.reference_code||null,expiresAt:item.expires_at,createdAt:item.created_at,cars:cars.filter((car)=>car.vitrine_id===item.id).map((car)=>({carId:car.id,vehicle:vehicleName(car.vehicle_snapshot||{})||'Carro',photoCount:Array.isArray(car.photo_paths)?car.photo_paths.length:0}))})).filter((item)=>item.cars.length)};
}
/* PDF of ENVIAR OPÇÕES: the same data the link page shows (publicResponse of a V1), built from the cars picked
   on screen. Nothing is saved: no vitrine, no code, no event. */
async function pdfData(ctx,body,services={rows}){
  if(Array.isArray(body.vehicles))return vehiclesPdf(ctx,body,services);
  if(!isUuid(body.journeyId)||!Array.isArray(body.matchIds)||!body.matchIds.length||body.matchIds.length>60||!body.matchIds.every(isUuid))return null;
  const [journey]=await services.rows(ctx,'journeys',{select:'id,contact_id,reference_code',environment:'eq.'+ctx.environment,id:'eq.'+body.journeyId,limit:'1'});
  if(!journey)return null;
  const ids=[...new Set(body.matchIds)];
  const [contact,matches,selections]=await Promise.all([
    services.rows(ctx,'contacts',{select:'display_name',environment:'eq.'+ctx.environment,id:'eq.'+journey.contact_id,limit:'1'}),
    services.rows(ctx,'manheim_matches',{select:'id,vehicle_json',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,id:'in.('+ids.join(',')+')',limit:String(ids.length)}),
    services.rows(ctx,'manheim_option_selections',{select:'match_id,status,final_cents',environment:'eq.'+ctx.environment,match_id:'in.('+ids.join(',')+')',limit:String(ids.length)})]);
  const byId=new Map(matches.map((match)=>[match.id,match]));
  const chosen=new Map((selections||[]).filter((row)=>row.status==='SELECTED'&&Number(row.final_cents)>0).map((row)=>[row.match_id,row]));
  const cars=ids.map((id)=>byId.get(id)).filter(Boolean).map((match)=>{const vehicle=publicVehicle(match.vehicle_json?.parsed||{});const selection=chosen.get(match.id);return {short_code:null,vehicle_snapshot:selection?priced(vehicle,selection):vehicle};});
  if(!cars.length)return null;
  return publicResponse({version:'V1',reference_code:journey.reference_code||'',customer_name:contact[0]?.display_name||null,expires_at:new Date(Date.now()+86400000).toISOString()},cars);
}
// Every compatible car of the ficha (timeline): the cars come from the ficha itself, priced as the link page prices a car
// without a selection (average auction value from the MMR).
async function vehiclesPdf(ctx,body,services){
  if(!body.vehicles.length||body.vehicles.length>200)return null;
  let journey=null,name=null;
  if(isUuid(body.journeyId)){[journey]=await services.rows(ctx,'journeys',{select:'id,contact_id,reference_code',environment:'eq.'+ctx.environment,id:'eq.'+body.journeyId,limit:'1'});
    if(journey&&isUuid(journey.contact_id))name=(await services.rows(ctx,'contacts',{select:'display_name',environment:'eq.'+ctx.environment,id:'eq.'+journey.contact_id,limit:'1'}))[0]?.display_name||null;}
  const cars=body.vehicles.filter((vehicle)=>vehicle&&typeof vehicle==='object').map((vehicle)=>({short_code:null,vehicle_snapshot:publicVehicle(vehicle)}));
  if(!cars.length)return null;
  return publicResponse({version:'V1',reference_code:journey?.reference_code||safeText(body.referenceCode,40)||'',customer_name:name,expires_at:new Date(Date.now()+86400000).toISOString()},cars);
}
const statusFor=(error)=>error==='VITRINE_REQUEST_NOT_FOUND'||error==='VITRINE_NOT_FOUND'?404:error==='MANHEIM_OPTION_NOT_SELECTED'||error==='MANHEIM_STAMP_INVALID'||error==='MANHEIM_SELECTION_PENDING'||error==='VITRINE_REQUEST_TREATED'||error==='VITRINE_SOURCE_UNDONE'||error==='MANHEIM_AUDIT_PENDING'||error==='MANHEIM_MATCH_WITHOUT_MMR'||error==='VITRINE_SOURCE_MISSING'||error==='VITRINE_CONTACT_BLOCKED'||error==='MANHEIM_SALE_ENDED'?409:400;
module.exports=async(req,res)=>{const ctx=await requirePanel(req,res);if(!ctx)return;try{if(req.method==='POST'){const body=await jsonBody(req,512*1024);if(body.action==='pdf'){const out=await pdfData(ctx,body);return out?send(res,200,out):send(res,400,{error:'VITRINE_PDF_INVALID'});}if(body.action==='create_v2'||(body.requestId&&!body.journeyId)){const out=await createV2(ctx,body);return out.error?send(res,statusFor(out.error),{error:out.error}):send(res,out.reused?200:201,out);}const out=await create(ctx,body);if(out&&out.error)return send(res,statusFor(out.error),{error:out.error,...(out.reason?{reason:out.reason}:{}),...(out.removed?{removed:out.removed}:{})});return out?send(res,out.reused?200:201,out):send(res,400,{error:'VITRINE_CREATE_INVALID'});}if(req.method==='GET')return send(res,200,await listV2(ctx));if(req.method==='PATCH'){const out=await update(ctx,await jsonBody(req,65536));return out?.error?send(res,400,{error:out.error}):out?send(res,200,out):send(res,400,{error:'VITRINE_UPDATE_INVALID'});}return send(res,405,{error:'METHOD_NOT_ALLOWED'});}catch(error){return send(res,500,{error:'VITRINE_UNAVAILABLE'});}};
module.exports.create=create;
module.exports.pdfData=pdfData;
module.exports.auditGate=auditGate;
module.exports.createV2=createV2;
module.exports.update=update;
module.exports.listV2=listV2;
module.exports.limitCents=limitCents;
module.exports.parseLimit=parseLimit;

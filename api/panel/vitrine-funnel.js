'use strict';

// V1/V2 funnel for the panel: every V1 sent (waiting for the tap or tapped without a V2 yet)
// and every V2 sent (waiting for the bid or bid placed). No migration, existing tables only.
// The TAP is read straight from vitrine_events: the 15-minute delay of vitrine-requests.js does
// not apply here, the card appears in "Tocou · falta a V2" as soon as the client taps.
const {allRows,isUuid,insert,jsonBody,requirePanel,send}=require('../../panel-server');
const {vehicleName}=require('../../vitrine-domain');
const {toggleEnabled}=require('../../panel-domain');
const {loadClassification}=require('../../panel-classification');
const groups=require('../../panel-groups');
const {dispositionIndex}=require('../../panel-disposition');

const since=(value,now=Date.now())=>{
  const elapsed=Math.max(0,now-Date.parse(value||now));
  const minutes=Math.floor(elapsed/60000);
  if(minutes<60)return `há ${minutes||1} min`;
  const hours=Math.floor(minutes/60);
  if(hours<24)return `há ${hours} h`;
  return `há ${Math.floor(hours/24)} dias`;
};

async function payload(ctx,services={}){
  const read=services.allRows||allRows;
  const [vitrines,cars,events,requests,contacts,phones,journeys,toggles,dispositions,journeyRefs]=await Promise.all([
    read(ctx,'vitrines',{select:'id,contact_id,journey_id,reference_code,customer_name,version,created_at,expires_at,parent_vitrine_id',environment:'eq.'+ctx.environment,order:'created_at.desc'}),
    read(ctx,'vitrine_cars',{select:'id,vitrine_id,source_match_id,vehicle_snapshot,customer_limit_cents',environment:'eq.'+ctx.environment}),
    read(ctx,'vitrine_events',{select:'vitrine_id,vitrine_car_id,event_type,created_at',environment:'eq.'+ctx.environment,order:'created_at.desc'}),
    read(ctx,'vitrine_requests',{select:'id,vitrine_id,vitrine_car_id,request_kind,treated_at,created_at',environment:'eq.'+ctx.environment,order:'created_at.desc'}),
    read(ctx,'contacts',{select:'id,display_name,is_lead',environment:'eq.'+ctx.environment}),
    read(ctx,'contact_phones',{select:'contact_id,phone_e164,phone_raw,is_primary,is_current,retired_at',environment:'eq.'+ctx.environment}),
    read(ctx,'journeys',{select:'id,contact_id,reference_code,status,budget_cents',environment:'eq.'+ctx.environment}),
    read(ctx,'journey_toggle_states',{select:'journey_id,enabled',environment:'eq.'+ctx.environment}),
    read(ctx,'panel_item_dispositions',{select:'item_kind,item_key,status,updated_at',environment:'eq.'+ctx.environment,cleared_at:'is.null'}),
    read(ctx,'journey_refs',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment})
  ]);
  const classification=services.loadClassification?await services.loadClassification(ctx):await loadClassification(ctx);
  const refStateFor=(journeyId)=>{if(!journeyId)return 'SEM_REF';const identity=classification.identityOf(journeyId);if(identity.state!=='OK')return null;return groups.refStateOf({hasCalcRef:identity.status==='REF_COMPROVADA',identity});};
  const vitrinesById=new Map(vitrines.map((row)=>[row.id,row]));
  const contactsById=new Map(contacts.map((row)=>[row.id,row]));
  const journeysById=new Map(journeys.map((row)=>[row.id,row])),toggleByJourney=new Map(toggles.map((row)=>[row.journey_id,row]));
  const personDisposition=dispositionIndex(dispositions);
  const phoneFor=(contactId)=>{const values=phones.filter((row)=>row.contact_id===contactId&&row.is_current!==false&&!row.retired_at);const row=values.find((row)=>row.is_primary)||values[0];return row&&(row.phone_e164||row.phone_raw)||null;};
  // Same "actionable" rule as vitrine-requests.js: never "não é lead", never a closed or
  // switched-off case, never a discarded person.
  const actionable=(vitrine)=>{
    if(contactsById.get(vitrine.contact_id)?.is_lead===false)return false;
    const journeyId=vitrine.journey_id||null;
    if(!journeyId)return true;
    const journey=journeysById.get(journeyId);
    if(!journey)return true;
    if(contactsById.get(journey.contact_id)?.is_lead===false)return false;
    if(!toggleEnabled(journey.status,toggleByJourney.get(journeyId)))return false;
    const refs=[journey.reference_code,...journeyRefs.filter((row)=>row.journey_id===journeyId).map((row)=>row.ref_code)].filter(Boolean);
    return personDisposition(journeyId,refs)?.status!=='DISCARDED';
  };
  const now=Date.now();
  const expired=(vitrine)=>Date.parse(vitrine.expires_at||0)<=now;
  const carsByVitrine=new Map();
  cars.forEach((car)=>{if(!carsByVitrine.has(car.vitrine_id))carsByVitrine.set(car.vitrine_id,[]);carsByVitrine.get(car.vitrine_id).push(car);});
  const childrenByParent=new Map();
  vitrines.forEach((vitrine)=>{if(vitrine.parent_vitrine_id){if(!childrenByParent.has(vitrine.parent_vitrine_id))childrenByParent.set(vitrine.parent_vitrine_id,[]);childrenByParent.get(vitrine.parent_vitrine_id).push(vitrine);}});
  const eventsByVitrine=new Map();
  events.forEach((event)=>{if(!eventsByVitrine.has(event.vitrine_id))eventsByVitrine.set(event.vitrine_id,[]);eventsByVitrine.get(event.vitrine_id).push(event);});
  const requestsByCar=new Map();
  requests.forEach((request)=>{const key=request.vitrine_id+'|'+request.vitrine_car_id;if(!requestsByCar.has(key))requestsByCar.set(key,[]);requestsByCar.get(key).push(request);});
  const budgetByJourney=new Map(journeys.map((row)=>[row.id,row.budget_cents||null]));
  const contactName=(vitrine)=>contactsById.get(vitrine.contact_id)?.display_name||vitrine.customer_name||phoneFor(vitrine.contact_id)||'Cliente';

  // VIN of each car (two cars of the same year and model are told apart on the card).
  // A V1 created before the snapshot kept the VIN: the VIN comes from the car's source match (the same
  // car of the batch). Read only for those cars, by id.
  const missing=[...new Set(cars.filter((car)=>!String(car&&car.vehicle_snapshot&&car.vehicle_snapshot.vin||'').trim()&&car&&car.source_match_id).map((car)=>car.source_match_id))];
  const sourceVin=new Map();
  for(let index=0;index<missing.length;index+=100){
    const found=await read(ctx,'manheim_matches',{select:'id,vehicle_json',environment:'eq.'+ctx.environment,id:'in.('+missing.slice(index,index+100).join(',')+')'}).catch(()=>[]);
    (found||[]).forEach((row)=>{const vin=String(row&&row.vehicle_json&&row.vehicle_json.parsed&&row.vehicle_json.parsed.vin||'').trim();if(vin)sourceVin.set(row.id,vin);});
  }
  const vinOf=(car)=>{const vin=String((car&&car.vehicle_snapshot&&car.vehicle_snapshot.vin)||(car&&sourceVin.get(car.source_match_id))||'').trim().toUpperCase();return vin||null;};
  const v1={tapped:[],waiting:[],expired:[]},v2={bid:[],waiting:[],expired:[]};
  vitrines.forEach((vitrine)=>{
    if(!actionable(vitrine))return;
    const carList=carsByVitrine.get(vitrine.id)||[];
    const contact={name:contactName(vitrine),phone:phoneFor(vitrine.contact_id)};
    if(vitrine.version==='V1'){
      if(expired(vitrine)){v1.expired.push({vitrineId:vitrine.id,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',journeyId:vitrine.journey_id||null,cars:carList.map((car)=>vehicleName(car.vehicle_snapshot||{})),vins:carList.map(vinOf),sentAt:vitrine.created_at,ago:since(vitrine.created_at,now),expiredAt:vitrine.expires_at});return;}
      const v2children=(childrenByParent.get(vitrine.id)||[]).filter((child)=>child.version==='V2');
      const tapsByCar=new Map();
      (eventsByVitrine.get(vitrine.id)||[]).filter((event)=>event.event_type==='TAP'&&event.vitrine_car_id).forEach((event)=>{
        if(!tapsByCar.has(event.vitrine_car_id)||Date.parse(event.created_at)>Date.parse(tapsByCar.get(event.vitrine_car_id).created_at))tapsByCar.set(event.vitrine_car_id,event);
      });
      let tappedAny=false;
      tapsByCar.forEach((tap,carId)=>{
        if(v2children.length)return; // the V2 exists: the client moved to the V2 tab
        const car=carList.find((item)=>item.id===carId);if(!car)return;
        const reqs=requestsByCar.get(vitrine.id+'|'+carId)||[];
        // "Pedido atendido" (treated) after the tap takes the card out of the action zone.
        if(reqs.some((req)=>req.request_kind==='VIEW'&&req.treated_at&&Date.parse(req.treated_at)>=Date.parse(tap.created_at)))return;
        const open=reqs.find((req)=>req.request_kind==='VIEW'&&!req.treated_at);
        tappedAny=true;
        v1.tapped.push({vitrineId:vitrine.id,vitrineCarId:carId,requestId:open?open.id:null,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',journeyId:vitrine.journey_id||null,refState:refStateFor(vitrine.journey_id||null),car:vehicleName(car.vehicle_snapshot||{}),vin:vinOf(car),sentAt:vitrine.created_at,tapAt:tap.created_at,ago:since(tap.created_at,now),budgetCents:vitrine.journey_id?budgetByJourney.get(vitrine.journey_id)||null:null});
      });
      if(!tappedAny&&!v2children.length)v1.waiting.push({vitrineId:vitrine.id,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',journeyId:vitrine.journey_id||null,refState:refStateFor(vitrine.journey_id||null),cars:carList.map((car)=>vehicleName(car.vehicle_snapshot||{})),vins:carList.map(vinOf),sentAt:vitrine.created_at,ago:since(vitrine.created_at,now)});
      return;
    }
    if(vitrine.version==='V2'){
      const firstCar=carList[0]||{};
      const item={vitrineId:vitrine.id,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',journeyId:vitrine.journey_id||null,refState:refStateFor(vitrine.journey_id||null),car:vehicleName(firstCar.vehicle_snapshot||{}),vin:vinOf(firstCar),sentAt:vitrine.created_at,ago:since(vitrine.created_at,now)};
      if(expired(vitrine)){v2.expired.push({...item,expiredAt:vitrine.expires_at});return;}
      const bidRequest=(requests||[]).find((req)=>req.vitrine_id===vitrine.id&&req.request_kind==='BID'&&!req.treated_at);
      const bidTap=(eventsByVitrine.get(vitrine.id)||[]).find((event)=>event.event_type==='TAP');
      if(bidRequest||bidTap){v2.bid.push({...item,bidAt:(bidRequest||bidTap).created_at,bidAgo:since((bidRequest||bidTap).created_at,now)});}
      else v2.waiting.push(item);
    }
  });
  const byRecent=(a,b)=>Date.parse(b.tapAt||b.bidAt||b.sentAt)-Date.parse(a.tapAt||a.bidAt||a.sentAt);
  v1.tapped.sort(byRecent);v1.waiting.sort(byRecent);v1.expired.sort((a,b)=>Date.parse(b.expiredAt)-Date.parse(a.expiredAt));
  v2.bid.sort(byRecent);v2.waiting.sort(byRecent);v2.expired.sort((a,b)=>Date.parse(b.expiredAt)-Date.parse(a.expiredAt));
  return {v1,v2,counts:{v1Action:v1.tapped.length,v2Action:v2.bid.length}};
}


// Lightweight summary for the "Opções enviadas" stat: real V1s from the vitrines
// table, never the manual mark. "Today" is Florida time, like every other panel date.
async function summary(ctx,services={}){
  const read=services.allRows||allRows;
  const rows=await read(ctx,'vitrines',{select:'journey_id,created_at',environment:'eq.'+ctx.environment,version:'eq.V1'})||[];
  const journeyIds=[...new Set(rows.map((row)=>row.journey_id).filter(Boolean))];
  const dayKey=(value)=>{const date=new Date(value||0);if(!Number.isFinite(date.getTime()))return '';
    const parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
    const get=(type)=>parts.find((part)=>part.type===type).value;return `${get('year')}-${get('month')}-${get('day')}`;};
  const todayKey=dayKey(Date.now());
  return {v1JourneyIds:journeyIds,v1Today:rows.filter((row)=>dayKey(row.created_at)===todayKey).length};
}

// A tap alone never creates a vitrine_requests row, and createV2 needs one: when the operator
// opens the V2 builder for a tap without a request, the row is created here (VIEW kind, same
// columns as vitrine-webhook.js). Idempotent on the open request for that car.
async function ensureRequest(ctx,body,services={}){
  const write=services.insert||insert,read=services.allRows||allRows;
  if(!isUuid(body.vitrineId)||!isUuid(body.vitrineCarId))return {error:'VITRINE_FUNNEL_INVALID'};
  const [existing]=await read(ctx,'vitrine_requests',{select:'id',environment:'eq.'+ctx.environment,vitrine_id:'eq.'+body.vitrineId,vitrine_car_id:'eq.'+body.vitrineCarId,request_kind:'eq.VIEW',treated_at:'is.null',order:'created_at.desc',limit:'1'});
  if(existing)return {requestId:existing.id,reused:true};
  const [vitrine]=await read(ctx,'vitrines',{select:'id,contact_id,journey_id,version,expires_at',environment:'eq.'+ctx.environment,id:'eq.'+body.vitrineId,limit:'1'});
  if(!vitrine)return {error:'VITRINE_NOT_FOUND'};
  if(vitrine.version!=='V1')return {error:'VITRINE_FUNNEL_INVALID'};
  if(Date.parse(vitrine.expires_at||0)<=Date.now())return {error:'VITRINE_EXPIRED'};
  const [car]=await read(ctx,'vitrine_cars',{select:'id',environment:'eq.'+ctx.environment,id:'eq.'+body.vitrineCarId,vitrine_id:'eq.'+body.vitrineId,limit:'1'});
  if(!car)return {error:'VITRINE_CAR_MISSING'};
  const [created]=await write(ctx,'vitrine_requests',{environment:ctx.environment,vitrine_id:vitrine.id,vitrine_car_id:car.id,contact_id:vitrine.contact_id,journey_id:vitrine.journey_id,request_kind:'VIEW',referred:false},false);
  return {requestId:created.id,created:true};
}

module.exports=async(req,res)=>{const ctx=await requirePanel(req,res);if(!ctx)return;try{
  if(req.method==='GET'){
    const query=req.query||Object.fromEntries(new URL(req.url||'/','http://painel.local').searchParams);
    if(query.summary)return send(res,200,await summary(ctx));
    return send(res,200,await payload(ctx));
  }
  if(req.method!=='POST')return send(res,405,{error:'METHOD_NOT_ALLOWED'});
  const body=await jsonBody(req,4096);
  if(body.action!=='ensure_request')return send(res,400,{error:'VITRINE_FUNNEL_INVALID'});
  const out=await ensureRequest(ctx,body);
  if(out.error)return send(res,out.error==='VITRINE_NOT_FOUND'?404:out.error==='VITRINE_EXPIRED'?410:400,{error:out.error});
  return send(res,out.reused?200:201,out);
}catch(_){return send(res,500,{error:'VITRINE_FUNNEL_UNAVAILABLE'});}};
module.exports.payload=payload;
module.exports.ensureRequest=ensureRequest;
module.exports.summary=summary;

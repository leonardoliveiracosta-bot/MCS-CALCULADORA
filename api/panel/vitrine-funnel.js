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
const {sentByLink}=require('../../panel-v1-sent');

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
  const [vitrines,cars,events,requests,contacts,phones,journeys,toggles,dispositions,journeyRefs,linkMessages]=await Promise.all([
    read(ctx,'vitrines',{select:'id,token,contact_id,journey_id,reference_code,customer_name,version,created_at,expires_at,parent_vitrine_id',environment:'eq.'+ctx.environment,order:'created_at.desc'}),
    read(ctx,'vitrine_cars',{select:'id,vitrine_id,source_match_id,vehicle_snapshot,customer_limit_cents',environment:'eq.'+ctx.environment}),
    read(ctx,'vitrine_events',{select:'vitrine_id,vitrine_car_id,event_type,created_at',environment:'eq.'+ctx.environment,order:'created_at.desc'}),
    read(ctx,'vitrine_requests',{select:'id,vitrine_id,vitrine_car_id,request_kind,treated_at,created_at',environment:'eq.'+ctx.environment,order:'created_at.desc'}),
    read(ctx,'contacts',{select:'id,display_name,is_lead',environment:'eq.'+ctx.environment}),
    read(ctx,'contact_phones',{select:'contact_id,phone_e164,phone_raw,is_primary,is_current,retired_at',environment:'eq.'+ctx.environment}),
    read(ctx,'journeys',{select:'id,contact_id,reference_code,status,budget_cents',environment:'eq.'+ctx.environment}),
    read(ctx,'journey_toggle_states',{select:'journey_id,enabled',environment:'eq.'+ctx.environment}),
    read(ctx,'panel_item_dispositions',{select:'item_kind,item_key,status,updated_at',environment:'eq.'+ctx.environment,cleared_at:'is.null'}),
    read(ctx,'journey_refs',{select:'journey_id,ref_code',environment:'eq.'+ctx.environment}),
    // The proof that a V1/V2 was sent: an MCS message carrying its /v/<token> link (panel-v1-sent.js).
    read(ctx,'messages',{select:'id,direction,body_text,occurred_at_utc,occurred_at_local,created_at,undone_at',environment:'eq.'+ctx.environment,direction:'eq.MCS',undone_at:'is.null',body_text:'like.*/v/*'})
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
  // "Enviada" only with that proof, counted from the message; a link only generated (and maybe previewed)
  // is never shown as sent, and a tap before the send (the preview) is never the client's.
  const sentAtById=new Map(sentByLink({messages:linkMessages||[],vitrines}).map((row)=>[row.vitrineId,row.sentAt]));
  const unsent=[];
  const now=Date.now();
  const expired=(vitrine)=>Date.parse(vitrine.expires_at||0)<=now;
  const carsByVitrine=new Map();
  cars.forEach((car)=>{if(!carsByVitrine.has(car.vitrine_id))carsByVitrine.set(car.vitrine_id,[]);carsByVitrine.get(car.vitrine_id).push(car);});
  const childrenByParent=new Map();
  vitrines.forEach((vitrine)=>{if(vitrine.parent_vitrine_id){if(!childrenByParent.has(vitrine.parent_vitrine_id))childrenByParent.set(vitrine.parent_vitrine_id,[]);childrenByParent.get(vitrine.parent_vitrine_id).push(vitrine);}});
  const eventsByVitrine=new Map();
  events.forEach((event)=>{if(!eventsByVitrine.has(event.vitrine_id))eventsByVitrine.set(event.vitrine_id,[]);eventsByVitrine.get(event.vitrine_id).push(event);});
  // "Tirar da lista": the latest DISMISS mark of each vitrine (treated_at set). A new tap or bid after
  // it brings the card back; Desfazer (treated_at null) brings it back at once.
  const dismissedAt=new Map();
  requests.filter((request)=>request.request_kind==='DISMISS'&&request.treated_at).forEach((request)=>{const at=Date.parse(request.treated_at);if(!dismissedAt.has(request.vitrine_id)||at>dismissedAt.get(request.vitrine_id))dismissedAt.set(request.vitrine_id,at);});
  const dismissedSince=(vitrine,at)=>dismissedAt.has(vitrine.id)&&dismissedAt.get(vitrine.id)>=Date.parse(at||0);
  const requestsByCar=new Map();
  requests.forEach((request)=>{const key=request.vitrine_id+'|'+request.vitrine_car_id;if(!requestsByCar.has(key))requestsByCar.set(key,[]);requestsByCar.get(key).push(request);});
  const budgetByJourney=new Map(journeys.map((row)=>[row.id,row.budget_cents||null]));
  // "Abrir ficha": a V1/V2 sem pedido gravado é ligada ao pedido do mesmo cliente com a mesma Ref (só
  // quando há exatamente um). Sem pedido possível, o cartão recebe o motivo em vez de um botão morto.
  const refsByJourney=new Map();
  journeyRefs.forEach((row)=>{if(!refsByJourney.has(row.journey_id))refsByJourney.set(row.journey_id,[]);refsByJourney.get(row.journey_id).push(row.ref_code);});
  const refKey=(value)=>String(value||'').trim().toUpperCase();
  const linkOf=(vitrine)=>{
    if(vitrine.journey_id)return {journeyId:vitrine.journey_id};
    const ref=refKey(vitrine.reference_code);
    const owners=ref&&vitrine.contact_id?journeys.filter((row)=>row.contact_id===vitrine.contact_id&&[row.reference_code,...(refsByJourney.get(row.id)||[])].some((code)=>refKey(code)===ref)):[];
    if(owners.length===1)return {journeyId:owners[0].id};
    return {journeyId:null,journeyMissing:owners.length>1?'VARIOS_PEDIDOS':'SEM_PEDIDO'};
  };
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
    if(!sentAtById.has(vitrine.id)){
      if(!dismissedAt.has(vitrine.id))unsent.push({vitrineId:vitrine.id,version:vitrine.version,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',...linkOf(vitrine),cars:carList.map((car)=>vehicleName(car.vehicle_snapshot||{})),vins:carList.map(vinOf),createdAt:vitrine.created_at,ago:since(vitrine.created_at,now),expired:expired(vitrine)});
      return;
    }
    const sentAt=sentAtById.get(vitrine.id)||vitrine.created_at;
    const afterSend=(event)=>Date.parse(event.created_at)>=Date.parse(sentAt);
    if(vitrine.version==='V1'){
      if(expired(vitrine)){if(dismissedAt.has(vitrine.id))return;v1.expired.push({vitrineId:vitrine.id,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',...linkOf(vitrine),cars:carList.map((car)=>vehicleName(car.vehicle_snapshot||{})),vins:carList.map(vinOf),sentAt,ago:since(sentAt,now),expiredAt:vitrine.expires_at});return;}
      const v2children=(childrenByParent.get(vitrine.id)||[]).filter((child)=>child.version==='V2');
      const tapsByCar=new Map();
      (eventsByVitrine.get(vitrine.id)||[]).filter((event)=>event.event_type==='TAP'&&event.vitrine_car_id&&afterSend(event)).forEach((event)=>{
        if(!tapsByCar.has(event.vitrine_car_id)||Date.parse(event.created_at)>Date.parse(tapsByCar.get(event.vitrine_car_id).created_at))tapsByCar.set(event.vitrine_car_id,event);
      });
      let tappedAny=false;
      tapsByCar.forEach((tap,carId)=>{
        if(v2children.length)return; // the V2 exists: the client moved to the V2 tab
        if(dismissedSince(vitrine,tap.created_at))return;
        const car=carList.find((item)=>item.id===carId);if(!car)return;
        const reqs=requestsByCar.get(vitrine.id+'|'+carId)||[];
        // "Pedido atendido" (treated) after the tap takes the card out of the action zone.
        if(reqs.some((req)=>req.request_kind==='VIEW'&&req.treated_at&&Date.parse(req.treated_at)>=Date.parse(tap.created_at)))return;
        const open=reqs.find((req)=>req.request_kind==='VIEW'&&!req.treated_at);
        tappedAny=true;
        v1.tapped.push({vitrineId:vitrine.id,vitrineCarId:carId,requestId:open?open.id:null,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',...linkOf(vitrine),refState:refStateFor(vitrine.journey_id||null),car:vehicleName(car.vehicle_snapshot||{}),vin:vinOf(car),sentAt,tapAt:tap.created_at,ago:since(tap.created_at,now),budgetCents:vitrine.journey_id?budgetByJourney.get(vitrine.journey_id)||null:null});
      });
      if(!tappedAny&&!v2children.length&&!dismissedAt.has(vitrine.id))v1.waiting.push({vitrineId:vitrine.id,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',...linkOf(vitrine),refState:refStateFor(vitrine.journey_id||null),cars:carList.map((car)=>vehicleName(car.vehicle_snapshot||{})),vins:carList.map(vinOf),sentAt,ago:since(sentAt,now)});
      return;
    }
    if(vitrine.version==='V2'){
      const firstCar=carList[0]||{};
      const item={vitrineId:vitrine.id,name:contact.name,phone:contact.phone,referenceCode:vitrine.reference_code||'',...linkOf(vitrine),refState:refStateFor(vitrine.journey_id||null),car:vehicleName(firstCar.vehicle_snapshot||{}),vin:vinOf(firstCar),sentAt,ago:since(sentAt,now)};
      if(expired(vitrine)){if(!dismissedAt.has(vitrine.id))v2.expired.push({...item,expiredAt:vitrine.expires_at});return;}
      const bidRequest=(requests||[]).find((req)=>req.vitrine_id===vitrine.id&&req.request_kind==='BID'&&!req.treated_at);
      const bidTap=(eventsByVitrine.get(vitrine.id)||[]).find((event)=>event.event_type==='TAP'&&afterSend(event));
      // The latest bid signal (request or tap); a dismissal older than it does not hide the card.
      const bidAt=[bidRequest,bidTap].filter(Boolean).map((row)=>row.created_at).sort((a,b)=>Date.parse(b)-Date.parse(a))[0]||null;
      if(dismissedSince(vitrine,bidAt||vitrine.created_at))return;
      if(bidRequest||bidTap){v2.bid.push({...item,bidAt:(bidRequest||bidTap).created_at,bidAgo:since((bidRequest||bidTap).created_at,now)});}
      else v2.waiting.push(item);
    }
  });
  const byRecent=(a,b)=>Date.parse(b.tapAt||b.bidAt||b.sentAt)-Date.parse(a.tapAt||a.bidAt||a.sentAt);
  v1.tapped.sort(byRecent);v1.waiting.sort(byRecent);v1.expired.sort((a,b)=>Date.parse(b.expiredAt)-Date.parse(a.expiredAt));
  v2.bid.sort(byRecent);v2.waiting.sort(byRecent);v2.expired.sort((a,b)=>Date.parse(b.expiredAt)-Date.parse(a.expiredAt));
  unsent.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
  v1.unsent=unsent.filter((item)=>item.version==='V1');v2.unsent=unsent.filter((item)=>item.version==='V2');
  return {v1,v2,counts:{v1Action:v1.tapped.length,v2Action:v2.bid.length}};
}


// Lightweight summary for the "Opções enviadas" stat: real V1s from the vitrines
// table, never the manual mark. "Today" is Florida time, like every other panel date.
async function summary(ctx,services={}){
  const read=services.allRows||allRows;
  const [all,linkMessages]=await Promise.all([
    read(ctx,'vitrines',{select:'id,token,journey_id,created_at',environment:'eq.'+ctx.environment,version:'eq.V1'}),
    read(ctx,'messages',{select:'id,direction,body_text,occurred_at_utc,occurred_at_local,created_at,undone_at',environment:'eq.'+ctx.environment,direction:'eq.MCS',undone_at:'is.null',body_text:'like.*/v/*'})
  ]);
  // Only V1s really sent (the link in an MCS message), on the day of that message.
  const sentAt=new Map(sentByLink({messages:linkMessages||[],vitrines:all||[]}).map((row)=>[row.vitrineId,row.sentAt]));
  const rows=(all||[]).filter((row)=>sentAt.has(row.id)).map((row)=>({...row,created_at:sentAt.get(row.id)||row.created_at}));
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

'use strict';
const { timezoneForZip, realisticBid, median } = require('./panel-lead');
const { mergeWishlists } = require('./panel-domain');
const catalog = require('./vehicle-catalog');
const calc = require('./calc-core');
function score(item={}, journey, data={}, vehicles=[], now=Date.now()) {
  const tz=timezoneForZip(item.zip||journey?.zip||'');
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).format(now));
  const goodHour=hour>=9&&hour<20;
  if (journey?.enabled===false || journey?.status==='ENCERRADO') return {score:null,goodHour,promiseToday:false};
  const id=journey?.id;
  const checklist=id?(data.checklist||[]).filter((point)=>point.journey_id===id&&point.status==='COMPLETE').length:0;
  const phone=Boolean(journey?.phones?.some((value)=>value.is_current!==false));
  const deadline=journey?.customer_deadline_text||item.deadlineText;
  const messages=id?(data.messages||[]).filter((message)=>message.journey_id===id&&message.direction==='CUSTOMER'):[];
  const latestMessage=messages.reduce((stamp,message)=>Math.max(stamp,Date.parse(message.occurred_at_utc||message.created_at)||0),0);
  const latest=Math.max(latestMessage,Date.parse(item.occurredAt||0)||0);
  const wishes=journey?.criteria_json?.wishlistOverride ? journey.criteria_json.wishlists||[] : mergeWishlists(journey?.criteria_json?.wishlists||[],item.wishlists||[]);
  const wish=wishes[0];
  let mmr=null;
  if(wish?.model){
    const comparable=vehicles.filter((vehicle)=>(!wish.make||!vehicle.make||catalog.fold(wish.make)===catalog.fold(vehicle.make))&&catalog.modelsMatch(vehicle.model,wish.model,vehicle.make,wish.make)
      &&(!wish.yearMin||vehicle.year>=wish.yearMin-1)&&(!wish.yearMax||vehicle.year<=wish.yearMax+1)&&(!wish.yearMax||wish.yearMin||vehicle.year>=wish.yearMax-1)
      &&(!wish.maxMiles||Math.abs(vehicle.miles-wish.maxMiles)<=20000));
    mmr=median(comparable.map((vehicle)=>vehicle.mmrCents));
  }
  const zip=item.zip||journey?.zip||'';
  const state=calc.zipEstado(zip);
  const payment=String(journey?.payment_text||item.paymentText||'cash').toLowerCase()==='fin'?'fin':'cash';
  const ceiling=Number(journey?.confirmed_total_ceiling_cents)||0;
  const maxBid=Number(item.budgetCents||journey?.budget_cents)||0;
  const bid=ceiling?realisticBid(ceiling,{florida:state?state.uf==='FL':true,payment,plate:item.plate||'transf',zip,stateIndex:state?String(calc.CONFIG.estados.findIndex((entry)=>entry.nome===state.nome)):''}):maxBid?Math.floor(maxBid/100):null;
  const clientDate=(value)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
  const today=clientDate(now);
  const promiseToday=Boolean(id&&(data.promises||[]).some((p)=>p.journey_id===id&&p.status==='OPEN'&&clientDate(new Date(p.due_at))===today));
  const value=Math.min(100,(phone?15:0)+Math.min(30,checklist*5)+(['now','30d'].includes(deadline)?20:['3m','30–90 dias'].includes(deadline)?10:0)
    +(mmr&&bid?mmr<=bid*100?15:mmr<=bid*120?5:0:0)+(latest&&now-latest<86400000?10:latest&&now-latest<72*3600000?5:0)+(goodHour?10:0));
  return {score:value,goodHour,promiseToday,bid,mmr};
}
module.exports={score};

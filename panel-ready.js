'use strict';
const { timezoneForZip, realisticBid, median } = require('./panel-lead');
const catalog = require('./vehicle-catalog');
const calc = require('./calc-core');
function score(item, journey, data, vehicles, now=Date.now()) {
  if (journey?.enabled===false) return { score:null, goodHour:false, promiseToday:false };
  const tz=timezoneForZip(item.zip||'');
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).format(now));
  const goodHour=hour>=9&&hour<20;
  const id=journey?.id;
  const checklist=id?data.checklist.filter((point)=>point.journey_id===id&&point.status==='COMPLETE').length:0;
  const phone=Boolean(journey?.phones?.some((value)=>value.is_current!==false));
  const deadline=journey?.customer_deadline_text||item.deadlineText;
  const messages=id?data.messages.filter((message)=>message.journey_id===id&&message.direction==='CUSTOMER'):[];
  const latest=messages.reduce((stamp,message)=>Math.max(stamp,Date.parse(message.occurred_at_utc||message.created_at)||0),0);
  const age=now-latest;
  const wishes=journey?.criteria_json?.wishlists||item.wishlists||[];
  const wish=wishes[0];
  let mmr=null;
  if(wish?.model){
    const comparable=vehicles.filter((vehicle)=>(!wish.make||!vehicle.make||catalog.fold(wish.make)===catalog.fold(vehicle.make))&&catalog.modelsMatch(vehicle.model,wish.model,vehicle.make,wish.make)
      &&(!wish.yearMin||(vehicle.year>=wish.yearMin-1&&vehicle.year<=(wish.yearMax||wish.yearMin)+1))&&(!wish.maxMiles||Math.abs(vehicle.miles-wish.maxMiles)<=20000));
    mmr=median(comparable.map((vehicle)=>vehicle.mmrCents));
  }
  const state=calc.zipEstado(item.zip||'');
  const bid=realisticBid(journey?.budget_cents||item.budgetCents,{florida:state?state.uf==='FL':true,payment:journey?.payment_text||item.paymentText||'cash',plate:item.plate||'transf',zip:item.zip||'',stateIndex:state?String(calc.CONFIG.estados.findIndex((entry)=>entry.nome===state.nome)):''});
  const clientDate=(value)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
  const today=clientDate(now);
  const promiseToday=Boolean(id&&data.promises.some((p)=>p.journey_id===id&&p.status==='OPEN'&&clientDate(new Date(p.due_at))===today));
  const value=Math.min(100,(phone?15:0)+Math.min(30,checklist*5)+(['now','30d'].includes(deadline)?20:['3m','30–90 dias'].includes(deadline)?10:0)
    +(mmr&&bid?mmr<=bid*100?15:mmr<=bid*120?5:0:0)+(latest&&age<86400000?10:latest&&age<72*3600000?5:0)+(goodHour?10:0));
  return {score:value,goodHour,promiseToday};
}
module.exports={score};

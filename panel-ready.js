'use strict';
const { timezoneForZip, realisticBid, median } = require('./panel-lead');
const { effectiveCriteria, normalizeDeadline, normalizePayment } = require('./panel-domain');
const vehicleMatch = require('./vehicle-match');
const calc = require('./calc-core');

// A9: one rule for the ZIP of a lead on every screen: the ZIP typed in the calculator, then the
// ZIP written in the contact's location.
function leadZip(item, journey) {
  const typed = String(item?.zip || '').replace(/\D/g, '').slice(0, 5);
  if (typed.length === 5) return typed;
  const location = String(journey?.contact?.location_text || item?.contact?.location_text || '').match(/\b\d{5}\b/);
  return location ? location[0] : '';
}

// A9: every screen scores with the same cars (last 60 days of Manheim exports).
async function loadScoreVehicles(ctx, now = Date.now()) {
  const { allRows } = require('./panel-server');
  const since = new Date(now - 60 * 86400000).toISOString();
  const [archive, matches] = await Promise.all([
    allRows(ctx, 'manheim_vehicles', { select: 'row_fingerprint,vehicle_json', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + since }),
    allRows(ctx, 'manheim_matches', { select: 'row_fingerprint,vehicle_json', environment: 'eq.' + ctx.environment, created_at: 'gte.' + since })
  ]);
  const unique = new Map();
  archive.forEach((entry) => unique.set(entry.row_fingerprint, entry.vehicle_json));
  matches.forEach((entry) => { if (entry.vehicle_json?.parsed && !unique.has(entry.row_fingerprint)) unique.set(entry.row_fingerprint, entry.vehicle_json.parsed); });
  return [...unique.values()].filter(Boolean);
}

function score(item={}, journey, data={}, vehicles=[], now=Date.now()) {
  const zip=leadZip(item,journey);
  const tz=timezoneForZip(zip);
  const hour=Number(new Intl.DateTimeFormat('en-US',{timeZone:tz,hour:'numeric',hourCycle:'h23'}).format(now));
  // M2: a good hour to call is shown as a badge; it is not part of the score (the score must not
  // change with the clock).
  const goodHour=hour>=9&&hour<20;
  if (journey?.enabled===false || journey?.status==='ENCERRADO') return {score:null,goodHour,promiseToday:false};
  const id=journey?.id;
  const checklist=id?(data.checklist||[]).filter((point)=>point.journey_id===id&&point.status==='COMPLETE').length:0;
  const phone=Boolean(journey?.phones?.some((value)=>value.is_current!==false));
  const deadline=normalizeDeadline(journey?.customer_deadline_text)||normalizeDeadline(item.deadlineText);
  const messages=id?(data.messages||[]).filter((message)=>message.journey_id===id&&message.direction==='CUSTOMER'):[];
  const latestMessage=messages.reduce((stamp,message)=>Math.max(stamp,Date.parse(message.occurred_at_utc||message.created_at)||0),0);
  const latest=Math.max(latestMessage,Date.parse(item.occurredAt||0)||0);
  const criteria=effectiveCriteria(journey,item);const wishes=criteria.wishes;
  const wish=wishes[0];
  let mmr=null;
  if(wish?.model){
    // R3: only cars the shared rule calls BATE or POR VALOR are comparable; unknown criteria are not "any".
    const comparable=vehicles.filter((vehicle)=>vehicleMatch.countsAsServed(vehicleMatch.matchWish(vehicle,wish,criteria.bidCents)?.kind));
    mmr=median(comparable.map((vehicle)=>vehicle.mmrCents));
  }
  const state=calc.zipEstado(zip);
  // Unknown payment is computed as cash (the calculator's default) but never stored as a fact.
  const payment=normalizePayment(journey?.payment_text)||normalizePayment(item.paymentText)||'cash';
  const ceiling=Number(journey?.confirmed_total_ceiling_cents)||0;
  const maxBid=Number(criteria.bidCents)||0;
  // R2: a total ceiling confirmed by the operator wins (budget_cents is usually the calculator bid
  // copied into the ficha); without it, the maximum bid.
  const bid=ceiling?realisticBid(ceiling,{florida:state?state.uf==='FL':true,payment,plate:item.plate||'transf',zip,stateIndex:state?String(calc.CONFIG.estados.findIndex((entry)=>entry.nome===state.nome)):''}):maxBid?Math.floor(maxBid/100):null;
  const clientDate=(value)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
  const today=clientDate(now);
  const promiseToday=Boolean(id&&(data.promises||[]).some((p)=>p.journey_id===id&&p.status==='OPEN'&&clientDate(new Date(p.due_at))===today));
  const value=Math.min(100,(phone?15:0)+Math.min(30,checklist*5)+(['now','30d'].includes(deadline)?20:deadline==='3m'?10:0)
    +(mmr&&bid?mmr<=bid*100?15:mmr<=bid*120?5:0:0)+(latest&&now-latest<86400000?10:latest&&now-latest<72*3600000?5:0));
  return {score:value,goodHour,promiseToday,bid,mmr};
}
module.exports={score,leadZip,loadScoreVehicles};

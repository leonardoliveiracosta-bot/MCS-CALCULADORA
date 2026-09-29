'use strict';
const { timezoneForZip, realisticBid, median } = require('./panel-lead');
const { effectiveCriteria, journeyDemands, normalizeDeadline, normalizePayment, orderDemand } = require('./panel-domain');
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

// A9: every screen scores with the same cars (last 60 days of live Manheim batches). The inventory
// is never read here: the database answers one reference MMR per person (median of the cars that
// serve the first wish of each demand), so CLIENTES, HOJE and the score never pull a batch.
const SCORE_INDEX = Symbol('score-index');
function scoreIndex(entries) {
  const byPerson = new Map((entries || []).map((row) => [String(row.person || ''), Number(row.mmr_cents) || null]));
  return { [SCORE_INDEX]: true, size: byPerson.size, mmrFor(keys) { for (const key of keys) { if (byPerson.has(key)) return byPerson.get(key); } return null; } };
}
const isScoreIndex = (value) => Boolean(value && value[SCORE_INDEX]);
async function loadScoreIndex(ctx, now = Date.now()) {
  const { rpc } = require('./panel-server');
  const { batchSupported } = require('./panel-manheim-state');
  // Before migration 20261005010000 there is no per-person answer: the score goes without the MMR
  // part instead of reading the whole inventory.
  if (!(await batchSupported(ctx).catch(() => false))) return scoreIndex([]);
  const since = new Date(now - 60 * 86400000).toISOString();
  const list = await rpc(ctx, 'panel_manheim_score_mmr', { p_environment: ctx.environment, p_since: since });
  return scoreIndex(Array.isArray(list) ? list : []);
}
// Old name kept for the callers: it now returns the per-person index, never the cars.
const loadScoreVehicles = loadScoreIndex;

// The demands behind a score: a ficha with its linked calculator entries (split by mode), or
// the Ref's own entries. `item.simulations` are the per-mode entries of a grouped Ref.
function scoreDemands(item={}, journey) {
  const entries=Array.isArray(item.simulations)?item.simulations:['CARRO','VALOR'].includes(item.logicalMode)?[item]:[];
  if(journey&&journey.id)return journeyDemands(journey,entries);
  return entries.map(orderDemand).filter(Boolean);
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
  const criteria=effectiveCriteria(journey,item);
  let mmr=null;
  // Only cars that serve one of the person's demands (each mode with its own rule, first wish of
  // each demand) are comparable; a demand that is not complete compares nothing.
  const demands=scoreDemands(item,journey).filter((demand)=>demand.active);
  if(isScoreIndex(vehicles)){
    if(demands.length)mmr=vehicles.mmrFor([id?'j:'+id:null,item.ref?'r:'+String(item.ref).trim().toUpperCase():null].filter(Boolean));
  }else if(demands.length){
    const comparable=vehicles.filter((vehicle)=>demands.some((demand)=>vehicleMatch.countsAsServed(vehicleMatch.matchDemand(vehicle,{...demand,wishes:demand.activeWishes.slice(0,1)})?.kind)));
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
module.exports={score,scoreDemands,leadZip,loadScoreVehicles,loadScoreIndex,scoreIndex,isScoreIndex};

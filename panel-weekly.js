'use strict';

const DAY=86400000;
const stamp=(value)=>Date.parse(value||0)||0;
const messageAt=(item)=>stamp(item.occurred_at_utc||item.occurred_at_local||item.created_at);
const inWindow=(value,start,end)=>value>=start&&value<end;
const sourceKey=(value)=>value==='WHATSAPP_DIRECT'?'whatsapp':value==='SMS_DIRECT'?'sms':value==='CALCULATOR'?'calculator':null;

function direction(value){return value>0?'up':value<0?'down':'flat';}
function compare(current,previous){return {current,previous,trend:direction(Number(current||0)-Number(previous||0))};}
function snapshot(journeys,messagesByJourney,at){
  let unanswered=0,stalled=0;
  for(const journey of journeys){
    if(stamp(journey.created_at)>at||journey.status==='ENCERRADO'||journey.enabled===false)continue;
    const list=(messagesByJourney.get(journey.id)||[]).filter((item)=>messageAt(item)<=at&&!item.is_automatic);
    const latest=list.at(-1);
    if(latest?.direction==='CUSTOMER'&&at-messageAt(latest)>DAY)unanswered++;
    const activity=Math.max(stamp(journey.created_at),...list.map(messageAt));
    if(journey.source==='CALCULATOR'&&activity&&at-activity>3*DAY)stalled++;
  }
  return {unanswered,stalled};
}
function period(data,start,end){
  const firstJourneyByContact=new Map();
  for(const journey of data.journeys){const current=firstJourneyByContact.get(journey.contact_id);if(!current||stamp(journey.created_at)<stamp(current.created_at))firstJourneyByContact.set(journey.contact_id,journey);}
  const leads={whatsapp:0,sms:0,calculator:0};
  for(const journey of firstJourneyByContact.values()){const key=sourceKey(journey.source);if(key&&inWindow(stamp(journey.created_at),start,end))leads[key]++;}
  let responded=0,totalResponseMs=0;
  for(const list of data.messagesByJourney.values()){
    const firstInbound=list.find((item)=>item.direction==='CUSTOMER');
    if(!firstInbound)continue;
    const inboundAt=messageAt(firstInbound),reply=list.find((item)=>item.direction==='MCS'&&!item.is_automatic&&messageAt(item)>=inboundAt);
    if(reply&&inWindow(messageAt(reply),start,end)){responded++;totalResponseMs+=Math.max(0,messageAt(reply)-inboundAt);}
  }
  const options=data.units.filter((item)=>inWindow(stamp(item.presented_at),start,end)).length;
  const discarded=data.dispositions.filter((item)=>item.status==='DISCARDED'&&inWindow(stamp(item.updated_at),start,end));
  const reasons=new Map();discarded.forEach((item)=>reasons.set(item.discard_reason||'OTHER',(reasons.get(item.discard_reason||'OTHER')||0)+1));
  return {leads,responded,averageResponseMinutes:responded?Math.round(totalResponseMs/responded/60000):null,options,discarded:discarded.length,reasons:[...reasons].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,3).map(([reason,count])=>({reason,count}))};
}
function buildWeeklySummary(input,now=Date.now()){
  const messagesByJourney=new Map();
  const messageById=new Map((input.messages||[]).filter((item)=>!item.undone_at).map((item)=>[item.id,item]));
  for(const link of input.messageLinks||[]){if(link.undone_at)continue;const item=messageById.get(link.message_id);if(!item)continue;if(!messagesByJourney.has(link.journey_id))messagesByJourney.set(link.journey_id,[]);messagesByJourney.get(link.journey_id).push(item);}
  messagesByJourney.forEach((list)=>list.sort((a,b)=>messageAt(a)-messageAt(b)||String(a.id).localeCompare(String(b.id))));
  const data={...input,messagesByJourney};
  const current=period(data,now-7*DAY,now),previous=period(data,now-14*DAY,now-7*DAY);
  const currentSnapshot=snapshot(input.journeys||[],messagesByJourney,now),previousSnapshot=snapshot(input.journeys||[],messagesByJourney,now-7*DAY);
  return {generatedAt:new Date(now).toISOString(),timezone:'America/New_York',leads:{whatsapp:compare(current.leads.whatsapp,previous.leads.whatsapp),sms:compare(current.leads.sms,previous.leads.sms),calculator:compare(current.leads.calculator,previous.leads.calculator)},responded:compare(current.responded,previous.responded),averageResponseMinutes:compare(current.averageResponseMinutes,previous.averageResponseMinutes),unanswered24h:compare(currentSnapshot.unanswered,previousSnapshot.unanswered),options:compare(current.options,previous.options),discarded:{...compare(current.discarded,previous.discarded),reasons:current.reasons},stalledOrders:compare(currentSnapshot.stalled,previousSnapshot.stalled)};
}

module.exports={buildWeeklySummary,messageAt};

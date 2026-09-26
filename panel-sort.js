'use strict';

const MODES=new Set(['ready','recent','oldest','value_desc','value_asc','location','vehicle']);
const text=(value)=>String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('pt-BR');
const number=(value)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):null;
const stamp=(item)=>Date.parse(item.lastCustomerAt||item.latestMessage?.occurred_at_utc||item.latestMessage?.created_at||item.occurredAt||item.updated_at||item.created_at||0)||0;
const value=(item)=>number(item.confirmed_total_ceiling_cents||item.totalCeilingCents||item.budgetCents||item.budget_cents);
const location=(item)=>[item.state||item.estado||item.contact?.location_text||'',item.city||''];
const vehicle=(item)=>[item.make||item.vehicle?.make||item.wishlists?.[0]?.make||'',item.model||item.vehicle?.model||item.wishlists?.[0]?.model||'',item.vehicleText||item.vehicle_text||''];
function nullableCompare(left,right,direction=1){if(left===null||left==='')return right===null||right===''?0:1;if(right===null||right==='')return -1;return (left<right?-1:left>right?1:0)*direction;}
function compare(mode,left,right){
  if(mode==='ready')return Number(Boolean(right.wantsCar))-Number(Boolean(left.wantsCar))||Number(Boolean(right.returnedToTalk))-Number(Boolean(left.returnedToTalk))||Number(Boolean(right.promiseToday))-Number(Boolean(left.promiseToday))||Number(right.score||0)-Number(left.score||0)||stamp(right)-stamp(left);
  if(mode==='recent'||mode==='oldest')return (stamp(right)-stamp(left))*(mode==='recent'?1:-1);
  if(mode==='value_desc'||mode==='value_asc')return nullableCompare(value(left),value(right),mode==='value_desc'?-1:1);
  if(mode==='location'){const a=location(left),b=location(right);return nullableCompare(text(a[0]),text(b[0]))||nullableCompare(text(a[1]),text(b[1]));}
  if(mode==='vehicle'){const a=vehicle(left),b=vehicle(right);return nullableCompare(text(a[0]),text(b[0]))||nullableCompare(text(a[1]),text(b[1]))||nullableCompare(text(a[2]),text(b[2]));}
  return 0;
}
function sortItems(items,mode,fallback='recent'){const selected=MODES.has(mode)?mode:fallback;return items.slice().sort((a,b)=>compare(selected,a,b)||text(a.key||a.id||a.ref).localeCompare(text(b.key||b.id||b.ref)));}
module.exports={MODES,sortItems};

'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {buildWeeklySummary}=require('../panel-weekly');
const DAY=86400000,now=Date.parse('2026-09-27T23:00:00Z'),iso=(offset)=>new Date(now+offset).toISOString();
test('weekly summary compares independent seven-day windows and excludes automatic replies',()=>{
  const journeys=[{id:'j1',contact_id:'c1',source:'WHATSAPP_DIRECT',status:'ATIVO',created_at:iso(-2*DAY)},{id:'j2',contact_id:'c2',source:'CALCULATOR',status:'ATIVO',created_at:iso(-10*DAY)}];
  const messages=[{id:'m1',direction:'CUSTOMER',created_at:iso(-2*DAY)},{id:'m2',direction:'MCS',is_automatic:true,created_at:iso(-2*DAY+1000)},{id:'m3',direction:'MCS',is_automatic:false,created_at:iso(-2*DAY+600000)},{id:'m4',direction:'CUSTOMER',created_at:iso(-5*DAY)}];
  const messageLinks=[{journey_id:'j1',message_id:'m1'},{journey_id:'j1',message_id:'m2'},{journey_id:'j1',message_id:'m3'},{journey_id:'j2',message_id:'m4'}];
  const result=buildWeeklySummary({journeys,messageLinks,messages,units:[{presented_at:iso(-DAY)}],dispositions:[{status:'DISCARDED',discard_reason:'PRICE',updated_at:iso(-DAY)}]},now);
  assert.equal(result.leads.whatsapp.current,1);assert.equal(result.leads.calculator.previous,1);assert.equal(result.responded.current,1);assert.equal(result.averageResponseMinutes.current,10);assert.equal(result.unanswered24h.current,1);assert.equal(result.options.current,1);assert.deepEqual(result.discarded.reasons,[{reason:'PRICE',count:1}]);assert.equal(result.stalledOrders.current,1);
});
test('weekly UI persists disclosure and makes overdue metric clickable',()=>{const html=require('node:fs').readFileSync('painel/index.html','utf8'),panel=require('node:fs').readFileSync('painel/painel.js','utf8');assert.match(html,/id="weekly-summary"/);assert.match(panel,/mcs_weekly_open/);assert.match(panel,/todayStatFilter='late24'/);});

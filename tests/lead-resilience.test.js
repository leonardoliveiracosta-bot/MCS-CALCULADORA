'use strict';
process.env.VERCEL_ENV='preview';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const journeyId='e2670fbb-ab0d-40f4-ac3a-fc9bb8ed5f5c';

function loadWith(relative,mocks){
  const file=path.join(root,relative),mod={exports:{}};
  const localRequire=(name)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);return mod.exports;
}
function response(){return {code:0,payload:null,setHeader(){},status(code){this.code=code;return this;},json(payload){this.payload=payload;return payload;}};}

test('HFAR4-shaped FIND lead with a confirmed empty note remains readable',async()=>{
  const lead={ref:'HFAR4',hasCalculatorRef:true,order:{ref:'HFAR4',logicalMode:'CARRO',budgetCents:null,paymentText:null,wishlists:[{make:'Audi',model:'S5',yearMin:2017,yearMax:2021,maxMiles:75000}]},record:{id:journeyId,contact_id:'e9a79679-8f52-4524-be30-8c5ad730fb5b',payment_text:'cash',phones:[],conversation:[],checklist:[],promises:[]},notes:[{distributed_json:[]}],events:[{event_type:'NOTE_CONFIRMED'}],timezone:'America/New_York',wishes:[],offers:[],maxBidCents:null,payment:'cash'};
  const server={requirePanel:async()=>({environment:'production',panel:{id:'f967d9d4-a01d-4a30-a839-ae5a039a9b88'},config:{}}),send:(res,code,payload)=>res.status(code).json(payload)};
  const handler=loadWith('api/panel/lead.js',{'../../panel-server':server,'../../panel-lead':{leadData:async()=>lead,ensureJourney:async()=>lead.record,localToUtc:()=>null,addClientDays:()=>null},'../../panel-note':{}});
  const res=response();await handler({method:'GET',query:{ref:'HFAR4',id:journeyId}},res);
  assert.equal(res.code,200);assert.equal(res.payload.ref,'HFAR4');assert.deepEqual(res.payload.notes[0].distributed_json,[]);
});

test('a lead still opens when optional note history cannot be read',async()=>{
  const domain=require('../panel-domain');
  const run={id:'run-hfar4',created_at:'2026-09-27T03:35:00.000Z',zip:'07036',estado:'NJ',lance:null,pagamento:null,is_test:false,dados:{ref:'HFAR4',evento:'busca',canal:'sms',nome:'Quyel Mack',marca:'Audi',modelo:'S5',anoMin:2017,anoMax:2021,maxMiles:75000}};
  const journey={id:journeyId,reference_code:'HFAR4',contact_id:'e9a79679-8f52-4524-be30-8c5ad730fb5b',criteria_json:{wishlists:[]},budget_cents:null,payment_text:'cash',confirmed_total_ceiling_cents:null};
  const server={
    allRows:async(_ctx,table)=>{if(table==='calc_runs')return[run];if(table==='lead_notes')throw Error('optional note read failed');if(table==='journey_refs')return[{journey_id:journeyId,ref_code:'HFAR4'}];return[];},
    rows:async(_ctx,table)=>table==='journeys'?[journey]:table==='lead_tracking'?[{id:'track',ref_code:'HFAR4',journey_id:journeyId,public_code:'code'}]:[],
    insert:async()=>[],patchRows:async()=>[],supabase:async()=>[],isUuid:(value)=>/^[0-9a-f-]{36}$/i.test(String(value))
  };
  const recordHandler=async(_req,res)=>res.status(200).json({item:{...journey,contact:{display_name:'Quyel Mack',location_text:null},phones:[],wishlists:[],conversation:[],checklist:[],promises:[]}});
  const lead=loadWith('panel-lead.js',{'./panel-server':server,'./panel-domain':domain,'./api/panel/records':recordHandler});
  const value=await lead.leadData({environment:'production',config:{}},{},'HFAR4',journeyId);
  assert.equal(value.ref,'HFAR4');assert.deepEqual(value.notes,[]);
});

test('the panel AI module exports every runtime entrypoint used by cron and manual reading',()=>{
  const ai=require('../panel-ai');
  for(const name of ['runCron','readConversation','suggestLink','latestAiForJourney']) assert.equal(typeof ai[name],'function',name);
});

test('lead failures return a support requestId without exposing internals',async()=>{
  const server={requirePanel:async()=>({environment:'production',panel:{id:'x'},config:{}}),send:(res,code,payload)=>res.status(code).json(payload)};
  const handler=loadWith('api/panel/lead.js',{'../../panel-server':server,'../../panel-lead':{leadData:async()=>{throw new Error('sensitive database detail');}},'../../panel-note':{}});
  const res=response();await handler({method:'GET',query:{ref:'HFAR4'}},res);
  assert.equal(res.code,500);assert.equal(res.payload.error,'LEAD_ACTION_FAILED');assert.match(res.payload.requestId,/^[0-9a-f]{8}$/);assert.equal(JSON.stringify(res.payload).includes('sensitive'),false);
});

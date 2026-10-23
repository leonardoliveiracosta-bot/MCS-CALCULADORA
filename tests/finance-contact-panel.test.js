'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const id='f3eedafa-6b3d-4cca-801c-0b934f0d0e9c',answers={credit_profile:'very_good',down_payment:'2500_5000',monthly_payment:'400_600',trade_in:'yes'};
const model=require('../finance-model');
function load(server){const mod={exports:{}};new Function('require','module','exports',fs.readFileSync(path.join(__dirname,'../api/panel/contact-requests.js'),'utf8'))(name=>name==='../../panel-server'?server:require(path.resolve(__dirname,'../api/panel',name)),mod,mod.exports);return mod.exports;}
const response=()=>({status(c){this.code=c;return this;},json(data){this.data=data;return data;}});
test('finance contact card receives Ref and all four answers by request key with environment isolation',async()=>{
  const ctx={environment:'preview'},calls=[],contact={id,request_key:id,name:'Finance Test',phone_e164:'+12025550123',channel:'CALL',source:'finance'};
  const serve=load({requirePanel:async()=>ctx,isUuid:require('../panel-server').isUuid,rows:async(_ctx,table,filters)=>{calls.push({table,filters});if(table==='calc_runs'){assert.equal(filters.is_test,'eq.true');assert.equal(filters.id,'in.('+id+')');return [{id,dados:{tipo:'finance',ref:'FNA23',finance:answers}}];}return filters.status==='eq.OPEN'?[contact]:[];},send:(r,c,p)=>r.status(c).json(p)});
  const res=response();await serve({method:'GET',query:{}},res);assert.equal(res.code,200);
  assert.deepEqual(res.data.items[0].finance,{ref:'FNA23',details:model.details(answers,'pt')});assert.equal(res.data.items[0].phone_e164,contact.phone_e164);assert.equal(res.data.items[0].name,contact.name);assert.equal(res.data.items[0].request_key,undefined);assert.equal(calls.length,3);
});
test('non-financing requests retain their response and make no additional database read',async()=>{
  let calls=0;const item={id,name:'Regular Contact',source:'footer',phone_e164:'+12025550123'};
  const serve=load({requirePanel:async()=>({environment:'production'}),isUuid:require('../panel-server').isUuid,rows:async(_ctx,table,filters)=>{calls++;assert.equal(table,'site_contact_requests');return filters.status==='eq.OPEN'?[item]:[];},send:(r,c,p)=>r.status(c).json(p)});
  const res=response();await serve({method:'GET',query:{}},res);assert.deepEqual(res.data.items,[item]);assert.equal(calls,2);
});
test('a missing finance context is marked unavailable and database errors stay errors',async()=>{
  for(const broken of [false,true]){
    const serve=load({requirePanel:async()=>({environment:'production'}),isUuid:require('../panel-server').isUuid,rows:async(_ctx,table,filters)=>{if(table==='calc_runs'){if(broken)throw Error('DB');return [];}return filters.status==='eq.OPEN'?[{id,request_key:id,source:'finance'}]:[];},send:(r,c,p)=>r.status(c).json(p)});
    const res=response();await serve({method:'GET',query:{}},res);assert.equal(res.code,broken?503:200);if(!broken)assert.equal(res.data.items[0].finance,null);
  }
});

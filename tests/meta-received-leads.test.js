'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {configuration,eventFor,deliver,processReceivedLeads}=require('../meta-received-leads');
const row=()=>({id:'a'.repeat(64),phone_hash:'b'.repeat(64),occurred_at:new Date(Date.now()-60000).toISOString(),logical_mode:'VALOR',channel:'WHATSAPP',claim_id:'lease',body_text:'PRIVATE',price:30000,name:'PRIVATE'});
test('integration defaults off, fails closed without credentials/date/version and never runs in preview',()=>{
  const env={VERCEL_ENV:'production',META_RECEIVED_LEADS_ENABLED:'true',META_CAPI_ACCESS_TOKEN:'secret',META_GRAPH_VERSION:'v25.0',META_RECEIVED_LEADS_SINCE:'2026-10-17T14:00:00Z'};
  assert.ok(configuration(env));
  for(const override of [{VERCEL_ENV:'preview'},{META_RECEIVED_LEADS_ENABLED:'false'},{META_CAPI_ACCESS_TOKEN:''},{META_RECEIVED_LEADS_SINCE:'invalid'},{META_GRAPH_VERSION:'invalid'}])assert.equal(configuration({...env,...override}),null);
});
test('only a recent valid hashed received contact becomes Lead; event excludes private fields',()=>{
  const event=eventFor(row());
  assert.equal(event.event_name,'Lead');assert.equal(event.action_source,'chat');
  assert.deepEqual(Object.keys(event.user_data),['ph']);
  assert.equal(JSON.stringify(event).includes('PRIVATE'),false);
  for(const override of [{phone_hash:'+13055550100'},{occurred_at:new Date(Date.now()+60000).toISOString()},{occurred_at:new Date(Date.now()-8*86400000).toISOString()},{channel:'IMPORT'},{logical_mode:'UNKNOWN'}])assert.equal(eventFor({...row(),...override}),null);
});
test('transport uses one fixed Meta dataset, header-only secret and validates actual acceptance',async()=>{
  let request;const config={token:'private-token',version:'v25.0'};
  const result=await deliver(eventFor(row()),config,async(url,options)=>{request={url,options};return {ok:true,json:async()=>({events_received:1})};});
  assert.equal(result.accepted,true);assert.equal(request.url,'https://graph.facebook.com/v25.0/2308379543262592/events');
  assert.equal(request.url.includes(config.token),false);assert.equal(request.options.headers.authorization,'Bearer '+config.token);
  assert.equal(JSON.stringify(JSON.parse(request.options.body)).includes(config.token),false);
  const denied=await deliver(eventFor(row()),config,async()=>({ok:false,status:401,json:async()=>({error:{message:'sensitive detail'}})}));
  assert.deepEqual(denied,{accepted:false,code:'META_HTTP_401'});
  assert.equal((await deliver(eventFor(row()),config,async()=>({ok:true,json:async()=>({events_received:0})}))).accepted,false);
});
test('disabled integration reads nothing; deliveries acknowledge the exact lease and retry failures without PII',async()=>{
  let calls=[];const deps={configuration:()=>null,rpc:async(...args)=>calls.push(args),deliver:async()=>{throw Error('not expected');}};
  assert.deepEqual(await processReceivedLeads({environment:'production'},{},deps),{disabled:true});assert.equal(calls.length,0);
  deps.configuration=()=>({since:'2026-10-17T00:00:00Z'});
  deps.rpc=async(ctx,name,args)=>{calls.push({name,args});return name.endsWith('_claim')?[row()]:true;};
  deps.deliver=async()=>{throw Error('private provider details');};
  assert.equal((await processReceivedLeads({environment:'production'},{},deps)).failed,1);
  assert.deepEqual(calls[1].args,{p_id:'a'.repeat(64),p_claim:'lease',p_accepted:false,p_error:'META_UNAVAILABLE'});
  assert.equal(JSON.stringify(calls).includes('private provider'),false);
});
test('browser privacy decision is persisted for both calculator paths without adding user steps',()=>{
  const fs=require('node:fs'),html=fs.readFileSync(require('node:path').join(__dirname,'../msc-calculadora.html'),'utf8');
  assert.equal((html.match(/meta_measurement_allowed:/g)||[]).length,2);
  const create=require('../calc-meta-events');
  const win={location:{hostname:'mycarscout.net',pathname:'/msc-calculadora.html'},navigator:{globalPrivacyControl:true}};
  assert.equal(create(win).allowed,false);
  win.navigator={};win.fbq=()=>{};assert.equal(create(win).allowed,true);
});

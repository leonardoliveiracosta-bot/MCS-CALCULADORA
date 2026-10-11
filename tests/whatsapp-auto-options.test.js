'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {maybeAutoOptions,explanation}=require('../whatsapp-auto-options');
const {sendMessage,recordSent}=require('../whatsapp-auto-reply');
const ctx={environment:'preview',config:{url:'https://db.invalid',secretKey:'unit'}};
const item={messageId:'wamid.in',phone:'+13055550122',direction:'CUSTOMER',eventField:'messages',source_kind:'WHATSAPP_WEBHOOK',body:'My Car Scout · FIND · Vehicle search request\nYear range: 2019–2021\nRef: 6CFB3'};
const result={messageId:'in',contactId:'contact',journeyId:'journey'};
const options={greeting:{sent:true}};
function fixture(overrides={}){
  const events=[],state={context:{eligible:true,key:'journey:10000000-0000-4000-8000-000000000001:CARRO',language:'en'},claim:{claimed:true,id:'job'},offers:[{id:'car',final_cents:1000000}],...overrides};
  const deps={
    call:async(_ctx,name,args)=>{events.push({name,args});if(name.endsWith('_context'))return state.context;if(name.endsWith('_claim'))return state.claim;if(name==='panel_manheim_offer_page')return typeof state.offers==='function'?state.offers(args):state.offers;if(name.endsWith('_advance')){if(state.advanceFailure===args.p_stage)throw Error('DB_FAILED');return {updated:true};}throw Error(name);},
    latestActiveUpload:async()=>state.noUpload?null:{id:'upload'},linkFor:async(_ctx,key)=>{events.push({name:'link',key});return 'a'.repeat(43);},
    sendMessage:async(target,body,timeout)=>{events.push({name:'send',target,body,timeout});if(state.failSend===events.filter(e=>e.name==='send').length)throw Error('D360_NETWORK_ERROR');return 'wamid.out.'+events.filter(e=>e.name==='send').length;},
    recordSent:async(_ctx,raw,target,wamid,body)=>{events.push({name:'record',raw,target,wamid,body});if(state.recordFailure)throw Error('DB_FAILED');}
  };return {events,deps};
}
async function enabled(run){const names=['AUTO_REPLY_ENABLED','AUTO_OPTIONS_ENABLED','VERCEL_ENV'],previous=names.map(n=>process.env[n]);process.env.AUTO_REPLY_ENABLED='true';delete process.env.AUTO_OPTIONS_ENABLED;delete process.env.VERCEL_ENV;try{await run();}finally{names.forEach((n,i)=>{if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i];});}}
test('calculator CARRO sends the same manual link then explanation as separate messages',()=>enabled(async()=>{
  const {events,deps}=fixture();assert.equal((await maybeAutoOptions(ctx,'raw',item,result,options,deps)).sent,true);
  const sends=events.filter(e=>e.name==='send');assert.equal(sends.length,2);assert.equal(sends[0].body,'Current options:\nhttps://www.mycarscout.net/o/'+'a'.repeat(43));assert.equal(sends[1].body,explanation('en'));assert.equal(sends[0].target,item);assert.equal(sends[0].timeout,8000);
  assert.deepEqual(events.filter(e=>e.name.endsWith('_advance')).map(e=>e.args.p_stage),['LINK_SENDING','LINK_SENT','EXPLANATION_SENDING','COMPLETE']);
  const records=events.filter(e=>e.name==='record');assert.equal(records.length,2);assert.ok(events.findIndex(e=>e.name.endsWith('_advance')&&e.args.p_stage==='LINK_SENT')<events.findIndex(e=>e.name==='record'));
  assert.equal(events.find(e=>e.name==='link').key,events.find(e=>e.name==='panel_manheim_offer_page').args.p_demand_key);
}));
test('VALOR keeps its own mode and language; OFFLANE and INCOMPLETE count too',()=>enabled(async()=>{
  for(const group of ['OFFLANE','INCOMPLETE']){
    const {events,deps}=fixture({context:{eligible:true,key:'journey:10000000-0000-4000-8000-000000000001:VALOR',language:'pt-BR'},offers:args=>args.p_group===group?[{id:'car',final_cents:900000}]:[]});
    await maybeAutoOptions(ctx,'raw',{...item,body:'My Car Scout · Calculate My Cost\nMaximum bid: $8,000\nRef: 6CFB3'},result,options,deps);
    assert.equal(events.find(e=>e.name.endsWith('_context')).args.p_mode,'VALOR');assert.equal(events.filter(e=>e.name==='send')[1].body,explanation('pt'));
  }
  assert.match(explanation('es'),/referencia de mercado/);assert.equal(explanation('unknown'),explanation('en'));assert.match(explanation('en'),/goal/);assert.match(explanation('en'),/pricing review/);
}));
test('no Ref, a random code, unknown mode, multiple Refs, opt-out and plain YES never query or send',()=>enabled(async()=>{
  for(const body of ['YES','Ref: 6CFB3','My Car Scout Ref: 6CFB3','My Car Scout · FIND · 6CFB3',item.body+'\nRef: ABC23',item.body+'\nSTOP']){
    const {events,deps}=fixture();const outcome=await maybeAutoOptions(ctx,'raw',{...item,body},result,options,deps);assert.equal(outcome.sent,false,body);assert.equal(events.length,0,body);
  }
}));
test('history, duplicate, vitrine, missing stored identities, preview and switches are blocked',()=>enabled(async()=>{
  for(const [inbound,stored] of [[{...item,source_kind:'WHATSAPP_HISTORY'},result],[item,{...result,duplicate:true}],[item,{...result,vitrineHandled:true}],[item,{...result,journeyId:null}],[{...item,direction:'MCS'},result]]){
    const {events,deps}=fixture();assert.equal((await maybeAutoOptions(ctx,'raw',inbound,stored,options,deps)).sent,false);assert.equal(events.length,0);
  }
  for(const [name,value] of [['AUTO_REPLY_ENABLED','false'],['AUTO_OPTIONS_ENABLED','false'],['VERCEL_ENV','preview']]){
    const previous=process.env[name];process.env[name]=value;const {events,deps}=fixture();assert.equal((await maybeAutoOptions(ctx,'raw',item,result,options,deps)).sent,false);assert.equal(events.length,0);if(previous===undefined)delete process.env[name];else process.env[name]=previous;
  }
}));
test('failed greeting blocks options; a skipped recent welcome can still accompany a new request',()=>enabled(async()=>{
  for(const greeting of [null,{sent:false,reason:'D360_NETWORK_ERROR'},{sent:false,reason:'ALREADY_CLAIMED'},{sent:false,reason:'CLAIM_FAILED'}]){
    const {events,deps}=fixture();assert.equal((await maybeAutoOptions(ctx,'raw',item,result,{greeting},deps)).sent,false);assert.equal(events.length,0);
  }
  const {deps}=fixture();assert.equal((await maybeAutoOptions(ctx,'raw',item,result,{greeting:{sent:false,reason:'RECENT_MESSAGE'}},deps)).sent,true);
}));
test('database denies wrong person, stale, missing real calculator, inactive and previously claimed requests',()=>enabled(async()=>{
  for(const reason of ['CALCULATOR_PHONE_CONFLICT','REF_OWNERSHIP_CONFLICT','INBOUND_NOT_ELIGIBLE','NO_CALCULATOR_RECORD','REQUEST_NOT_ACTIVE','ALREADY_CLAIMED']){
    const {events,deps}=fixture({context:{eligible:false,reason}});assert.equal((await maybeAutoOptions(ctx,'raw',item,result,options,deps)).reason,reason);assert.equal(events.filter(e=>e.name==='send'||e.name==='link').length,0);
  }
  const {events,deps}=fixture({claim:{claimed:false,reason:'ALREADY_CLAIMED'}});await maybeAutoOptions(ctx,'raw',item,result,options,deps);assert.equal(events.filter(e=>e.name==='send').length,0);
}));
test('no current options or a depleted time budget leaves the request unclaimed',()=>enabled(async()=>{
  for(const overrides of [{noUpload:true},{offers:[]},{offers:[{id:'bad',final_cents:0}]}]){
    const {events,deps}=fixture(overrides);assert.equal((await maybeAutoOptions(ctx,'raw',item,result,options,deps)).reason,'NO_OPTIONS');assert.equal(events.filter(e=>e.name==='send'||e.name.endsWith('_claim')).length,0);
  }
  const {events,deps}=fixture();assert.equal((await maybeAutoOptions(ctx,'raw',item,result,{...options,deadlineAt:Date.now()+500},deps)).reason,'DEADLINE');assert.equal(events.length,0);
}));
test('failed link prevents explanation; failed acknowledgement persistence also stops the sequence',()=>enabled(async()=>{
  for(const overrides of [{failSend:1},{advanceFailure:'LINK_SENT'}]){
    const {events,deps}=fixture(overrides);assert.equal((await maybeAutoOptions(ctx,'raw',item,result,options,deps)).sent,false);assert.equal(events.filter(e=>e.name==='send').length,1);assert.equal(events.at(-1).args.p_stage,'FAILED');
  }
  const {events,deps}=fixture({failSend:2});await maybeAutoOptions(ctx,'raw',item,result,options,deps);assert.equal(events.filter(e=>e.name==='send').length,2);assert.equal(events.at(-1).args.p_stage,'FAILED');
}));
test('recording failure preserves provider acknowledgements without resending',()=>enabled(async()=>{
  const {events,deps}=fixture({recordFailure:true});assert.equal((await maybeAutoOptions(ctx,'raw',item,result,options,deps)).sent,true);assert.equal(events.filter(e=>e.name==='send').length,2);assert.equal(events.filter(e=>e.name.endsWith('_advance')&&e.args.p_error==='PANEL_RECORD_FAILED').length,2);
}));
test('existing 360dialog transport accepts the exact custom body and BSUID fallback',async()=>{
  const before={fetch:global.fetch,key:process.env.D360_API_KEY,env:process.env.VERCEL_ENV};process.env.D360_API_KEY='unit';delete process.env.VERCEL_ENV;
  try{let posted;global.fetch=async(_url,request)=>{posted=JSON.parse(request.body);assert.ok(request.signal);return {ok:true,json:async()=>({messages:[{id:'wamid.bsuid'}]})};};
    assert.equal(await sendMessage({userId:'US.abc'},'separate link',8000),'wamid.bsuid');assert.equal(posted.recipient,'US.abc');assert.equal(posted.text.body,'separate link');assert.equal(posted.to,undefined);
    global.fetch=async(_url,request)=>{posted=JSON.parse(request.body);return {ok:true,status:200,text:async()=>JSON.stringify({messageId:'recorded'})};};
    await recordSent(ctx,'raw',{phone:item.phone},'wamid.sent','exact custom body');assert.equal(posted.p_item.body,'exact custom body');assert.equal(posted.p_item.direction,'MCS');
  }finally{global.fetch=before.fetch;for(const [name,value] of [['D360_API_KEY',before.key],['VERCEL_ENV',before.env]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});

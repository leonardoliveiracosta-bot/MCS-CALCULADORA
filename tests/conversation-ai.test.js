'use strict';
process.env.VERCEL_ENV='preview';
process.env.ANTHROPIC_API_KEY='test-key';
process.env.ANTHROPIC_MODEL='test-model';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const domain=require('../panel-domain');
const note=require('../panel-note');
const root=path.join(__dirname,'..');
const ids={journey:'11111111-1111-4111-8111-111111111111',contact:'22222222-2222-4222-8222-222222222222',chat:'33333333-3333-4333-8333-333333333333',customer:'44444444-4444-4444-8444-444444444444',actor:'55555555-5555-4555-8555-555555555555'};

function loadWith(relative,mocks){const file=path.join(root,relative),mod={exports:{}};const localRequire=(name)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:name==='../../panel-capture'?{runCaptureCheck:async()=>({missingRefs:[]}),recordCaptureFailure:async()=>{}}:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);return mod.exports;}
function response(){return {code:0,payload:null,setHeader(){},status(code){this.code=code;return this;},json(payload){this.payload=payload;return payload;}};}
function aiResponse(value){return {ok:true,json:async()=>({content:[{type:'text',text:JSON.stringify(value)}]})};}
function fixture(mcsCount,{withRef=true}={}){
  const customerAt=new Date(Date.now()-11*60000).toISOString();
  const messages=[...Array(mcsCount)].map((_,index)=>({id:`00000000-0000-4000-8000-${String(index+10).padStart(12,'0')}`,chat_id:ids.chat,direction:'MCS',body_text:'Mensagem MCS '+index,occurred_at_utc:new Date(Date.now()-(30-index)*60000).toISOString()}));
  messages.push({id:ids.customer,chat_id:ids.chat,direction:'CUSTOMER',body_text:'Prefiro Audi Q7 e pago cash',occurred_at_utc:customerAt});
  return {journeys:[{id:ids.journey,contact_id:ids.contact,reference_code:withRef?'ABC23':null,criteria_json:{wishlists:[]}}],contacts:[{id:ids.contact,display_name:'João',location_text:'ZIP 33101'}],messages,
    links:messages.map((message)=>({journey_id:ids.journey,message_id:message.id})),refs:[],readings:[],states:[],attempts:[],suggestions:[],calcRuns:[]};
}
function serverFor(data,calls){return {
  allRows:async(_ctx,table)=>({journeys:data.journeys,contacts:data.contacts,message_journeys:data.links,messages:data.messages,journey_refs:data.refs,
    conversation_ai_readings:data.readings,conversation_ai_link_state:data.states,conversation_ai_attempt_state:data.attempts,calc_runs:data.calcRuns,calculator_request_links:[],whatsapp_link_suggestions:data.suggestions,contact_phones:[{phone_e164:'+13055550123'}]}[table]||[]),
  rows:async(_ctx,table)=>table==='conversation_ai_link_state'?data.states:table==='whatsapp_link_suggestions'?data.suggestions:table==='contact_phones'?[{phone_e164:'+13055550123'}]:[],
  insert:async(_ctx,table,payload)=>{if(table==='conversation_ai_link_state')data.states.push(payload);if(table==='whatsapp_link_suggestions'){const row={id:'66666666-6666-4666-8666-666666666666',...payload};data.suggestions.push(row);return[row];}return[];},
  patchRows:async()=>[],
  supabase:async(_url,_key,endpoint,options)=>{calls.push(endpoint);if(endpoint.endsWith('panel_ai_reserve_call'))return {allowed:true,count:1};if(endpoint.endsWith('panel_ai_replace_reading')){const body=JSON.parse(options.body);return {readingId:'77777777-7777-4777-8777-777777777777',pending:body.p_items.length};}if(endpoint.endsWith('panel_ai_record_attempt'))return {ok:true};throw Error('unexpected '+endpoint);}
};}
function loadAi(server){return loadWith('panel-ai.js',{'./panel-server':server,'./panel-domain':domain,'./panel-note':note,'./panel-lead':{timezoneForZip:()=> 'America/New_York'}});}

test('automatic reading requires 10 MCS messages and does not reread the same customer message',async()=>{
  const calls=[];let data=fixture(9),server=serverFor(data,calls),ai=loadAi(server);
  await ai.runCron({environment:'preview',config:{url:'x',secretKey:'k'}},{fetchImpl:async()=>aiResponse({summary:{want:'Audi',money:'Cash',missing:'Prazo'},items:[]})});
  assert.equal(calls.length,0);
  data=fixture(10);server=serverFor(data,calls);ai=loadAi(server);
  const first=await ai.runCron({environment:'preview',config:{url:'x',secretKey:'k'}},{fetchImpl:async()=>aiResponse({summary:{want:'Audi',money:'Cash',missing:'Prazo'},items:[]})});
  assert.equal(first.readings,1);assert.equal(calls.filter((call)=>call.endsWith('panel_ai_reserve_call')).length,1);
  data.readings=[{id:'77777777-7777-4777-8777-777777777777',journey_id:ids.journey,chat_id:ids.chat,last_customer_message_id:ids.customer,status:'ACTIVE'}];calls.length=0;
  await ai.runCron({environment:'preview',config:{url:'x',secretKey:'k'}},{fetchImpl:async()=>{throw Error('should not call');}});
  assert.equal(calls.length,0);
});

test('literal customer evidence is mandatory and total ceiling is always manual',()=>{
  const ai=loadAi(serverFor(fixture(10),[]));
  const parsed={summary:{want:'Q7',money:'30 mil',missing:'Prazo'},items:[
    {type:'payment',value:'cash',evidence:'Prefiro Audi Q7 e pago cash'},
    {type:'deadline',value:'30d',evidence:'frase inventada'},
    {type:'budget',value:30000,evidence:'30 mil no total'}
  ]};
  const result=ai.validatedReading(parsed,'Cliente: Prefiro Audi Q7 e pago cash\nCliente: 30 mil no total',{wishes:[],timezone:'America/New_York'},['Prefiro Audi Q7 e pago cash','30 mil no total']);
  assert.deepEqual(result.items.map((entry)=>entry.item.type),['payment','budget']);
  assert.equal(result.items[1].manualReview,true);
});

test('AI link suggestion runs once until rejection or a newer calculator order',async()=>{
  const calls=[],data=fixture(0,{withRef:false}),orderAt=new Date(Date.now()-20*60000).toISOString();
  data.messages[0].body_text='Sou João e quero Audi Q7';
  data.calcRuns=[{id:1,created_at:orderAt,is_test:false,dados:{sid:'sid-1',ref:'K7QPD',evento:'simulacao',quando:orderAt,nome:'João',marca:'Audi',modelo:'Q7',lance:25000}}];
  const server=serverFor(data,calls),ai=loadAi(server),fetchImpl=async()=>aiResponse({ref:'K7QPD',reasons:['mesmo nome','mesmo carro']});
  const first=await ai.runCron({environment:'preview',config:{url:'x',secretKey:'k'}},{fetchImpl});
  assert.equal(first.suggestions,1);assert.equal(data.suggestions.length,1);assert.equal(data.states.length,1);
  calls.length=0;const second=await ai.runCron({environment:'preview',config:{url:'x',secretKey:'k'}},{fetchImpl});
  assert.equal(second.suggestions,0);assert.equal(calls.length,0);
});

test('cron fails closed: missing CRON_SECRET is 503 and missing bearer is 401',async()=>{
  const server={configuration:()=>({}),SERVER_ENVIRONMENT:'production',send:(res,code,payload)=>res.status(code).json(payload)};
  const handler=loadWith('api/panel/ai-cron.js',{'../../panel-server':server,'../../panel-ai':{runCron:async()=>({})}});
  const saved=process.env.CRON_SECRET;delete process.env.CRON_SECRET;
  let res=response();await handler({method:'GET',headers:{}},res);assert.equal(res.code,503);
  process.env.CRON_SECRET='cron-test';res=response();await handler({method:'GET',headers:{}},res);assert.equal(res.code,401);
  if(saved===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=saved;
});

test('the daily cron keeps running when a general reading is paused or limited, and yields only while active',async()=>{
  const saved=process.env.CRON_SECRET;process.env.CRON_SECRET='cron-test';
  for(const status of ['PAUSED','LIMIT','DONE','IDLE']){
    let daily=0,batches=0;
    const server={configuration:()=>({}),SERVER_ENVIRONMENT:'production',send:(res,code,payload)=>res.status(code).json(payload)};
    const handler=loadWith('api/panel/ai-cron.js',{
      '../../panel-server':server,
      '../../panel-ai':{runCron:async()=>{daily++;return {processed:1};}},
      '../../panel-pendencias':{generalStatus:async()=>({run:{status}}),generalBatch:async()=>{batches++;return {status}}}
    });
    const res=response();await handler({method:'GET',headers:{authorization:'Bearer cron-test'}},res);
    assert.equal(res.code,200);assert.equal(daily,1);assert.equal(batches,0);
  }
  let daily=0,batches=0;
  const server={configuration:()=>({}),SERVER_ENVIRONMENT:'production',send:(res,code,payload)=>res.status(code).json(payload)};
  const handler=loadWith('api/panel/ai-cron.js',{
    '../../panel-server':server,
    '../../panel-ai':{runCron:async()=>{daily++;return {processed:1};}},
    '../../panel-pendencias':{generalStatus:async()=>({run:{status:'ACTIVE'}}),generalBatch:async()=>{batches++;return {status:'ACTIVE'};}}
  });
  const res=response();await handler({method:'GET',headers:{authorization:'Bearer cron-test'}},res);
  assert.equal(res.code,200);assert.equal(daily,0);assert.equal(batches,1);
  if(saved===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=saved;
});

test('capture failure is isolated and does not stop the AI cron',async()=>{
  const saved=process.env.CRON_SECRET;process.env.CRON_SECRET='cron-test';let daily=0,recorded=0;
  const server={configuration:()=>({}),SERVER_ENVIRONMENT:'production',send:(res,code,payload)=>res.status(code).json(payload)};
  const handler=loadWith('api/panel/ai-cron.js',{'../../panel-server':server,'../../panel-ai':{runCron:async()=>{daily++;return {processed:1};}},'../../panel-pendencias':{generalStatus:async()=>({run:{status:'IDLE'}})},'../../panel-capture':{runCaptureCheck:async()=>{throw Error('database')},recordCaptureFailure:async()=>{recorded++;}}});
  const res=response();await handler({method:'GET',headers:{authorization:'Bearer cron-test'}},res);
  assert.equal(res.code,200);assert.equal(daily,1);assert.equal(recorded,1);assert.equal(res.payload.capture.error,'CAPTURE_CHECK_FAILED');
  if(saved===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=saved;
});

test('Anthropic failure returns IA unavailable without breaking the manual panel route',async()=>{
  const server={requirePanel:async()=>({environment:'preview',panel:{id:ids.actor},config:{url:'x',secretKey:'k'}}),jsonBody:async(req)=>req.body,isUuid:()=>true,send:(res,code,payload)=>res.status(code).json(payload)};
  const handler=loadWith('api/panel/ai-conversations.js',{'../../panel-server':server,'../../panel-ai':{allConversationData:async()=>[{journey:{id:ids.journey},lastCustomer:{},chatId:ids.chat}],readConversation:async()=>{throw Error('AI_UNAVAILABLE');}}});
  const res=response();await handler({method:'POST',body:{action:'read',journeyId:ids.journey}},res);
  assert.equal(res.code,503);assert.equal(res.payload.message,'IA indisponível');
});

test('long conversations send only the newest 150 messages and never exceed 40,000 characters',()=>{
  const data=fixture(400);
  data.messages.forEach((message,index)=>{message.body_text=`${index}:`+'x'.repeat(500);});
  const ai=loadAi(serverFor(data,[]));
  const prompt=ai.aiContextWindow(data.messages,25000,'America/New_York');
  assert.ok(prompt.messages.length<=150);
  assert.ok(prompt.user.length<=40000);
  assert.equal(prompt.messages.at(-1).text,data.messages.at(-1).body_text);
  assert.equal(prompt.truncated,true);
});

test('automatic failures wait six hours and stop after three until a new customer message',()=>{
  const ai=loadAi(serverFor(fixture(10),[]));
  const now=Date.now(),group={lastCustomer:{id:ids.customer},attemptState:{last_customer_message_id:ids.customer,last_failure_at:new Date(now-5*60*60*1000).toISOString(),consecutive_failures:1}};
  assert.equal(ai.automaticAttemptAllowed(group,now),false);
  group.attemptState.last_failure_at=new Date(now-7*60*60*1000).toISOString();
  assert.equal(ai.automaticAttemptAllowed(group,now),true);
  group.attemptState.consecutive_failures=3;
  assert.equal(ai.automaticAttemptAllowed(group,now),false);
  group.lastCustomer={id:'nova-mensagem'};
  assert.equal(ai.automaticAttemptAllowed(group,now),true);
});

test('openai-cron reads new PESQUISAS conversations only when the extraction is on, 5 at most, and a failure is isolated',async()=>{
  const saved=process.env.CRON_SECRET;process.env.CRON_SECRET='cron-test';
  const server={configuration:()=>({}),SERVER_ENVIRONMENT:'production',send:(res,code,payload)=>res.status(code).json(payload)};
  const run=async(status,extractHistory)=>{
    const handler=loadWith('api/panel/openai-cron.js',{'../../panel-server':server,'../../panel-triage':{runTriage:async()=>({skipped:'DESLIGADA'})},'../../panel-manheim-audit':{status:()=>'DESLIGADA'},'../../panel-buscas-view':{manheimView:async()=>({})},
      '../../panel-search-requests':{extractionStatus:()=>status},'./pesquisas':{extractHistory}});
    const res=response();await handler({method:'GET',headers:{authorization:'Bearer cron-test'}},res);return res;
  };
  const calls=[];
  let res=await run('LIGADA',async(ctx,limit,options)=>{calls.push({limit,deadline:typeof options.deadlineAt});return {processed:1};});
  assert.equal(res.code,200);assert.deepEqual(calls,[{limit:5,deadline:'number'}]);assert.deepEqual(res.payload.searchRequests,{processed:1});
  res=await run('DESLIGADA',async()=>{throw Error('não deveria ler');});
  assert.equal(res.code,200);assert.deepEqual(res.payload.searchRequests,{skipped:'DESLIGADA'});
  res=await run('LIGADA',async()=>{throw Error('OPENAI_QUOTA');});
  assert.equal(res.code,200);assert.equal(res.payload.searchRequests.error,'SEARCH_REQUESTS_FAILED');
  if(saved===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=saved;
});

test('ai-cron keeps only Claude and maintenance; the OpenAI readings run in openai-cron',()=>{
  const ai=fs.readFileSync(path.join(root,'api/panel/ai-cron.js'),'utf8'),openai=fs.readFileSync(path.join(root,'api/panel/openai-cron.js'),'utf8'),config=JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8'));
  assert.doesNotMatch(ai,/runTriage|runAudit|extractHistory/);
  assert.match(openai,/runAudit[\s\S]*extractHistory[\s\S]*runTriage/);
  assert.deepEqual(config.crons.map((cron)=>cron.path+' '+cron.schedule),['/api/panel/ai-cron */10 * * * *','/api/panel/openai-cron 5-59/10 * * * *','/api/panel/media-cron * * * * *']);
});

test('the routine reserves on the ROTINA quota and an operator click on MANUAL',async()=>{
  const calls=[],kinds=[];const data=fixture(10),server=serverFor(data,calls);
  const original=server.supabase;server.supabase=async(url,key,endpoint,options)=>{if(endpoint.endsWith('panel_ai_reserve_call'))kinds.push(JSON.parse(options.body).p_kind);return original(url,key,endpoint,options);};
  const ai=loadAi(server),ctx={environment:'preview',config:{url:'x',secretKey:'k'}},fetchImpl=async()=>aiResponse({summary:{want:'Audi',money:'Cash',missing:'Prazo'},items:[]});
  await ai.runCron(ctx,{fetchImpl});
  assert.deepEqual(kinds,['ROTINA']);
  const [group]=await ai.allConversationData(ctx);
  await ai.readConversation(ctx,group,{manual:true,fetchImpl});
  assert.deepEqual(kinds,['ROTINA','MANUAL']);
});

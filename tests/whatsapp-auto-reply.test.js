'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
function loadWith(relative,mocks){const file=path.join(root,relative),mod={exports:{}};const req=(name)=>Object.hasOwn(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);new Function('require','module','exports',fs.readFileSync(file,'utf8'))(req,mod,mod.exports);return mod.exports;}
const expected=`Hi, this is an automatic message from My Car Scout
We've had a high volume of messages, so the key details come first. When our team joins the conversation, we start with the car you want and your numbers, not from scratch

1. We offer an auction buying service through dealer wholesale auctions, you choose the car and set your limit, we handle the purchase
2. These auctions are closed to the public. Through us, that door is open. No license or auction account needed
3. You buy where dealers buy, before the car ever reaches their lot. Different cars come in and go out every day. Every car has an auction date: once it sells, it's gone
4. Not buying this week? Your budget sets the target. We hunt the specific car when you're ready. The market refreshes daily, so we time it right
5. Before we bid, you see everything: photos, CARFAX, condition details, seller announcements. No test drive exists at auction, so every available fact reaches you first
6. To bid, we require a refundable deposit. It locks your max in place. We never bid above it. No purchase? You get it back, or it stays valid for your next search
7. Financing is also an option, subject to lender approval. Cars up to $7,000 are cash only

Reply YES and a real person will review what you're looking for. Demand is high, and a quick reply isn't always a good reply. We'll make your reply count.`;
const ctx={environment:'preview',config:{url:'https://db.invalid',secretKey:'service'}};
const item=(id,phone='+13055550122')=>({messageId:id,phone,direction:'CUSTOMER',eventField:'messages',timestamp:String(Math.floor(Date.now()/1000)),body:'Hello'});
const stored={messageId:'10000000-0000-4000-8000-000000000001',contactId:'10000000-0000-4000-8000-000000000002'};

function moduleWith(claim){
  const calls=[];
  const mod=loadWith('whatsapp-auto-reply.js',{
    './panel-phone':require('../panel-phone'),
    './panel-server':{supabase:async(_url,_key,endpoint,options)=>{const body=JSON.parse(options.body);calls.push({endpoint,body});if(endpoint.includes('claim_auto_reply'))return claim(body);if(endpoint.includes('finish_auto_reply'))return {updated:true};if(endpoint.includes('apply_message'))return {messageId:'outbound'};throw Error('unexpected endpoint');}}
  });
  return {mod,calls};
}
async function withEnvironment(values,run){
  const before={enabled:process.env.AUTO_REPLY_ENABLED,numbers:process.env.AUTO_REPLY_TEST_NUMBERS,key:process.env.D360_API_KEY,fetch:global.fetch};
  Object.assign(process.env,values);process.env.D360_API_KEY='unit-key';
  try{return await run();}finally{
    for(const [name,value] of [['AUTO_REPLY_ENABLED',before.enabled],['AUTO_REPLY_TEST_NUMBERS',before.numbers],['D360_API_KEY',before.key]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}
    global.fetch=before.fetch;
  }
}

test('new live contact receives the exact greeting once and it is recorded',async()=>withEnvironment({AUTO_REPLY_ENABLED:'true',AUTO_REPLY_TEST_NUMBERS:''},async()=>{
  const {mod,calls}=moduleWith(()=>({claimed:true}));let posted;
  global.fetch=async(_url,options)=>{posted=JSON.parse(options.body);return {ok:true,status:200,json:async()=>({messages:[{id:'wamid.sent'}]})};};
  const result=await mod.maybeAutoReply(ctx,'raw',item('wamid.in'),stored);
  assert.equal(mod.AUTO_REPLY_TEXT,expected);assert.equal(mod.AUTO_REPLY_TEXT.length,1368);
  assert.equal(posted.text.body,expected);assert.equal(posted.to,'13055550122');assert.equal(result.sent,true);assert.equal(result.recorded,true);
  assert.equal(calls.filter((call)=>call.endpoint.includes('claim_auto_reply')).length,1);
  assert.equal(calls.filter((call)=>call.endpoint.includes('apply_message')).length,1);
}));

test('second message and webhook retry do not create another send',async()=>withEnvironment({AUTO_REPLY_ENABLED:'true',AUTO_REPLY_TEST_NUMBERS:''},async()=>{
  let claims=0,sends=0;const {mod}=moduleWith(()=>++claims===1?{claimed:true}:{claimed:false,reason:'ALREADY_CLAIMED'});
  global.fetch=async()=>{sends++;return {ok:true,status:200,json:async()=>({messages:[{id:'wamid.sent'}]})};};
  await mod.maybeAutoReply(ctx,'raw',item('wamid.first'),stored);
  await mod.maybeAutoReply(ctx,'raw',item('wamid.second'),stored);
  await mod.maybeAutoReply(ctx,'raw',item('wamid.first'),stored);
  assert.equal(sends,1);
}));

test('disabled mode allows only the configured test number',async()=>withEnvironment({AUTO_REPLY_ENABLED:'false',AUTO_REPLY_TEST_NUMBERS:'+19545042924'},async()=>{
  let claims=0,sends=0;const {mod}=moduleWith(()=>{claims++;return {claimed:true};});
  global.fetch=async()=>{sends++;return {ok:true,status:200,json:async()=>({messages:[{id:'wamid.test'}]})};};
  const ordinary=await mod.maybeAutoReply(ctx,'raw',item('wamid.off'),stored);
  const testResult=await mod.maybeAutoReply(ctx,'raw',item('wamid.test','+19545042924'),stored);
  assert.equal(ordinary.reason,'DISABLED');assert.equal(testResult.sent,true);assert.equal(claims,1);assert.equal(sends,1);
}));

test('old, recent-MCS and non-lead denials never call 360dialog',async()=>withEnvironment({AUTO_REPLY_ENABLED:'true',AUTO_REPLY_TEST_NUMBERS:''},async()=>{
  const reasons=['INBOUND_NOT_ELIGIBLE','RECENT_MESSAGE','INBOUND_NOT_ELIGIBLE'];let index=0,sends=0;
  const {mod}=moduleWith(()=>({claimed:false,reason:reasons[index++]}));global.fetch=async()=>{sends++;throw Error('must not send');};
  for(const id of ['old','recent-mcs','nonlead'])assert.equal((await mod.maybeAutoReply(ctx,'raw',item('wamid.'+id),stored)).sent,false);
  assert.equal(sends,0);
}));

test('only processRaw with live:true can invoke the sender after storing a CUSTOMER item',async()=>{
  let replies=0;
  const receiver=loadWith('whatsapp-receiver.js',{
    './panel-server':{rows:async()=>[],patchRows:async(_ctx,_table,_filters,_values,representation)=>representation?[{id:'raw'}]:[],supabase:async(_url,_key,endpoint)=>endpoint.includes('panel_whatsapp_apply_message')?stored:{}},
    './whatsapp-auto-reply':{maybeAutoReply:async()=>{replies++;}}
  });
  const payload={object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{contacts:[{wa_id:'13055550122',profile:{name:'Test'}}],messages:[{id:'wamid.live',from:'13055550122',timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body:'Hi'}}]}}]}]};
  await receiver.processRaw(ctx,{id:'raw-live',payload_json:payload,attempts:0},{live:true});
  await receiver.processRaw(ctx,{id:'raw-reprocess',payload_json:payload,attempts:0});
  assert.equal(replies,1);
  assert.match(fs.readFileSync(path.join(root,'api/whatsapp/webhook.js'),'utf8'),/processRaw\(ctx,row,\{live:true\}\)/);
  assert.doesNotMatch(fs.readFileSync(path.join(root,'api/panel/history-import.js'),'utf8'),/live:true/);
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const receiver=require('../whatsapp-receiver');
const root=path.join(__dirname,'..');
const customer='13055550122',business='13055400742';
const message=(id,from=customer,type='text')=>({id,from,timestamp:'1790431200',type,[type]:type==='text'?{body:'Ref: Q5U9B, preciso do carro'}:{id:'media'}});
const cloud=(messages,contacts=[{wa_id:customer,profile:{name:'Tiago'}}])=>({object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'messages',value:{messaging_product:'whatsapp',contacts,messages}}]}]});
const echo=(messages)=>({object:'whatsapp_business_account',entry:[{id:'waba',changes:[{field:'smb_message_echoes',value:{messaging_product:'whatsapp',message_echoes:messages}}]}]});
function loadWith(relative,mocks){const file=path.join(root,relative),mod={exports:{}};const req=(name)=>Object.hasOwn(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);new Function('require','module','exports',fs.readFileSync(file,'utf8'))(req,mod,mod.exports);return mod.exports;}
function response(){return {code:0,payload:null,setHeader(){},status(n){this.code=n;return this;},json(v){this.payload=v;return v;}};}

test('inbound, echoed, media and Ref messages normalize separately',()=>{
  const inbound=receiver.normalizedItems(cloud([message('wamid.1')]));
  assert.equal(inbound.items[0].direction,'CUSTOMER');assert.equal(inbound.items[0].phone,'+13055550122');
  assert.equal(inbound.items[0].name,'Tiago');assert.deepEqual(inbound.items[0].refs,['Q5U9B']);
  const sent=receiver.normalizedItems(echo([{...message('wamid.2',business),to:customer}]));
  assert.equal(sent.items[0].direction,'MCS');
  for(const [type,expected] of [['image','[imagem]'],['audio','[áudio]'],['video','[vídeo]'],['document','[documento]'],['location','[localização]']])
    assert.equal(receiver.normalizedItems(cloud([message('wamid.'+type,customer,type)])).items[0].body,expected);
});
test('groups are ignored and unknown types are preserved for raw storage',()=>{
  assert.equal(receiver.normalizedItems(cloud([message('wamid.group','12345@g.us')])).items.length,0);
  assert.deepEqual(receiver.parse({object:'whatsapp_business_account',entry:[{changes:[{field:'new_field',value:{x:1}}]}]}).type,'UNKNOWN');
  assert.equal(receiver.eventKey(cloud([message('wamid.1')])),receiver.eventKey(cloud([message('wamid.1')])));
});
test('history webhook, state sync and status callback have distinct validation',()=>{
  const history={id:'history.1',event:'history',data:{metadata:{display_phone_number:business},history:[{threads:[{id:customer,messages:[message('wamid.old'),{...message('wamid.out',business),to:customer}]}]}]}};
  assert.deepEqual(receiver.normalizedItems(history).items.map(x=>x.direction),['CUSTOMER','MCS']);
  assert.equal(receiver.normalizedItems({id:'state.1',event:'smb_app_state_sync',data:{state_sync:[]}}).items.length,0);
  assert.equal(receiver.parse({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{statuses:[{id:'x'}]}}]}]}).type,'statuses');
  assert.throws(()=>receiver.parse({event:'history',data:{history:{}}}),/HISTORY_INVALID/);
});
test('official Meta history, reactions, contacts, edits, unsupported and captions isolate each item',()=>{
  const payload={object:'whatsapp_business_account',entry:[{changes:[{field:'history',value:{metadata:{display_phone_number:business},history:[{threads:[{id:customer,messages:[message('t1'),{id:'r1',from:customer,timestamp:'1790431201',type:'reaction',reaction:{emoji:'👍'}},{id:'c1',from:customer,timestamp:'1790431202',type:'contacts',contacts:[]},{id:'e1',from:customer,timestamp:'1790431203',type:'edit'},{id:'u1',from:customer,timestamp:'1790431204',type:'future'},{id:'i1',from:customer,timestamp:'1790431205',type:'image',image:{id:'x',caption:'frente'}}]}]}]}}]}]};
  assert.deepEqual(receiver.normalizedItems(payload).items.map(x=>x.body),['Ref: Q5U9B, preciso do carro','[reação 👍]','[contato]','[mensagem editada]','[tipo não suportado]','[imagem] frente']);
  const mixed=receiver.normalizedItems(cloud([message('good'),{type:'text'}]));assert.equal(mixed.items.length,1);assert.equal(mixed.itemErrors.length,1);
});
test('state sync accepts saved address-book names',()=>{const parsed=receiver.parse({object:'whatsapp_business_account',entry:[{changes:[{field:'smb_app_state_sync',value:{state_sync:{contacts:[{phone_number:customer,full_name:'Tiago Agenda'}]}}}]}]});assert.equal(parsed.addressBook[0].fullName,'Tiago Agenda');});
test('webhook rejects missing secret, durably saves before 200, and runs worker after registration',async()=>{
  let saved=false,ran=false;const scheduled=[];
  const handler=loadWith('api/whatsapp/webhook.js',{
    '@vercel/functions':{waitUntil:(task)=>scheduled.push(task)},
    '../../panel-server':{SERVER_ENVIRONMENT:'preview',configuration:()=>({url:'u',secretKey:'k'}),jsonBody:async(req)=>req.body,send:(res,code,data)=>{assert.equal(code===200?saved:true,true);return res.status(code).json(data);}},
    '../../whatsapp-receiver':{rawEvent:async()=>{saved=true;return {id:'row'};},processRaw:async()=>{ran=true;}}
  });
  const old=process.env.WHATSAPP_WEBHOOK_SECRET;process.env.WHATSAPP_WEBHOOK_SECRET='unit-test-secret';
  try{
    const denied=response();await handler({method:'POST',headers:{},body:cloud([message('one')])},denied);assert.equal(denied.code,401);assert.equal(saved,false);
    const accepted=response();await handler({method:'POST',headers:{'x-mcs-webhook-secret':'unit-test-secret'},body:cloud([message('one')]),waitUntil:(task)=>scheduled.push(task)},accepted);
    assert.equal(accepted.code,200);assert.equal(scheduled.length,1);await scheduled[0];assert.equal(ran,true);
  }finally{if(old===undefined)delete process.env.WHATSAPP_WEBHOOK_SECRET;else process.env.WHATSAPP_WEBHOOK_SECRET=old;}
});
test('failed normalization remains reprocessable and repeated raw event does not insert twice',async()=>{
  let saved=0,processed=0;const ctx={environment:'preview',config:{url:'u',secretKey:'k'}};
  const mock={rows:async(_ctx,table)=>table==='whatsapp_raw_events'?[{id:'existing',status:'DONE'}]:[],patchRows:async(_ctx,_table,_filters,payload,representation)=>{
    if(representation)return [{id:'raw'}];assert.equal(payload.status,'ERROR');saved++;return null;},
    supabase:async()=>{processed++;throw Error('DB_FAILED');}};
  const mod=loadWith('whatsapp-receiver.js',{'./panel-server':mock});
  const payload=cloud([message('repeat')]);
  const result=await mod.processRaw(ctx,{id:'raw',payload_json:payload,attempts:0});assert.equal(result.error,true);assert.equal(saved,1);assert.equal(processed,2);
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260926143000_whatsapp_receptor.sql'),'utf8');
  assert.match(sql,/unique\(environment,event_key\)/);assert.match(sql,/primary key\(environment,wa_message_id\)/);
  assert.match(sql,/source_kind='WHATSAPP_ZIP'/);assert.match(sql,/status text not null default 'PENDING'/);
  assert.match(sql,/date_trunc\('minute',x.occurred_at_utc\)=date_trunc\('minute',m.occurred_at_utc\)/);
});

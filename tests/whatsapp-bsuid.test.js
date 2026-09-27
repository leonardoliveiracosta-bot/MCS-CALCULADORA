'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const receiver=require('../whatsapp-receiver');
const root=path.join(__dirname,'..');

function loadWith(relative,mocks){const file=path.join(root,relative),mod={exports:{}};const req=(name)=>Object.hasOwn(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);new Function('require','module','exports',fs.readFileSync(file,'utf8'))(req,mod,mod.exports);return mod.exports;}
function response(){return {code:0,payload:null,setHeader(){},status(n){this.code=n;return this;},json(v){this.payload=v;return v;}};}

test('Meta BSUID fields normalize inbound, echoes and history without a phone',()=>{
  const contact={user_id:'US.123ABC',profile:{username:'cliente.user',name:'Cliente'}};
  const inbound={object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{contacts:[contact],messages:[{id:'wamid.in',from_user_id:contact.user_id,timestamp:'1790431200',type:'text',text:{body:'oi'}}]}}]}]};
  const echo={object:'whatsapp_business_account',entry:[{changes:[{field:'smb_message_echoes',value:{contacts:[contact],message_echoes:[{id:'wamid.out',to_user_id:contact.user_id,timestamp:'1790431201',type:'text',text:{body:'olá'}}]}}]}]};
  const history={id:'history.bsuid',event:'history',data:{metadata:{display_phone_number:'13055400742'},history:[{threads:[{id:contact.user_id,context:{user_id:contact.user_id,username:'cliente.user'},messages:[{id:'wamid.history.in',from_user_id:contact.user_id,timestamp:'1790431202',type:'text',text:{body:'entrada'}},{id:'wamid.history.out',from:'13055400742',timestamp:'1790431203',type:'text',text:{body:'saída'},history_context:{from_me:true}}]}]}]}};
  const incoming=receiver.normalizedItems(inbound).items[0],outgoing=receiver.normalizedItems(echo).items[0],historical=receiver.normalizedItems(history);
  assert.deepEqual([incoming.phone,incoming.userId,incoming.username,incoming.direction],[null,'US.123ABC','cliente.user','CUSTOMER']);
  assert.deepEqual([outgoing.phone,outgoing.userId,outgoing.username,outgoing.direction],[null,'US.123ABC','cliente.user','MCS']);
  assert.deepEqual(historical.items.map((item)=>[item.userId,item.username,item.direction]),[['US.123ABC','cliente.user','CUSTOMER'],['US.123ABC','cliente.user','MCS']]);
  const invalid=receiver.normalizedItems({object:'whatsapp_business_account',entry:[{changes:[{field:'messages',value:{messages:[{id:'bad',timestamp:'1790431200',type:'text',text:{body:'oi'}}]}}]}]});
  assert.equal(invalid.itemErrors[0].errorCode,'MESSAGE_CONTENT_INVALID');
});

test('stored wamid resolves its item error automatically',async()=>{
  let status='ERROR';
  const maintenance=loadWith('whatsapp-maintenance.js',{
    './whatsapp-receiver':{normalizeParsed:()=>({items:[],itemErrors:[]}),processRaw:async()=>({})},
    './panel-server':{
      allRows:async()=>[{id:'error-1',raw_event_id:'raw-1',item_index:0,item_json:{id:'wamid.saved'}}],
      rows:async(_ctx,table)=>table==='whatsapp_message_ids'?[{wa_message_id:'wamid.saved'}]:[],
      patchRows:async(_ctx,table,_filters,values,representation)=>{if(table==='whatsapp_item_errors')status=values.status;return representation?[{}]:[];}
    }
  });
  const result=await maintenance.resolveStoredItemErrors({environment:'preview'});
  assert.equal(result.resolved,1);assert.equal(status,'RESOLVED');
});

test('stalled processing events finish from stored wamids and retry at most three times',async()=>{
  const now=new Date(Date.now()-180000).toISOString();let events=[{id:'done',event_type:'history',payload_json:{kind:'done'},status:'PROCESSING',attempts:1,processing_started_at:now},{id:'retry',event_type:'history',payload_json:{kind:'retry'},status:'PROCESSING',attempts:1,processing_started_at:now},{id:'limit',event_type:'history',payload_json:{kind:'limit'},status:'PROCESSING',attempts:3,processing_started_at:now}];
  const patches=[];let processed=0;
  const maintenance=loadWith('whatsapp-maintenance.js',{
    './whatsapp-receiver':{normalizeParsed:(payload)=>({items:[{messageId:'wamid.'+payload.kind}],itemErrors:[]}),processRaw:async()=>{processed++;return {imported:1};}},
    './panel-server':{
      allRows:async()=>[],
      rows:async(_ctx,table,filters)=>table==='whatsapp_raw_events'?events:table==='whatsapp_message_ids'&&String(filters.wa_message_id).includes('wamid.done')?[{wa_message_id:'wamid.done'}]:[],
      patchRows:async(_ctx,table,filters,values,representation)=>{patches.push({table,filters,values});const event=events.find((item)=>filters.id==='eq.'+item.id);if(event)Object.assign(event,values);return representation?[{}]:[];}
    }
  });
  const result=await maintenance.recoverStalledEvents({environment:'preview'},{maxEvents:3,deadlineAt:Date.now()+10000});
  assert.deepEqual(result,{done:1,reprocessed:1,deferred:0,failed:1});assert.equal(processed,1);
  assert.equal(events.find((item)=>item.id==='done').status,'DONE');assert.equal(events.find((item)=>item.id==='limit').error_code,'PROCESSING_RETRY_LIMIT');
});

test('WhatsApp panel hides only ignored statuses',async()=>{
  let ignoredFilter=null;
  const panelServer={allRows:async()=>[],isUuid:()=>true,jsonBody:async(req)=>req.body,patchRows:async()=>[],requirePanel:async()=>({environment:'preview'}),send:(res,code,payload)=>res.status(code).json(payload),supabase:async()=>({}),rows:async(_ctx,table,filters)=>{if(table==='whatsapp_raw_events'&&filters.status==='eq.IGNORED')ignoredFilter=filters.event_type;return [];}};
  const handler=loadWith('api/panel/whatsapp.js',{'../../panel-server':panelServer,'../../whatsapp-receiver':{},'../../whatsapp-maintenance':{resolveStoredItemErrors:async()=>({}),recoverStalledEvents:async()=>({})}});
  const out=response();await handler({method:'GET'},out);
  assert.equal(out.code,200);assert.equal(ignoredFilter,'neq.statuses');
});

test('card labels a BSUID-only contact without a telephone link',()=>{
  const panel=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
  assert.match(panel,/💬 \$\{username\?'@'\+username\+' · ':''\}WhatsApp sem número/);
  assert.match(panel,/Responda pela conversa no app WhatsApp Business/);
  assert.match(panel,/if\(item\?\.whatsappWithoutPhone\)/);
});

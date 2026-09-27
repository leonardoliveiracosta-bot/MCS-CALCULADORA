'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const receiver=require('../whatsapp-receiver');
const {messageChannel,contactIndex}=require('../panel-contact');
const root=path.join(__dirname,'..');
const business='13055400742',customer='13055550122';
const history=(id='history.synthetic')=>({id,event:'history',data:{metadata:{display_phone_number:business},history:[{metadata:{phase:2,chunk_order:1},threads:[{id:customer,messages:[
  {id:'wamid.history.in',from:customer,timestamp:'1790431200',type:'text',text:{body:'Olá'}},
  {id:'wamid.history.media',from:customer,timestamp:'1790431201',type:'media_placeholder',media_placeholder:{}},
  {id:'wamid.history.edit',from:customer,timestamp:'1790431202',type:'edit',edit:{}}
]},{id:'+13055550123',messages:[{id:'wamid.history.out',from:business,to:'+13055550123',timestamp:'1790431203',type:'text',text:{body:'Oi'}}]}]}]}});
const state=(id='state.synthetic')=>({id,event:'smb_app_state_sync',data:{state_sync:[{phone_number:customer,full_name:'Nome da Agenda'}]}});
function loadWith(relative,mocks){const file=path.join(root,relative),mod={exports:{}};const req=(name)=>Object.hasOwn(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);new Function('require','module','exports',fs.readFileSync(file,'utf8'))(req,mod,mod.exports);return mod.exports;}
function response(){return {code:0,payload:null,status(code){this.code=code;return this;},json(value){this.payload=value;return value;}};}

test('fixture history preserves direction and special labels',()=>{
  const parsed=receiver.normalizedItems(history());
  assert.equal(parsed.items.length,4);
  assert.deepEqual(parsed.items.map((item)=>item.direction),['CUSTOMER','CUSTOMER','CUSTOMER','MCS']);
  assert.equal(parsed.items[1].body,'📎 mídia (foto/áudio/vídeo — arquivo não veio no histórico)');
  assert.equal(parsed.items[2].body,'[mensagem editada]');
  assert.equal(receiver.sourceKindFor({event_type:'history'}),'WHATSAPP_HISTORY');
  assert.equal(receiver.sourceKindFor({event_type:'messages'}),'WHATSAPP_WEBHOOK');
});

test('history event validation accepts state sync without metadata and rejects another phone',()=>{
  const handler=loadWith('api/panel/history-import.js',{'../../panel-server':{},'../../whatsapp-receiver':{}});
  assert.equal(handler.validObject(state()),true);
  assert.equal(handler.validObject(history()),true);
  assert.equal(handler.validObject({...history(),data:{...history().data,metadata:{display_phone_number:'13055550999'}}}),false);
  assert.equal(handler.validObject({id:'bad',event:'history',data:{metadata:{display_phone_number:business}}}),false);
});

test('history import is idempotent and resumes pending or interrupted raw events',async()=>{
  const rawId='c8df2ad7-ae98-4ce1-a24d-91fd4eb076f4',ctx={environment:'preview',config:{url:'u',secretKey:'k'},panel:{id:rawId}};
  let row={id:rawId,status:'DONE',event_type:'history',processing_started_at:null};let calls=[];
  const panelServer={requirePanel:async()=>ctx,jsonBody:async(req)=>req.body,send:(res,code,payload)=>res.status(code).json(payload),rows:async()=>[row],patchRows:async(_ctx,_table,_filters,values)=>{calls.push(values);row={...row,...values};return [row];}};
  const handler=loadWith('api/panel/history-import.js',{'../../panel-server':panelServer,'../../whatsapp-receiver':{eventKey:(value)=>value.event+':'+value.id,rawEvent:async()=>null,processRaw:async()=>({imported:2,duplicates:1,itemErrors:0})}});
  let out=response();await handler({method:'POST',body:{items:[history()]}},out);assert.equal(out.code,200);assert.equal(out.payload.alreadyExists,1);
  row={id:rawId,status:'PENDING',event_type:'history',processing_started_at:null};out=response();await handler({method:'POST',body:{items:[history('history.pending')]}},out);assert.equal(out.payload.imported,2);
  row={id:rawId,status:'PROCESSING',event_type:'history',processing_started_at:'2000-01-01T00:00:00.000Z'};out=response();await handler({method:'POST',body:{items:[history('history.stalled')]}},out);assert.equal(out.payload.imported,2);assert.equal(calls.at(-1).error_code,'PROCESSING_INTERRUPTED');
});

test('importer sends state sync first and keeps batches small',()=>{
  const panel=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
  assert.match(panel,/const ordered = states\.concat\(histories\)/);
  assert.match(panel,/offset \+= 10/);
  assert.match(panel,/\/api\/panel\/history-import/);
  assert.match(panel,/Importado: \$\{totals\.conversations\} conversas/);
  const receiverSource=fs.readFileSync(path.join(root,'whatsapp-receiver.js'),'utf8');
  assert.match(receiverSource,/saveAddressBook\(ctx,parsed\.addressBook\)/);
  assert.match(receiverSource,/panel_whatsapp_apply_address_book/);
  assert.match(receiverSource,/if\(!item\.name\)\{const book=/);
});

test('history contact facts keep the history label while only live inbound starts the click cutoff',()=>{
  assert.equal(messageChannel({source_kind:'WHATSAPP_HISTORY'}),'WHATSAPP_HISTORY');
  const historical=contactIndex({messages:[{id:'old',direction:'CUSTOMER',source_kind:'WHATSAPP_HISTORY',created_at:'2026-09-01T00:00:00Z'}],messageLinks:[{message_id:'old',journey_id:'journey'}],calcRuns:[]});
  assert.equal(historical.firstWebhookAt,null);
  const live=contactIndex({messages:[{id:'old',direction:'CUSTOMER',source_kind:'WHATSAPP_HISTORY',created_at:'2026-09-01T00:00:00Z'},{id:'live',direction:'CUSTOMER',source_kind:'WHATSAPP_WEBHOOK',created_at:'2026-09-02T00:00:00Z'}],messageLinks:[],calcRuns:[]});
  assert.ok(live.firstWebhookAt);
});

test('history WhatsApp label stays green and report rules count it as WhatsApp',()=>{
  const panel=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
  const report=fs.readFileSync(path.join(root,'api/panel/report.js'),'utf8');
  assert.match(panel,/WHATSAPP_HISTORY:'💬 WhatsApp · histórico'/);
  assert.match(panel,/\['WHATSAPP','WHATSAPP_HISTORY','WHATSAPP_CLICK'\]\.includes\(item\.contactChannel\)/);
  assert.match(report,/\['WHATSAPP','WHATSAPP_HISTORY'\]\.includes\(item\.contactChannel\)/);
});

test('cron skips an all-history group and a live inbound makes it eligible again',async()=>{
  const journey={id:'journey',contact_id:'contact',reference_code:null,criteria_json:{}};
  const now=Date.now()-20*60000;
  const runWith=(sourceKind)=>{
    const messages=[...Array(10)].map((_,index)=>({id:'mcs-'+index,chat_id:'chat',direction:'MCS',body_text:'oi',is_automatic:false,source_kind:'WHATSAPP_HISTORY',occurred_at_utc:new Date(now-index*1000).toISOString()}));
    messages.push({id:'customer',chat_id:'chat',direction:'CUSTOMER',body_text:'preciso',is_automatic:false,source_kind:sourceKind,occurred_at_utc:new Date(now+1000).toISOString()});
    return loadWith('panel-ai.js',{'./panel-server':{
      allRows:async(_ctx,table)=>({journeys:[journey],contacts:[{id:'contact',display_name:'Sintético',location_text:''}],message_journeys:messages.map((message)=>({journey_id:'journey',message_id:message.id})),messages,journey_refs:[],conversation_ai_readings:[],conversation_ai_link_state:[],conversation_ai_attempt_state:[],calc_runs:[],conversation_pending_insights:[],calculator_request_links:[]}[table]||[]),
      supabase:async()=>({allowed:true}),insert:async()=>{},patchRows:async()=>[],rows:async()=>[]
    }});
  };
  const oldKey=process.env.ANTHROPIC_API_KEY,oldModel=process.env.ANTHROPIC_MODEL;delete process.env.ANTHROPIC_API_KEY;delete process.env.ANTHROPIC_MODEL;
  try{
    assert.equal((await runWith('WHATSAPP_HISTORY').runCron({environment:'preview',config:{url:'u',secretKey:'k'}})).processed,0);
    assert.equal((await runWith('WHATSAPP_WEBHOOK').runCron({environment:'preview',config:{url:'u',secretKey:'k'}})).processed,1);
  }finally{if(oldKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=oldKey;if(oldModel===undefined)delete process.env.ANTHROPIC_MODEL;else process.env.ANTHROPIC_MODEL=oldModel;}
});

test('migration records history source and automatic detector accepts history without changing webhook default',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260927090000_360dialog_history_import.sql'),'utf8');
  assert.match(sql,/source_key text := coalesce\(nullif\(p_item->>'source_kind',''\),'WHATSAPP_WEBHOOK'\)/);
  assert.match(sql,/source_kind,created_at\)\s*\n?\s*values\([^\n]*source_key,now\(\)/);
  assert.match(sql,/association_source,associated_at\)\s*\n?\s*values\([^\n]*source_key,now\(\)/);
  assert.match(sql,/source_kind in \('WHATSAPP_WEBHOOK','WHATSAPP_HISTORY'\)/);
  const addressBookSql=fs.readFileSync(path.join(root,'supabase/migrations/20260927090100_360dialog_address_book_names.sql'),'utf8');
  assert.match(addressBookSql,/coalesce\(trim\(c\.display_name\),''\)=''/);
  const ai=fs.readFileSync(path.join(root,'panel-ai.js'),'utf8');
  assert.match(ai,/source_kind,occurred_at_utc/);
  assert.match(ai,/latestCustomerIsLive/);
  assert.match(fs.readFileSync(path.join(root,'api/panel/whatsapp.js'),'utf8'),/raw\.event_type==='history'\?'WHATSAPP_HISTORY':'WHATSAPP_WEBHOOK'/);
});

test('latest WhatsApp function keeps source_key and clears the old primary before promotion',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260927091000_restore_primary_swap_fix.sql'),'utf8');
  assert.match(sql,/source_key text := coalesce\(nullif\(p_item->>'source_kind',''\),'WHATSAPP_WEBHOOK'\)/);
  assert.match(sql,/set is_primary=false where cp\.environment=p_environment and cp\.contact_id=contact_id and cp\.is_primary/);
  assert.match(sql,/set is_primary=true where cp\.environment=p_environment and cp\.contact_id=contact_id and cp\.phone_e164=phone/);
  assert.doesNotMatch(sql,/set is_primary=\(cp\.phone_e164=phone/);
});

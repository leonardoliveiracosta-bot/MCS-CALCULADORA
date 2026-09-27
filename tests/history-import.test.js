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
const historyMedia=(id='history.media',field='messages')=>({id,event:'history',data:{metadata:{display_phone_number:business},[field]:field==='messages'?
  [{id:'wamid.history.audio',from:customer,timestamp:'1790432200',type:'audio',audio:{id:'media-audio'}},{id:'wamid.history.document',from:customer,timestamp:'1790432201',type:'document',document:{id:'media-doc'}}]:
  [{id:'wamid.history.image',from:business,to:customer,timestamp:'1790432300',type:'image',image:{id:'media-image'}},{id:'wamid.history.echo-audio',from:business,to:customer,timestamp:'1790432301',type:'audio',audio:{id:'media-echo'}}]}});
function loadWith(relative,mocks){const file=path.join(root,relative),mod={exports:{}};const req=(name)=>Object.hasOwn(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);new Function('require','module','exports',fs.readFileSync(file,'utf8'))(req,mod,mod.exports);return mod.exports;}
function response(){return {code:0,payload:null,status(code){this.code=code;return this;},json(value){this.payload=value;return value;}};}
function panelFunction(name){
  const source=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8'),match=new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match,`função ${name} existe`);
  const start=match.index,open=source.indexOf('{',start);let depth=0,end=open;
  for(;end<source.length;end++){if(source[end]==='{')depth++;else if(source[end]==='}'&&!--depth){end++;break;}}
  return new Function(`return (${source.slice(start,end)})`)();
}
const splitHistory=panelFunction('historyParts'),makeBatches=panelFunction('historyBatches'),sendHistoryBatch=panelFunction('requestHistoryBatch');
const message=(id,body='x')=>({id,from:customer,timestamp:String(1790430000+Number(String(id).replace(/\D/g,'').slice(-6)||0)),type:'text',text:{body}});
const historyFixture=(id,counts,metadata={phase:2,chunk_order:1,progress:50})=>({id,event:'history',data:{id:'data-'+id,messaging_product:'whatsapp',metadata:{display_phone_number:business},history:[{metadata,threads:counts.map((count,index)=>({id:`thread-${id}-${index}`,context:{slot:index},messages:Array.from({length:count},(_,item)=>message(`${id}-${index}-${item}`))}))}]}});
const messageCount=(part)=>(part.data?.history||[]).flatMap((chunk)=>chunk.threads||[]).reduce((total,thread)=>total+(thread.messages||[]).length,0);
const jsonBytes=(value)=>new TextEncoder().encode(JSON.stringify(value)).length;

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
  const panel=fs.readFileSync(path.join(root,'painel/painel.js'),'utf8');
  assert.equal(handler.validObject(state()),true);
  assert.equal(handler.validObject(history()),true);
  assert.equal(handler.validObject(historyMedia()),true);
  assert.equal(handler.validObject(historyMedia('history.echoes','message_echoes')),true);
  assert.equal(handler.validObject({...history(),data:{...history().data,messages:historyMedia().data.messages,message_echoes:historyMedia('history.echoes','message_echoes').data.message_echoes}}),true);
  assert.equal(handler.validObject({...history(),data:{...history().data,metadata:{display_phone_number:'13055550999'}}}),false);
  assert.equal(handler.validObject({id:'bad',event:'history',data:{metadata:{display_phone_number:business}}}),false);
  assert.match(panel,/\[value\.data\.history, value\.data\.messages, value\.data\.message_echoes\]\.some\(Array\.isArray\)/);
});

test('history parts cap 40 threads at 100 messages with stable ids and metadata',()=>{
  const input=historyFixture('forty',Array(40).fill(5),{phase:3,chunk_order:7,progress:81}),parts=splitHistory(input),again=splitHistory(input);
  assert.deepEqual(parts.map((part)=>part.id),['forty#p1','forty#p2']);
  assert.deepEqual(parts.map(messageCount),[100,100]);
  assert.ok(parts.every((part)=>part.data.id===input.data.id&&part.data.messaging_product==='whatsapp'));
  assert.ok(parts.every((part)=>JSON.stringify(part.data.metadata)===JSON.stringify(input.data.metadata)));
  assert.ok(parts.every((part)=>JSON.stringify(part.data.history[0].metadata)===JSON.stringify(input.data.history[0].metadata)));
  assert.deepEqual(again,parts);
  assert.deepEqual(again.map(receiver.eventKey),parts.map(receiver.eventKey));
  assert.deepEqual(parts.map(receiver.eventKey),['history:forty#p1','history:forty#p2']);
  assert.equal(new Set(parts.map(receiver.eventKey)).size,parts.length);
  const handler=loadWith('api/panel/history-import.js',{'../../panel-server':{},'../../whatsapp-receiver':{}});
  assert.ok(parts.every(handler.validObject));
  const empty=historyFixture('empty',[]);assert.deepEqual(splitHistory(empty),[empty]);
});

test('one 357-message thread becomes 100, 100, 100 and 57 in original order',()=>{
  const input=historyFixture('long',[357]),parts=splitHistory(input);
  assert.deepEqual(parts.map(messageCount),[100,100,100,57]);
  assert.deepEqual(parts.map((part)=>part.id),['long#p1','long#p2','long#p3','long#p4']);
  assert.ok(parts.every((part)=>part.data.history[0].threads.length===1&&part.data.history[0].threads[0].id==='thread-long-0'));
  assert.ok(parts.every((part)=>part.data.history[0].threads[0].context.slot===0));
  assert.deepEqual(parts.flatMap((part)=>part.data.history[0].threads[0].messages.map((item)=>item.id)),input.data.history[0].threads[0].messages.map((item)=>item.id));
});

test('history batches preserve order and cap count plus combined bytes',()=>{
  const small=Array.from({length:10},(_,index)=>({id:'small-'+index,pad:'x'}));
  assert.deepEqual(makeBatches(small),[small]);
  const large=Array.from({length:3},(_,index)=>({id:'large-'+index,pad:'x'.repeat(600000)})),largeBatches=makeBatches(large);
  assert.deepEqual(largeBatches.map((batch)=>batch.length),[1,1,1]);
  const mixed=Array.from({length:23},(_,index)=>({id:'mixed-'+index,pad:'x'.repeat(index%4===0?130000:30000)})),batches=makeBatches(mixed);
  assert.deepEqual(batches.flat(),mixed);
  assert.ok(batches.every((batch)=>batch.length<=10));
  assert.ok(batches.every((batch)=>batch.length===1||batch.reduce((sum,item)=>sum+jsonBytes(item),0)<=500000));
});

test('failed history batch retries the identical batch three times',async()=>{
  const batch=[{id:'same'}],calls=[],waits=[];
  const result=await sendHistoryBatch(batch,async(_path,options)=>{calls.push(JSON.parse(options.body).items);if(calls.length<3){const failure=Error('HISTORY_IMPORT_FAILED');failure.code='HISTORY_IMPORT_FAILED';throw failure;}return {imported:1};},async(milliseconds)=>waits.push(milliseconds));
  assert.deepEqual(result,{imported:1});
  assert.deepEqual(calls,[batch,batch,batch]);
  assert.deepEqual(waits,[2000,2000]);
  let failedCalls=0;
  await assert.rejects(()=>sendHistoryBatch(batch,async()=>{failedCalls++;const failure=Error('HISTORY_IMPORT_FAILED');failure.code='HISTORY_IMPORT_FAILED';throw failure;},async()=>{}),/HISTORY_IMPORT_FAILED/);
  assert.equal(failedCalls,3);
});

test('real-size synthetic history stays under message and batch limits',()=>{
  const sized=(id,counts,target,phase,order)=>{const value=historyFixture(id,counts,{phase,chunk_order:order,progress:75}),total=counts.reduce((sum,count)=>sum+count,0),padding=Math.max(0,Math.floor((target-jsonBytes(value))/total));value.data.history[0].threads.forEach((thread)=>thread.messages.forEach((item)=>{item.text.body='x'.repeat(padding);}));return value;};
  const histories=[sized('real-a',[357,...Array(237).fill(3)],627000,1,1),sized('real-b',Array(177).fill(3),347000,1,2),sized('real-c',[...Array(62).fill(2),...Array(346).fill(3)],306000,1,3)];
  assert.deepEqual(histories.map((item)=>messageCount(item)),[1068,531,1162]);
  assert.ok(histories.every((item,index)=>Math.abs(jsonBytes(item)-[627000,347000,306000][index])<4000));
  const states=Array.from({length:5},(_,index)=>({id:'state-'+index,event:'smb_app_state_sync',data:{state_sync:Array.from({length:100},(_entry,contact)=>({phone_number:`1305555${index}${String(contact).padStart(3,'0')}`,full_name:'x'.repeat(560)}))}}));
  const media=Array.from({length:441},(_,index)=>({id:'media-'+index,event:'history',data:{metadata:{display_phone_number:business},messages:[{id:'wamid.media.'+index,from:customer,timestamp:String(1790433000+index),type:'image',image:{id:'image-'+index,caption:'x'.repeat(700)}}]}}));
  assert.ok(states.every((item)=>jsonBytes(item)>60000&&jsonBytes(item)<70000));
  assert.ok(media.every((item)=>jsonBytes(item)>800&&jsonBytes(item)<1200));
  const parts=histories.flatMap(splitHistory),ordered=states.concat(parts,media),batches=makeBatches(ordered);
  assert.equal(parts.reduce((sum,part)=>sum+messageCount(part),0),2761);
  assert.ok(parts.every((part)=>messageCount(part)<=100));
  assert.deepEqual(batches.flat(),ordered);
  assert.ok(batches.every((batch)=>batch.length<=10));
  assert.ok(batches.every((batch)=>batch.length===1||batch.reduce((sum,item)=>sum+jsonBytes(item),0)<=500000));
});

test('history media uses webhook item paths with history labels and preserves directions',()=>{
  const inbound=receiver.normalizedItems(historyMedia());
  const echoes=receiver.normalizedItems(historyMedia('history.echoes','message_echoes'));
  assert.deepEqual(inbound.items.map((item)=>item.direction),['CUSTOMER','CUSTOMER']);
  assert.deepEqual(echoes.items.map((item)=>item.direction),['MCS','MCS']);
  assert.deepEqual(inbound.items.map((item)=>item.body),['🎤 áudio (arquivo não veio no histórico)','📄 documento (arquivo não veio no histórico)']);
  assert.deepEqual(echoes.items.map((item)=>item.body),['📷 foto (arquivo não veio no histórico)','🎤 áudio (arquivo não veio no histórico)']);
  assert.equal(receiver.content({type:'audio',audio:{}},'WHATSAPP_WEBHOOK').body,'[áudio]');
});

test('existing history placeholders are upgraded in place without another message',async()=>{
  const item={source_kind:'WHATSAPP_HISTORY',body:'🎤 áudio (arquivo não veio no histórico)'};
  assert.equal(receiver.shouldUpgradeHistoryMedia(item,receiver.HISTORY_MEDIA_PLACEHOLDER),true);
  assert.equal(receiver.shouldUpgradeHistoryMedia(item,'[áudio]'),false);
  assert.equal(receiver.shouldUpgradeHistoryMedia({...item,source_kind:'WHATSAPP_WEBHOOK'},receiver.HISTORY_MEDIA_PLACEHOLDER),false);
  assert.equal(receiver.shouldUpgradeHistoryMedia({...item,body:'[mensagem editada]'},receiver.HISTORY_MEDIA_PLACEHOLDER),false);
  const patches=[];
  const fake=loadWith('whatsapp-receiver.js',{
    './painel/parser':{extractRefs:()=>[]},'./panel-phone':{normalizePhone:(value)=>String(value||'')},
    './panel-server':{rows:async(_ctx,table)=>table==='messages'?[{id:'message-old',body_text:receiver.HISTORY_MEDIA_PLACEHOLDER}]:[],patchRows:async(_ctx,table,filters,values)=>{patches.push({table,filters,values});return [{id:'message-old'}];},supabase:async(_url,_key,path)=>path.includes('panel_whatsapp_apply_message')?{duplicate:true,messageId:'message-old'}:{}}
  });
  const ctx={environment:'preview',config:{url:'u',secretKey:'k'}};
  const duplicate=await fake.processItem(ctx,'raw-old',{messageId:'wamid.old',phone:customer,name:'Cliente',direction:'CUSTOMER',body:item.body,timestamp:'1790432200',source_kind:'WHATSAPP_HISTORY'});
  assert.equal(duplicate.duplicate,true);
  assert.deepEqual(patches,[{table:'messages',filters:{id:'eq.message-old',environment:'eq.preview',body_text:'eq.'+receiver.HISTORY_MEDIA_PLACEHOLDER},values:{body_text:item.body,body_normalized:item.body.toLowerCase()}}]);
  patches.length=0;
  const fresh=loadWith('whatsapp-receiver.js',{
    './painel/parser':{extractRefs:()=>[]},'./panel-phone':{normalizePhone:(value)=>String(value||'')},
    './panel-server':{rows:async()=>[],patchRows:async(...args)=>{patches.push(args);return [];},supabase:async(_url,_key,path)=>path.includes('panel_whatsapp_apply_message')?{duplicate:false,messageId:'message-new'}:{}}
  });
  assert.equal((await fresh.processItem(ctx,'raw-new',{messageId:'wamid.new',phone:customer,name:'Cliente',direction:'CUSTOMER',body:item.body,timestamp:'1790432201',source_kind:'WHATSAPP_HISTORY'})).duplicate,false);
  assert.equal(patches.length,0);
  const source=fs.readFileSync(path.join(root,'whatsapp-receiver.js'),'utf8');
  assert.match(source,/await upgradeHistoryMediaPlaceholder\(ctx,prepared\.item,result\|\|\{\}\)/);
  assert.match(source,/body_text:item\.body,body_normalized:normalized/);
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
  assert.match(panel,/states\.concat\(histories, mediaHistories\)/);
  assert.match(panel,/mediaHistoryOrder/);
  assert.match(panel,/flatMap\(historyParts\)/);
  assert.match(panel,/historyBatches\(ordered\)/);
  assert.doesNotMatch(panel,/offset \+= 10/);
  assert.match(panel,/requestHistoryBatch\(batch, request, pause\)/);
  assert.match(panel,/\/api\/panel\/history-import/);
  assert.match(panel,/Importado: \$\{totals\.conversations\} conversas/);
  assert.match(fs.readFileSync(path.join(root,'api/panel/history-import.js'),'utf8'),/FUNCTION_BUDGET_MS=45000/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'vercel.json'),'utf8')).functions['api/panel/history-import.js'].maxDuration,60);
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

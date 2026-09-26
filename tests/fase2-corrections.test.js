'use strict';
process.env.VERCEL_ENV='preview';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const { score }=require('../panel-ready');
const { offerKind, timezoneForZip, localToUtc }=require('../panel-lead');
const { validItems, wishlistAfter }=require('../panel-note');
const root=path.join(__dirname,'..');
const actor='ed24c183-d61e-4714-ada6-7dadef53685d';
const journeyId='8fc49eea-1d7b-4576-bd21-a3fa22d7c6a5';
const operationId='e0f691b7-e4ea-4d65-9bd5-ff7f8c79634c';
function loadWith(relative,mocks) {
  const file=path.join(root,relative);const mod={exports:{}};
  const localRequire=(name)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);
  return mod.exports;
}
function output(){return {code:0,payload:null,setHeader(){},status(code){this.code=code;return this;},json(payload){this.payload=payload;return payload;}};}
function mockServer(overrides={}){return {requirePanel:async()=>({environment:'preview',panel:{id:actor},config:{url:'https://example.invalid',secretKey:'test'}}),jsonBody:async(req)=>req.body,
  send:(res,code,payload)=>res.status(code).json(payload),safeText:(v,max)=>String(v||'').slice(0,max)||null,isUuid:(v)=>/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(String(v)),...overrides};}
const lead={ref:'ABC23',record:{id:journeyId,contact_id:actor,enabled:true},order:{budgetCents:2500000},timezone:'America/New_York',offers:[],wishes:[],maxBidCents:2500000,payment:'cash'};

test('calculator maximum bid is not inverted without a confirmed total ceiling',()=>{
  const item={zip:'33101',budgetCents:2500000,paymentText:'cash',occurredAt:new Date().toISOString()};
  assert.equal(score(item,null,{checklist:[],messages:[],promises:[]},[]).bid,25000);
  const converted=score(item,{id:journeyId,confirmed_total_ceiling_cents:2500000,phones:[],enabled:true},{checklist:[],messages:[],promises:[]},[]).bid;
  assert.ok(converted<25000&&converted>0);
});

test('literal evidence without a specific value remains unchecked',()=>{
  const note='O teto total é 30.000, vai pagar à vista. O carro é Audi Q7 2020 até 60 mil milhas. Quinta 10h retorno.';
  const items=validItems(note,[{type:'budget',value:30000,evidence:'O teto total é 30.000'},
    {type:'budget',value:40000,evidence:'O teto total é 30.000'},
    {type:'payment',value:'fin',evidence:'vai pagar à vista'},
    {type:'checklist',point:6,value:'OK',evidence:'O teto total é 30.000'},
    {type:'return',value:{text:'retorno',at:'2026-10-01T10:00'},evidence:'Quinta 10h retorno'}]);
  assert.deepEqual(items.map((item)=>item.manualReview),[false,true,true,true,false]);
});

test('wishlist operations preserve other cars and yield final order',()=>{
  const original=[{make:'BMW',model:'X5',yearMin:2019,maxMiles:70000},{make:'Audi',model:'Q7',yearMin:2020,maxMiles:60000}];
  const moved=wishlistAfter(original,{operation:'reorder',car:{make:'Audi',model:'Q7'},preference:1});
  assert.deepEqual(moved.map((car)=>car.model),['Q7','X5']);
  assert.equal(wishlistAfter(moved,{operation:'remove',car:{make:'BMW',model:'X5'}})[0].maxMiles,60000);
});

test('annotation confirmation uses one RPC and propagates its failure without partial response',async()=>{
  let calls=0;const server=mockServer({supabase:async(_url,_key,endpoint)=>{assert.match(endpoint,/panel_confirm_lead_note$/);calls++;throw Object.assign(new Error('ITEM_FAILED'),{status:409});},rows:async()=>[],insert:async()=>[],patchRows:async()=>[]});
  const handler=loadWith('api/panel/lead.js',{'../../panel-server':server,'../../panel-lead':{leadData:async()=>lead,ensureJourney:async()=>lead.record,localToUtc,addClientDays:()=>null},'../../panel-note':require('../panel-note')});
  const response=output();await handler({method:'POST',query:{},body:{action:'note',ref:lead.ref,journeyId,confirmationKey:operationId,note:'Conversamos',proposal:[],selected:[]}},response);
  assert.equal(calls,1);assert.equal(response.code,409);assert.equal(response.payload.error,'ITEM_FAILED');
});

test('quick results use distinct operation IDs and undo is delegated atomically',async()=>{
  const events=[];const calls=[];
  const server=mockServer({rows:async(_ctx,table,filters)=>table==='lead_events'&&filters['detail_json->>operationId']?
    events.filter((row)=>row.operationId===filters['detail_json->>operationId'].slice(3)).map((row)=>({id:row.id})):[],
    supabase:async(_url,_key,endpoint,options)=>{const body=JSON.parse(options.body);calls.push({endpoint,body});
      if(endpoint.endsWith('panel_quick_result')){const id=cryptoId(events.length+1);events.push({id,operationId:body.p_operation});return {eventId:id,undoUntil:new Date(Date.now()+10000).toISOString(),duplicate:false};}
      if(endpoint.endsWith('panel_undo_quick')){if(body.p_event!==events.at(-1).id)throw Object.assign(new Error('UNDO_NOT_LATEST'),{status:409});return {undone:true};}
      throw new Error('unexpected RPC');}});
  const handler=loadWith('api/panel/lead.js',{'../../panel-server':server,'../../panel-lead':{leadData:async()=>lead,ensureJourney:async()=>lead.record,localToUtc,addClientDays:()=>new Date().toISOString()},'../../panel-note':require('../panel-note')});
  const run=async(body)=>{const res=output();await handler({method:'POST',query:{},body:{ref:lead.ref,journeyId,...body}},res);return res;};
  const first=await run({action:'quick',type:'ANSWERED',operationId});
  const second=await run({action:'quick',type:'ANSWERED',operationId:cryptoId(99)});
  const duplicate=await run({action:'quick',type:'ANSWERED',operationId});
  assert.equal(first.code,201);assert.equal(second.code,201);assert.equal(duplicate.payload.duplicate,true);assert.equal(events.length,2);
  assert.equal((await run({action:'undo',eventId:first.payload.eventId})).code,409);
  assert.equal((await run({action:'undo',eventId:second.payload.eventId})).code,200);
  assert.equal(calls.filter((call)=>call.endpoint.endsWith('panel_quick_result')).length,2);
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260926061000_panel_fase2_quick_atomic.sql'),'utf8');
  assert.match(sql,/next_action_missing_since=\(snap->>'next_action_missing_since'\)::timestamptz/);
  assert.match(sql,/if last_id<>p_event then raise exception 'UNDO_NOT_LATEST'/);
});
function cryptoId(n){return `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;}

test('customer response is committed through one database RPC',async()=>{
  let rpc=0;const server=mockServer({SERVER_ENVIRONMENT:'preview',configuration:()=>({url:'https://example.invalid',secretKey:'test'}),
    rows:async(_ctx,table)=>table==='lead_tracking'?[{id:journeyId,ref_code:'ABC23',journey_id:journeyId}]:table==='journeys'?[{id:journeyId,contact_id:actor,status:'ATIVO'}]:[],
    supabase:async(_url,_key,path)=>{assert.match(path,/panel_customer_unit_response$/);rpc++;return {accepted:true};}});
  const handler=loadWith('api/tracking.js',{'../panel-server':server,'../panel-lead':{orders:async()=>[]}});
  const res=output();await handler({method:'POST',query:{code:'abcdefghijklmnopqrstuvwxyz'},body:{unitId:journeyId,response:'WANT'}},res);
  assert.equal(res.code,200);assert.equal(rpc,1);
});

test('HOJE includes a wanted car even when the order was treated',async()=>{
  const now=new Date().toISOString(),order={ref:'ABC23',key:'ABC23',pending:false,disposition:'TREATED',occurredAt:'2020-01-01T00:00:00Z',simulations:[{occurredAt:'2020-01-01T00:00:00Z'}],budgetCents:2500000};
  const server=mockServer({allRows:async(_ctx,table)=>table==='calc_runs'?[order]:table==='lead_events'?[{ref_code:'ABC23'}]:[],panelMeta:async()=>({})});
  const handler=loadWith('api/panel/today.js',{'../../panel-server':server,'../../panel-domain':{consolidateCalcRuns:(runs)=>runs,groupCalculatorByRef:(runs)=>runs,standardBudget:()=>true,time:(value)=>Date.parse(value)},
    '../../panel-read-model':{operational:async()=>({journeys:[],messages:[],checklist:[],promises:[]})},'../../panel-ready':{score:()=>({score:0,goodHour:true,promiseToday:false})},'../../panel-lead':{timezoneForZip:()=> 'America/New_York'}});
  const res=output();await handler({method:'GET'},res);assert.equal(res.code,200);assert.equal(res.payload.items.length,1);assert.equal(res.payload.items[0].disposition,'TREATED');assert.equal(res.payload.items[0].wantsCar,true);
});

test('open lower year bound allows X5 2020 65k and ZIP conversions honor local zone',()=>{
  assert.equal(offerKind({make:'BMW',model:'X5',year:2020,miles:65000},{make:'BMW',model:'X5',yearMin:2019,maxMiles:70000}),'BATE');
  assert.equal(timezoneForZip('79901'),'America/Denver');assert.equal(timezoneForZip('46311'),'America/Chicago');
  assert.equal(timezoneForZip('83814'),'America/Los_Angeles');assert.equal(timezoneForZip('97914'),'America/Denver');
  assert.equal(timezoneForZip('49801'),'America/Chicago');assert.equal(timezoneForZip('49913'),'America/New_York');
  assert.equal(localToUtc('2026-09-26T10:00',timezoneForZip('79901')),'2026-09-26T16:00:00.000Z');
});

test('presenting a unit twice uses the existing VIN identity',async()=>{
  const existing={id:cryptoId(77)};const vehicle={rowFingerprint:'vin:TEST',vin:'TEST',year:2020,make:'BMW',model:'X5',miles:65000};
  const current={...lead,offers:[vehicle]};let inserts=0;
  const server=mockServer({rows:async(_ctx,table)=>table==='manheim_vehicles'?[{vehicle_json:vehicle}]:table==='units'?[existing]:[],insert:async()=>{inserts++;return[];},patchRows:async()=>[]});
  const handler=loadWith('api/panel/lead.js',{'../../panel-server':server,'../../panel-lead':{leadData:async()=>current,ensureJourney:async()=>lead.record,localToUtc,addClientDays:()=>null},'../../panel-note':require('../panel-note')});
  const res=output();await handler({method:'POST',query:{},body:{action:'present',ref:lead.ref,journeyId,fingerprint:'vin:TEST'}},res);
  assert.equal(res.code,200);assert.equal(res.payload.unitId,existing.id);assert.equal(inserts,0);
});

test('archive skips invalid rows and reports ignored count',async()=>{
  const valid={fingerprint:'vin:OK',vehicle:{vin:'OK',year:2020,make:'BMW',model:'X5',miles:65000}};
  let archive=[];const server=mockServer({rows:async()=>[{id:journeyId}],supabase:async(_url,_key,_path,options)=>{archive=JSON.parse(options.body);return[];}});
  const handler=loadWith('api/panel/actions.js',{'../../panel-server':server});
  const res=output();await handler({method:'POST',body:{action:'manheim_archive',uploadId:journeyId,vehicles:[valid,{fingerprint:'bad',vehicle:{year:2020,model:'X5'}}]}},res);
  assert.equal(res.code,200);assert.deepEqual([res.payload.archived,res.payload.ignored],[1,1]);assert.equal(archive.length,1);
});

test('manual return date reaches delegated action as customer-zone UTC',async()=>{
  const converted={...lead,timezone:'America/Denver'};let delegated;
  const server=mockServer({rows:async()=>[],insert:async(_ctx,table)=>[{id:cryptoId(8)}],patchRows:async()=>[]});
  const handler=loadWith('api/panel/lead.js',{'../../panel-server':server,'../../panel-lead':{leadData:async()=>converted,ensureJourney:async()=>lead.record,localToUtc,addClientDays:()=>null},
    '../../panel-note':require('../panel-note'),'./actions':async(req,res)=>{delegated=req.body;res.status(200).json({saved:true});}});
  const res=output();await handler({method:'POST',query:{},body:{action:'manual',ref:'ABC23',journeyId,panelAction:'next_action',payload:{operation:'CREATE',text:'Retornar',atLocal:'2026-09-26T10:00'}}},res);
  assert.equal(res.code,200);assert.equal(delegated.at,'2026-09-26T16:00:00.000Z');assert.equal(delegated.atLocal,undefined);
});

test('migration pins note idempotency and presentation uniqueness to the environment',()=>{
  const sql=fs.readFileSync(path.join(root,'supabase/migrations/20260926060000_panel_fase2_corrections.sql'),'utf8');
  assert.match(sql,/unique index if not exists lead_notes_confirmation_key_unique on public\.lead_notes\(environment, confirmation_key\)/);
  assert.match(sql,/unique index if not exists units_journey_vehicle_unique on public\.units\(environment, journey_id, vehicle_identity\)/);
  assert.match(sql,/revoke all on function public\.panel_customer_unit_response[\s\S]*from public,anon,authenticated/);
});

test('Claude fenced response yields first JSON object',()=>{
  const { firstJson }=require('../api/panel/notes/distribute');
  assert.deepEqual(firstJson('```json\n{"items":[{"type":"payment","value":"cash"}]}\n```'),{items:[{type:'payment',value:'cash'}]});
});

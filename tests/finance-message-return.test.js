'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{create}=require('../finance-message-return');
function fixture(storage=new Map()){
  const events={},docEvents={},timers=[],urls=[];
  const win={document:{visibilityState:'visible',addEventListener:(name,fn)=>docEvents[name]=fn},addEventListener:(name,fn)=>events[name]=fn,setTimeout:fn=>timers.push(fn),sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}};
  const tracker=create(win,url=>urls.push(url));
  return {win,events,docEvents,timers,urls,storage,tracker,visibility(value){win.document.visibilityState=value;docEvents.visibilitychange();}};
}
test('app selection never redirects until a visible return and redirects once without claiming delivery',()=>{
  const f=fixture();f.tracker.arm('FNA23','pt','WHATSAPP');f.events.focus();assert.deepEqual(f.urls,[]);f.visibility('hidden');assert.deepEqual(f.urls,[]);f.visibility('visible');f.events.focus();f.events.pageshow({persisted:true});assert.deepEqual(f.urls,['/finance?lang=pt']);assert.equal(f.storage.size,0);
});
test('SMS return and restored tabs retain only bounded resume metadata, not message or personal details',()=>{
  const f=fixture();f.tracker.arm('FNA23','es','SMS');const persisted=JSON.parse([...f.storage.values()][0]);assert.deepEqual(Object.keys(persisted).sort(),['at','channel','hidden','language','ref']);
  const restored=fixture(f.storage);restored.timers.forEach(fn=>fn());assert.deepEqual(restored.urls,['/finance?lang=es']);assert.equal(restored.storage.size,0);
});
test('cancel, expired storage, tampered language and inaccessible storage cannot cause stale or foreign redirects',()=>{
  const f=fixture();f.tracker.arm('FNA23','en','SMS');f.tracker.clear();f.visibility('hidden');f.visibility('visible');assert.deepEqual(f.urls,[]);
  for(const change of [{at:Date.now()-21*60*1000},{language:'https://evil.example'},{ref:'invalid'}]){const bad=new Map([['mcs_finance_message_return_v1',JSON.stringify({ref:'FNA23',language:'en',channel:'SMS',at:Date.now(),...change})]]),r=fixture(bad);r.timers.forEach(fn=>fn());assert.deepEqual(r.urls,[]);assert.equal(bad.size,0);}
  const g=fixture();g.win.sessionStorage.setItem=()=>{throw Error('private mode');};g.tracker.arm('FNA23','en','SMS');g.visibility('hidden');g.visibility('visible');assert.deepEqual(g.urls,['/finance?lang=en']);
});

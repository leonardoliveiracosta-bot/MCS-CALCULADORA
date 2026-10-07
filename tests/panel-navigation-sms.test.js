'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const panel = fs.readFileSync('painel/painel.js', 'utf8');
const lead = fs.readFileSync('painel/lead.js', 'utf8');
function part(source, start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function navigation() {
  const nodes = new Map(), moves = [], frames = [], openings = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {textContent:'', replaceChildren(){}, classList:{add(){},remove(){},toggle(){},contains(){return true;}}});
    return nodes.get(id);
  };
  const ctx = {
    currentView:'today', currentDetail:null, viewRequestVersion:1, detailRequestVersion:0, detailOrigin:{view:'today'},
    VIEWS:['today','v1'], VIEW_LABELS:{today:'Hoje',v1:'V1'}, viewScroll:new Map(),
    window:{scrollY:350, scrollTo:(x,y)=>moves.push([x,y])},
    document:{querySelectorAll:()=>[], getElementById:node}, $:node,
    history:{replaceState(){},pushState(){}}, location:{pathname:'/painel/',search:'',hash:''},
    console, clearTimeout(){}, pendingContinueTimer:null, clearRecordDetail(){}, renderLoading(){},
    renderFailure(){}, loadCurrent:async()=>{}, captureOrigin:()=>({view:'today'}), detailHash:()=>'',
    request:async()=>({}), actionMessage(){}, downloadShortlist(){}, dispositionControls(){}, replyComposer(){}, openOptionsCard(){}, renderFichaOffersSummary(){},
    requestAnimationFrame:fn=>frames.push(fn), element:()=>({}),
    MCSLead:{open:options=>new Promise(resolve=>openings.push({options,resolve}))}
  };
  vm.createContext(ctx);
  vm.runInContext(part(panel,'  async function switchPanel(', '  // A18:') +
    part(panel,'  function showDetailShell(', '  /* ===== V1/V2:'),ctx);
  return {ctx,moves,frames,openings};
}
test('leaving a ficha invalidates its pending response and save callbacks',async()=>{
  const a=navigation();
  const pending=a.ctx.openDetail('ficha','a',{push:false});
  const old=a.openings[0];
  assert.equal(old.options.isCurrent(),true);
  await a.ctx.switchPanel('v1');
  assert.equal(old.options.isCurrent(),false);
  await old.options.onChanged();
  assert.equal(a.openings.length,1,'a late save must not reopen the old ficha');
  old.resolve();await pending;
  assert.equal(a.ctx.currentDetail,null);
  assert.equal(a.ctx.currentView,'v1');
});
test('a scheduled save scroll cannot move the operator after navigation',async()=>{
  const a=navigation();const pending=a.ctx.openDetail('ficha','a',{push:false,scrollY:700});
  a.openings[0].resolve();await pending;
  await a.ctx.switchPanel('v1');
  a.frames.forEach(fn=>fn());
  assert.ok(!a.moves.some(([,y])=>y===700));
});
test('a tab load cannot reset scroll after a ficha opens',async()=>{
  const a=navigation();await a.ctx.switchPanel('v1');
  const pending=a.ctx.openDetail('ficha','a',{push:false});
  a.frames.forEach(fn=>fn());assert.equal(a.moves.length,0);
  a.openings[0].resolve();await pending;
});
test('automatic refresh updates the open conversation, and ignores late scroll after changing ficha',async()=>{
  let release,reads=0;const moves=[],detail={kind:'ficha',key:'a'};
  const ctx={window:{scrollY:350,scrollTo:(x,y)=>moves.push([x,y])}, currentView:'today',viewRequestVersion:1,detailRequestVersion:1,currentDetail:detail,$:()=>({}),
    loadCurrent:()=>{throw Error('must not refresh a hidden tab');},MCSLead:{refresh:options=>{assert.equal(options.key,'a');reads++;return new Promise(r=>release=r);}},requestAnimationFrame:fn=>fn()};
  vm.createContext(ctx);vm.runInContext(part(panel,'  async function refreshCurrentPreservingState() {','  function captureOrigin()'),ctx);
  let pending=ctx.refreshCurrentPreservingState();release();await pending;assert.equal(reads,1);assert.equal(moves.length,1);
  pending=ctx.refreshCurrentPreservingState();ctx.detailRequestVersion++;ctx.currentDetail={kind:'ficha',key:'b'};release();await pending;assert.equal(moves.length,1);
});
test('new SMS redraws only the thread; unchanged or stale replies do not redraw it',async()=>{
  let current=true,fresh={record:{conversation:[{id:'sms1',body_text:'new SMS'}]}},draws=0,release;
  const root={draft:'unfinished reply'},liveViews=new WeakMap();
  const ctx={root,liveViews,kind:'ficha',key:'a',isCurrent:()=>current,
    request:()=>new Promise(r=>release=()=>r(fresh)),URLSearchParams,JSON,
    record:{id:'a'},messages:[],tzOf:'America/New_York',draw:()=>draws++,tr:null};
  vm.createContext(ctx);vm.runInContext(part(lead,'    liveViews.set(root,','    if(tr)tr.load();'),ctx);
  const view=liveViews.get(root);
  let pending=view.refresh();release();await pending;assert.equal(draws,1);assert.equal(ctx.messages[0].id,'sms1');assert.equal(root.draft,'unfinished reply');
  pending=view.refresh();release();await pending;assert.equal(draws,1);
  fresh={record:null};pending=view.refresh();release();await assert.rejects(pending,/LEAD_RESPONSE_INVALID/);assert.equal(draws,1);
  fresh={record:{conversation:[{id:'sms2'}]}};pending=view.refresh();current=false;release();await pending;
  assert.equal(draws,1);assert.equal(ctx.messages[0].id,'sms1');
});
test('delayed post-send reload does nothing after leaving the ficha',async()=>{
  let current=true,changed=0,callback;const ctx={window:{scrollY:350},isCurrent:()=>current,onChanged:async()=>changed++,setTimeout:fn=>callback=fn};
  vm.createContext(ctx);vm.runInContext(part(lead,'    const reload=','    // "Desfazer"')+part(lead,'    const afterSend=','    if(journeyId&&window.MCSSuggest)'),ctx);
  vm.runInContext('afterSend({});',ctx);current=false;await callback();assert.equal(changed,0);
});

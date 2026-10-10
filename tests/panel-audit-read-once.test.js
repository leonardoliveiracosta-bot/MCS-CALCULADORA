'use strict';
// Actual published UI functions, synthetic data, no live session or external network.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../painel/painel.js'),'utf8');
function part(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
class Node{
 constructor(tag='div',cls='',text=''){this.tagName=tag;this.className=cls;this.textContent=text;this.children=[];this.listeners={};this.dataset={};this.isConnected=true;this.classList={contains:c=>this.className.split(' ').includes(c),toggle:(c,on)=>{const s=new Set(this.className.split(' '));if(on??!s.has(c))s.add(c);else s.delete(c);this.className=[...s].join(' ');},add:c=>this.classList.toggle(c,true),remove:c=>this.classList.toggle(c,false)};}
 append(...xs){for(const x of xs){if(x&&typeof x==='object'){x.parentNode=this;x.isConnected=true;}this.children.push(x);}}
 replaceChildren(...xs){this.children.forEach(x=>{if(x&&typeof x==='object')x.isConnected=false;});this.children=[];this.append(...xs);}
 addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
 setAttribute(){} querySelectorAll(){return[];} closest(){return null;} contains(x){return x===this||this.children.some(c=>c&&typeof c==='object'&&c.contains(x));}
 insertAdjacentElement(_,node){(this.after??=new Node()).append(node);}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.isConnected=false;}
 async click(){for(const fn of this.listeners.click||[])await fn({target:this,stopPropagation(){},preventDefault(){}});}
}
const element=(...a)=>new Node(...a),text=n=>[n.textContent,...n.children.map(x=>x&&typeof x==='object'?text(x):x)].join(' ');
function dom(){const map=new Map();return {map,$:id=>{if(!map.has(id))map.set(id,new Node());return map.get(id);}};}
test('triage failure never looks like empty; retry restores normal zero only after successful read',async()=>{
 const d=dom(),ctx={...d,element,document:{querySelectorAll:()=>d.$('triage-state').after?.children||[],createTextNode:x=>x},attendData:{},scheduleAttendRender(){},request:async()=>{throw Error('offline');},hydrateContexts(){}};
 vm.createContext(ctx);vm.runInContext(part('  function renderOffTopic(','  async function loadWhatsApp('),ctx);
 assert.equal(await ctx.loadTriage(),null);assert.equal(d.$('topic-out-count').textContent,'—');assert.doesNotMatch(text(d.$('topic-out-list')),/Nenhuma conversa/);
 assert.equal(ctx.attendData.triageFailed,true);assert.match(text(d.$('triage-state').after),/Não consegui carregar/);const retry=d.$('triage-state').after.children[0].children.find(n=>n.tagName==='button');
 ctx.request=async()=>({review:[],out:[],offTopic:[],state:'DESLIGADA'});await retry.click();assert.equal(d.$('topic-out-count').textContent,'0');assert.match(text(d.$('topic-out-list')),/Nenhuma conversa/);assert.doesNotMatch(text(d.$('triage-state').after),/Não consegui/);assert.equal(ctx.attendData.triageFailed,false);
});
test('triage refresh failure keeps last good data, rows and counts',async()=>{
 const d=dom(),good={review:[],out:[{id:'saved'}]},saved=element('div','','Conversa já lida');d.$('triage-out-list').append(saved);d.$('triage-out-count').textContent='1';d.$('topic-out-count').textContent='2';
 const ctx={...d,element,document:{querySelectorAll:()=>[],createTextNode:x=>x},attendData:{triage:good},scheduleAttendRender(){},request:async()=>{throw Error('offline');}};
 vm.createContext(ctx);vm.runInContext(part('  function renderOffTopic(','  async function loadWhatsApp('),ctx);assert.equal(await ctx.loadTriage(),good);assert.equal(d.$('triage-out-list').children[0],saved);assert.equal(d.$('triage-out-count').textContent,'1');assert.equal(d.$('topic-out-count').textContent,'2');
 ctx.attendData.entry={};ctx.attendData.whatsapp={};vm.runInContext(source.split('\n').find(x=>x.includes('const sourcesReady ='))+' globalThis.ready=sourcesReady;',ctx);assert.equal(ctx.ready,false,'last good data must not prune selections or become a confirmed current counter');
});
test('opening queue uses the existing server badge rule, including already-sent V1 and two requests per person',async()=>{
 const d=dom(),badges=[],journeys=[{id:'a'},{id:'b'}],demands=[{key:'a-car',journeyId:'a',matchCount:1,offer:{lane:1}},{key:'a-value',journeyId:'a',matchCount:2,offer:{lane:2}},{key:'b-car',journeyId:'b',matchCount:1,offer:{lane:1}}];
 const ctx={...d,element,loadV1Sent:async()=>({journeys:new Set(['b']),refs:new Set()}),manheimJourneys:journeys,manheimOrders:[],calcRefOf:()=>null,demandPerson:x=>({journeyId:x.journeyId}),offerTotal:x=>x.lane,setCount:(_,n)=>badges.push(n),paintOptionsQueue(){},optionsQueueData:[],Set,Date};
 vm.createContext(ctx);vm.runInContext(source.split('\n').find(x=>x.includes('const optionsPeopleOf =')),ctx);vm.runInContext(part('  async function renderOptionsQueue(','  function queueMatches('),ctx);
 await ctx.renderOptionsQueue({upload:{id:'test'},demands},new Map(),new Map());assert.equal(badges.at(-1),require('../panel-counter-summary').optionsSummary(demands).peopleWithOptions);assert.equal(badges.at(-1),2);assert.equal(ctx.optionsQueueData.length,2);assert.equal(ctx.optionsQueueData[1].sent,true);
});
test('compare shortcut delegates to switchPanel once, without a second loadCurrent',async()=>{
 const d=dom();let loads=0;const ctx={...d,element,data:{upload:{}},document:{createTextNode:x=>x},switchPanel:async()=>{loads++;},loadCurrent:async()=>{loads++;},viewRequestVersion:1};
 vm.createContext(ctx);vm.runInContext(source.split('\n').find(x=>x.includes('if (data.upload) { const link')),ctx);await d.$('manheim-summary').children.find(x=>x.tagName==='button').click();assert.equal(loads,1);
});
test('saved search opens ficha or Ref order directly; no decorative button when both identities are absent',async()=>{
 const calls=[],people=new Node(),ctx={group:{clients:[{journeyId:'a',ref:'ABCDE'},{journeyId:null,ref:'FGHIJ'},{}]},element,phoneDisplay:x=>x,openDetail:(...xs)=>calls.push(xs),people};
 vm.createContext(ctx);vm.runInContext(part('  function openQueueDetail(','  const plural ='),ctx);const line=source.split('\n').find(x=>x.includes("const people=element('div','saved-search-clients hidden')"));vm.runInContext(line.slice(line.indexOf('(group.clients'),line.indexOf(' clients.addEventListener')),ctx);
 await people.children[0].click();await people.children[1].click();assert.deepEqual(calls,[['ficha','a'],['order','FGHIJ']]);assert.equal(people.children[2].tagName,'span');
});
test('same VIN selected via another sale stays checked and keeps the saved selection identity',()=>{
 const state={selectedIds:new Set(['buy']),listeners:[]},boxes=new Map(),ctx={element,milesText:String,clientSaleText:()=>'',formatMoney:String,offerFit:()=>element(),offerRow:()=>element()};vm.createContext(ctx);vm.runInContext(part('  function clientCarRow(','  // ===== Ficha'),ctx);
 ctx.clientCarRow({id:'lane',vehicle_json:{parsed:{vin:'TESTVIN',memberMatchIds:['buy','lane']}},offer:{status:'SELECTED'}},state,'LANE',boxes,()=>{});assert.equal(boxes.get('lane').checked,true);assert.deepEqual([...state.selectedIds],['buy']);
 const update={state,offer:{},paintCount(){},auditOn:()=>false};vm.createContext(update);vm.runInContext(part('    state.setSelected =','    state.listeners.push(() => picked.paint());'),update);
 state.setSelected('buy',true,1,['buy','lane']);assert.deepEqual([...state.selectedIds],['buy']);state.setSelected('buy',false,0,['buy','lane']);assert.equal(state.selectedIds.size,0);
});
test('644 queue rows are reused through search, sort, clearing and new-data replacement',()=>{
 const d=dom(),rows=Array.from({length:644},(_,id)=>({id}));let draws=0;const ctx={...d,element,optionsQueueData:rows,queueMatches:(r,q)=>!q||String(r.id).includes(q),sortQueue:x=>x,renderQueueRow:(root,r)=>{draws++;const line=element('div','','row'+r.id);root.append(line);return line;},optionsQueueHasUpload:true};
 vm.createContext(ctx);vm.runInContext(part('  function paintOptionsQueue(','  function openQueueDetail('),ctx);ctx.paintOptionsQueue();assert.equal(draws,644);const original=d.$('options-queue').children[1];
 d.$('options-queue-search').value='0';ctx.paintOptionsQueue();assert.equal(draws,644);assert.equal(d.$('options-queue').children[1],original);d.$('options-queue-search').value='';ctx.sortQueue=x=>[...x].reverse();ctx.paintOptionsQueue();assert.equal(draws,644);assert.equal(d.$('options-queue').children.at(-1),original);
 ctx.optionsQueueData=rows.map(r=>({...r}));ctx.paintOptionsQueue();assert.equal(draws,1288);assert.notEqual(d.$('options-queue').children.at(-1),original);
});
test('cached card moved between pointer press and release does not open; normal press remains direct',()=>{
 let opened=0;const card=element(),child=element();card.append(child);const ctx={window:{getSelection:()=>''}};vm.createContext(ctx);vm.runInContext(part('  function guardCardClick(','  function makeCardClickable('),ctx);ctx.guardCardClick(card,()=>opened++);
 card.listeners.pointerdown[0]({target:child});card.cardClickVersion=1;card.listeners.click[0]({target:child});assert.equal(opened,0);card.listeners.pointerdown[0]({target:child});card.listeners.click[0]({target:child});assert.equal(opened,1);
});
test('PDF uses the persisted selected sale of a grouped VIN, with no new request',async()=>{
 const calls=[],ctx={request:async(_,opts)=>{calls.push(JSON.parse(opts.body));return {};},printVitrine:async()=>{}};vm.createContext(ctx);vm.runInContext(part('  async function optionsPdf(','  async function printVitrine('),ctx);
 await ctx.optionsPdf([{id:'lane',vehicle_json:{parsed:{memberMatchIds:['lane','buy']}}}],{id:'journey'},new Set(['buy']));assert.deepEqual(calls[0].matchIds,['buy']);assert.equal(calls.length,1);
});
test('PDF selection read failure stays an error, never an unpriced successful PDF',async()=>{
 const id='6a200000-0000-4000-8000-000000000001';const rows=async(_,name)=>{if(name==='journeys')return[{id,contact_id:id}];if(name==='manheim_option_selections')throw Error('offline');return[];};
 await assert.rejects(require('../api/panel/vitrines').pdfData({environment:'preview'},{journeyId:id,matchIds:[id]},{rows}),/offline/);
});

function pageRoute(rpc){
 const server=fs.readFileSync(path.join(__dirname,'../api/panel/manheim-options.js'),'utf8'),a=server.indexOf('async function groupPage('),b=server.indexOf('// Selection for the customer.',a);
 const ctx={rpc,latestActiveUpload:async()=>({id:'upload'}),SORTS:{cr:true,year_desc:true},trimsOf:()=>[],selectionMissing:e=>e.code==='PGRST202',send:(_,status,data)=>({status,data})};vm.createContext(ctx);vm.runInContext(server.slice(a,b),ctx);return ctx.groupPage;
}
test('first page uses one bundle read; later page uses one page read without rebuilding trims',async()=>{
 const calls=[],run=pageRoute(async(_,name)=>{calls.push(name);return name.endsWith('_bundle')?{options:[],trims:[{trim_key:'ex',label:'EX',car_count:3,selected_count:1}]}:[];});
 const first=await run({environment:'preview'},{query:{}},'key','LANE',25);assert.equal(first.status,200);assert.equal(first.data.trims[0].count,3);assert.deepEqual(calls,['panel_manheim_offer_page_bundle']);
 calls.length=0;await run({environment:'preview'},{query:{cursor:'25'}},'key','LANE',25);assert.deepEqual(calls,['panel_manheim_offer_page']);
});
test('only a missing new RPC uses backward-compatible reads; real failures never become empty pages',async()=>{
 const calls=[],run=pageRoute(async(_,name)=>{calls.push(name);if(name.endsWith('_bundle'))throw Object.assign(Error('missing'),{code:'PGRST202'});return[];});
 assert.equal((await run({environment:'preview'},{query:{}},'key','LANE',25)).status,200);assert.deepEqual(calls,['panel_manheim_offer_page_bundle','panel_manheim_offer_trims','panel_manheim_offer_page']);
 const failure=pageRoute(async()=>{throw Error('offline');});await assert.rejects(failure({environment:'preview'},{query:{}},'key','LANE',25),/offline/);
});

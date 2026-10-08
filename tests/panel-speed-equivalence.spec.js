'use strict';
const {test,expect}=require('@playwright/test');
test.setTimeout(90000);
const rules=require('../panel-attend-page');
const sortApi=require('../panel-sort');
const base=process.env.PANEL_LOCAL_URL||'http://127.0.0.1:4173';
const id=n=>`7f300000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const now=new Date(), old=new Date(now-5*86400000).toISOString();
const seed=Array.from({length:83},(_,n)=>({kind:'JOURNEY',id:id(n+1),contactName:'Pessoa '+n,contact:{display_name:'Pessoa '+n},phones:[{phone_e164:'+1407555'+String(n).padStart(4,'0')}],hasCalcRef:n%3===0,calcRef:n%3===0?'B'+String(n).padStart(4,'2'):null,internalCode:'K'+String(n).padStart(4,'0'),purchaseWindow:n%4===0?'NOW':'NONE',sortAt:new Date(now-n*600000).toISOString(),awaitingReply:n%2===0,latestMessage:{direction:n%2?'MCS':'CUSTOMER',occurred_at_utc:old},group:{key:n%2?'ATENDIDO':'NAO_ATENDIDO',refState:n%3===0?'COM_REF':n%3===1?'A_RECUPERAR':'SEM_REF',unattended:n%2?null:{waitedMs:n*600000,timeLabel:`WhatsApp há ${n} h · sem resposta`,reasonText:'Responder'},subject:{key:n%2?'COMPRA_CARRO':'NAO_IDENTIFICADO'}},cardFacts:{modes:[],vehicleText:n===82?'Honda Lastcar':'BMW X5',zipText:'33101 — Miami, FL'}}));
const incomplete=Array.from({length:9},(_,n)=>({key:'req'+n,state:'PRECISA_DETALHE',person:{journeyId:id(101+n),name:'Incompleto '+n},missing:['anos'],lacksText:'Faltam anos',source:'CONVERSA'}));
const contexts=Object.fromEntries(incomplete.map((row,n)=>[row.person.journeyId,{hasCalcRef:n%2===0,calcRef:n%2===0?'C'+String(n).padStart(4,'3'):null,refState:n%2===0?'COM_REF':'SEM_REF',name:row.person.name,contact:{phones:['+1407999'+n]},origin:{code:'WHATSAPP:WHATSAPP',label:'WhatsApp'},listMessage:{at:old,direction:'CUSTOMER',channel:'WHATSAPP'},conversation:{lastAt:old}}]));
const v1={v1JourneyIds:[id(1),id(9)],v1Today:2};
const entry={chats:[],reviews:[],nameLinks:[]},triage={state:'LIGADA',review:[],offMcs:[]},whatsapp={suggestions:[],phoneReviews:[]};
const summary={summary:true,requestCount:6,items:incomplete};
async function setup(page,paged,{counterGate,bootCalls=[]}={}){
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('mcs_panel_session',JSON.stringify({accessToken:'fake',refreshToken:'fake',accessExpiresAt:Date.now()+3600000})));
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());if(!url.href.startsWith(base))return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  if(url.pathname.endsWith('/config'))return json({url:base+'/fake-auth',publishableKey:'fake'});
  if(url.pathname.endsWith('/session'))return json({email:'fake@example.test',environment:'preview',role:'admin'});
  if(url.pathname.endsWith('/client-context'))return json({journeys:contexts});
  if(url.pathname.endsWith('/vitrine-funnel'))return json(v1);
  if(url.pathname.endsWith('/pesquisas'))return json(summary);
  if(url.pathname.endsWith('/boot')){
   const input=route.request().postDataJSON();bootCalls.push(input);
   if(input.part==='counters' && counterGate)await counterGate;
   let today={items:seed.slice().sort((a,b)=>sortApi.compare(input.sort||'ready',a,b)),meta:{}};
   if(paged&&input.part==='main'&&input.page){
    const model=rules.modelOf(today,entry,triage,whatsapp,summary,input.sort||'ready',Date.now());
    const identities=new Map(Object.entries(contexts).map(([key,value])=>[key,rules.identityOf(value)]));
    const selected=rules.select(model,identities,{sort:input.sort||'ready',...input.page,v1JourneyIds:v1.v1JourneyIds});
    const rows=selected.order.slice(0,input.page.limit||30);
    today={...today,items:rows.map(row=>row.entry.item).filter(Boolean),page:{...selected,order:undefined,rows:rows.map(row=>({...row,entry:{...row.entry,item:undefined,itemCaseKey:row.entry.item?row.entry.key:null}})),identities:Object.fromEntries(identities),limit:input.page.limit,total:selected.order.length,key:JSON.stringify([input.sort||'ready',input.page.ref,input.page.stat||null,input.page.query||'']),v1Today:2}};
   }
   const bodies=input.part==='main'?{today,entry,triage,whatsapp,...(paged?(input.includeCounters?{pesquisas:summary,manheim:{summary:true,peopleWithOptions:2},v1}:{completing:{items:incomplete},v1}):{})}:{pesquisas:summary,manheim:{summary:true,peopleWithOptions:2}};
   return json({part:input.part,parts:Object.fromEntries(Object.entries(bodies).map(([key,body])=>[key,{ok:true,hash:JSON.stringify([input.part,input.sort,input.page])+key,body}]))});
  }
  return json({items:[],orders:[],demands:[],counts:{},groups:[],chats:[],reviews:[],signals:[],meta:{}});
 });
 await page.goto(base+'/painel/');await expect(page.locator('#today-list .attend-row')).toHaveCount(30);
 await expect(page.locator('[data-count="today"]').first()).toHaveText('92');
 return errors;
}
async function snapshot(page){return page.evaluate(()=>({rows:[...document.querySelectorAll('#today-list .attend-row')].map(row=>({key:row.dataset.caseKey,group:row.dataset.group,area:row.dataset.area,subject:row.dataset.subject,text:row.textContent})),refs:[...document.querySelectorAll('[data-today-ref]')].map(node=>node.textContent),stats:[...document.querySelectorAll('#today-stats button')].map(node=>({text:node.textContent,title:node.title})),more:document.querySelector('.attend-more-button')?.textContent}));}
test('paginação entrega a mesma tabela, contagens, filtros e busca global do cálculo anterior',async({browser})=>{
 const oldContext=await browser.newContext(),newContext=await browser.newContext();
 const oldPage=await oldContext.newPage(),newPage=await newContext.newPage();
 const errors=[...await setup(oldPage,false),...await setup(newPage,true)];
 await oldPage.waitForTimeout(600);
 expect(await snapshot(newPage)).toEqual(await snapshot(oldPage));
 // More asks for the next slice without losing, repeating or reordering any earlier case.
 for(let n=0;n<3;n++){
  await oldPage.locator('.attend-more-button').click();await newPage.locator('.attend-more-button').click();
  await expect(newPage.locator('#today-list .attend-row')).toHaveCount(Math.min(92,60+n*30));
  expect(await snapshot(newPage)).toEqual(await snapshot(oldPage));
 }
 for(const ref of ['with','recover','without','all']){
  await oldPage.locator(`[data-today-ref="${ref}"]`).click();await newPage.locator(`[data-today-ref="${ref}"]`).click();
  await newPage.waitForTimeout(500);
  expect(await snapshot(newPage)).toEqual(await snapshot(oldPage));
 }
 for(const query of ['Lastcar','Incompleto 8','14075550082','nenhum resultado']){
  await oldPage.locator('#attend-search').fill(query);await newPage.locator('#attend-search').fill(query);
  await oldPage.waitForTimeout(300);
  await newPage.waitForTimeout(500);
  expect(await snapshot(newPage)).toEqual(await snapshot(oldPage));
 }
 await oldPage.locator('#attend-search').fill('');await newPage.locator('#attend-search').fill('');await oldPage.waitForTimeout(300);
 for(const stat of ['hot','late24','sent','sent']){
  await oldPage.locator(`[data-today-stat="${stat}"]`).click();await newPage.locator(`[data-today-stat="${stat}"]`).click();
  await newPage.waitForTimeout(500);
  expect(await snapshot(newPage)).toEqual(await snapshot(oldPage));
 }
 for(const sort of ['recent','oldest','ref_recent','value_desc','value_asc','location','vehicle','ready']){
  await oldPage.locator('#today-sort').selectOption(sort);await newPage.locator('#today-sort').selectOption(sort);
  await newPage.waitForTimeout(500);
  expect(await snapshot(newPage)).toEqual(await snapshot(oldPage));
 }
 expect(errors).toEqual([]);await oldContext.close();await newContext.close();
});

test('fila completa chega antes dos contadores lentos; contagens finais corretas e nenhuma carga principal duplicada',async({page})=>{
 let release;
 const counterGate=new Promise(resolve=>{release=resolve;});
 const bootCalls=[];
 const errors=await setup(page,true,{counterGate,bootCalls});
 try {
  await expect(page.locator('#today-list .attend-row')).toHaveCount(30);
  await expect(page.locator('[data-today-ref="all"]')).toContainText('92');
  expect(bootCalls.filter(call=>call.part==='main')).toHaveLength(1);
  expect(bootCalls.find(call=>call.part==='main').includeCounters).toBe(false);
  const before=await snapshot(page);
  release();
  await expect(page.locator('[data-count="requests"]').first()).toHaveText('6');
  await expect(page.locator('[data-count="searches"]').first()).toHaveText('2');
  expect(await snapshot(page)).toEqual(before);
  expect(bootCalls.filter(call=>call.part==='main')).toHaveLength(1);
  expect(bootCalls.filter(call=>call.part==='counters')).toHaveLength(1);
  expect(errors).toEqual([]);
 } finally {release();}
});

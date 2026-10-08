'use strict';
const {test,expect}=require('@playwright/test');
const base=process.env.PANEL_LOCAL_URL||'http://127.0.0.1:4173';
const id=n=>`7f200000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const items=Array.from({length:70},(_,n)=>({kind:'JOURNEY',id:id(n+1),contact:{display_name:'Cliente '+n},phones:[],sortAt:'2026-10-01T00:00:00Z',group:{key:'ATENDIDO'},cardFacts:{modes:[],vehicleText:'BMW X5'}}));

test('voltar para TODOS mostra a lista já carregada e Mostrar mais mantém todos os casos durante a atualização',async({page})=>{
 let delay=0, mains=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('mcs_panel_session',JSON.stringify({accessToken:'token-ficticio',refreshToken:'refresh-ficticio',accessExpiresAt:Date.now()+3600000})));
 await page.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());if(!url.href.startsWith(base))return route.abort();if(!url.pathname.startsWith('/api/'))return route.continue();
  const json=body=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  if(url.pathname==='/api/panel/config')return json({url:base+'/auth-simulado',publishableKey:'fake'});
  if(url.pathname==='/api/panel/session')return json({email:'ficticio@example.test',environment:'preview',role:'admin'});
  if(url.pathname==='/api/panel/boot'){
   const input=req.postDataJSON();if(input.part==='main'){
    ++mains;if(delay)await new Promise(r=>setTimeout(r,delay));
    return json({part:'main',generatedAt:new Date().toISOString(),parts:{today:{ok:true,hash:'t',body:{items,meta:{}}},entry:{ok:true,hash:'e',body:{chats:[],reviews:[]}},triage:{ok:true,hash:'r',body:{}},whatsapp:{ok:true,hash:'w',body:{}}}});
   }
   return json({part:'counters',parts:{pesquisas:{ok:true,hash:'p',body:{summary:true,requestCount:2,items:[]}},manheim:{ok:true,hash:'m',body:{summary:true,peopleWithOptions:1}}}});
  }
  return json({items:[],orders:[],demands:[],counts:{},groups:[],chats:[],reviews:[],signals:[],meta:{}});
 });
 await page.goto(base+'/painel/');
 const rows=page.locator('#today-list .attend-row');await expect(rows).toHaveCount(30);
 await page.locator('.attend-more-button').click();await expect(rows).toHaveCount(60);
 await page.locator('.tab[data-view="v1"]').click();await expect(page.locator('#v1-panel')).toBeVisible();
 delay=1800;await page.locator('.tab[data-view="today"]').click();
 await expect(rows).toHaveCount(60,{timeout:500});await expect(page.locator('#today-panel')).toBeVisible();
 await expect.poll(()=>mains).toBe(2);await page.waitForTimeout(2200);
 await expect(rows).toHaveCount(60);
 await page.locator('.attend-more-button').click();await expect(rows).toHaveCount(70);
 const keys=await rows.evaluateAll(nodes=>nodes.map(n=>n.dataset.caseKey));expect(new Set(keys).size).toBe(70);
 expect(errors).toEqual([]);
});

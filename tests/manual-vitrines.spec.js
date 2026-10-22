'use strict';
const {test,expect}=require('@playwright/test');
const manual=require('../api/panel/manual-vitrines');
const photosApi=require('../api/panel/vitrine-photos');
const {publicResponse}=require('../vitrine-domain');
const {resetUndoSupport}=require('../panel-manheim-state');
const {randomUUID}=require('node:crypto');
const fs=require('node:fs');
if(process.env.CHROMIUM_PATH)test.use({launchOptions:{executablePath:process.env.CHROMIUM_PATH}});
const base='http://127.0.0.1:4173',ID='22222222-2222-4222-8222-222222222222',UPLOAD='33333333-3333-4333-8333-333333333333';
async function setup(page,context,version,failPhoto=false){
 resetUndoSupport();const ctx={environment:'preview',panel:{id:'11111111-1111-4111-8111-111111111111'},config:{url:'manual-ui'}};
 const rows={vitrines:[],vitrine_cars:[],manheim_uploads:[{id:UPLOAD,environment:'preview',undone_at:null,activated_at:'2026-10-01'}],manheim_vehicles:[{id:ID,upload_id:UPLOAD,environment:'preview',undone_at:null,vehicle_json:{year:2023,make:'Jeep',model:'Grand Cherokee L',vin:'1C4RJKBG0P8004352',mmrCents:2500000,cleanTitle:true,odometerOk:true,startsAt:'2099-10-22',engine:'6-cylinder'}}]};
 const calls=[],wa=[];let creates=0,failed=false;
 const services={rows:async(_ctx,table,params)=>{calls.push(table);return (rows[table]||[]).filter(row=>Object.entries(params).every(([key,value])=>{
  if(['select','limit','order'].includes(key))return true;const target=key==='vehicle_json->>vin'?row.vehicle_json.vin:row[key];
  if(value==='is.null')return target==null;if(value==='not.is.null')return target!=null;if(value.startsWith('eq.'))return String(target)===value.slice(3);if(value.startsWith('in.('))return value.slice(4,-1).split(',').includes(String(target));if(value.startsWith('ilike.*'))return String(target).endsWith(value.slice(7));throw Error(value);
 }));},rpc:async(_ctx,_name,args)=>{creates++;const v={id:randomUUID(),environment:ctx.environment,reference_code:'',created_by:ctx.panel.id,created_at:new Date().toISOString(),manual_request_id:args.p_request,manual_payload_hash:args.p_hash,...args.p_vitrine};rows.vitrines.push(v);args.p_cars.forEach(car=>rows.vitrine_cars.push({id:randomUUID(),environment:ctx.environment,vitrine_id:v.id,...car}));return v;},upload:async()=>{},patchRows:async(_ctx,table,filters,payload)=>{Object.assign(rows[table].find(row=>row.id===filters.id.slice(3)),payload);}};
 await context.route('https://fonts.googleapis.com/**',r=>r.abort());
 await context.route(/https:\/\/(?:wa\.me|web\.whatsapp\.com|api\.whatsapp\.com)\//,r=>{wa.push(r.request().url());return r.fulfill({body:'Mock WhatsApp'});});
 await page.route('**/api/panel/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  try{
   if(path==='/api/panel/manual-vitrines')return route.fulfill({json:route.request().method()==='POST'?await manual.create(ctx,route.request().postDataJSON(),services):url.searchParams.has('vin')?await manual.search(ctx,url.searchParams.get('vin'),services):await manual.history(ctx,url.searchParams.get('version'),services)});
   if(path==='/api/panel/vitrine-photos'){
    if(failPhoto&&!failed){failed=true;return route.fulfill({status:503,json:{error:'PHOTO_UPLOAD_FAILED'}});}
    const result=await photosApi.savePhoto(ctx,{vitrineId:url.searchParams.get('vitrineId'),carId:url.searchParams.get('carId'),buffer:route.request().postDataBuffer()},services);return route.fulfill({status:result.status,json:result});
   }
   return route.fulfill({status:401,json:{error:'AUTH_REQUIRED'}});
  }catch(error){return route.fulfill({status:error.status||400,json:{error:error.code||'ERROR'}});}
 });
 await page.goto(base+'/painel/');
 await page.evaluate(version=>{
  document.body.classList.remove('login-screen');document.querySelector('#login-view').classList.add('hidden');document.querySelector('#app-view').classList.remove('hidden');
  document.querySelectorAll('.panel-view').forEach(view=>view.classList.toggle('hidden',view.id!==version.toLowerCase()+'-panel'));
  window.manualMount=()=>MCSManualVitrines.mount({root:document.getElementById(version.toLowerCase()+'-manual'),version,request:async(url,options)=>{const response=await fetch(url,options);const data=await response.json();if(!response.ok)throw Object.assign(Error(data.error),{code:data.error});return data;},resizePhoto:async file=>file});window.manualMount();
 },version);
 return {rows,calls,wa,creates:()=>creates};
}
async function choose(page){await page.getByLabel('VIN completo ou últimos 6 caracteres').fill('004352');await page.getByRole('button',{name:'Buscar carro',exact:true}).click();await page.getByRole('button',{name:'Escolher',exact:true}).click();}
test('manual V1 creates for a new phone without a customer message and opens the chosen WhatsApp only after a click',async({page,context})=>{
 await page.setViewportSize({width:390,height:900});const app=await setup(page,context,'V1');
 await page.getByRole('button',{name:'Criar V1',exact:true}).click();await page.getByLabel('Nome do destinatário').fill('Alex');await page.getByLabel('WhatsApp (opcional').fill('3055550100');await choose(page);
 await page.getByRole('button',{name:'Gerar V1',exact:true}).click();await expect(page.locator('.manual-vitrine-result')).toContainText('Ver V1');expect(app.creates()).toBe(1);expect(app.wa).toEqual([]);
 expect(app.calls).not.toContain('messages');expect(app.calls).not.toContain('vitrine_requests');expect(app.rows.vitrines[0].reference_code).toBe('');
 await context.route(/\/v\/[A-Za-z0-9_-]{43}$/,r=>r.fulfill({body:fs.readFileSync('v/index.html','utf8'),contentType:'text/html'}));
 await context.route('**/api/vitrine?**',r=>r.fulfill({json:r.request().method()==='POST'?{ok:true}:{...publicResponse(app.rows.vitrines[0],app.rows.vitrine_cars),whatsAppNumber:'13055550199'}}));
 const preview=page.waitForEvent('popup');await page.getByRole('link',{name:'Ver V1',exact:true}).click();const customer=await preview;await expect(customer.locator('.mcs-car')).toContainText('6-cylinder');await expect(customer.locator('.mcs-intro')).not.toContainText('Ref');await customer.close();
 const popup=page.waitForEvent('popup');await page.getByRole('link',{name:'Enviar pelo WhatsApp',exact:true}).click();const tab=await popup;await tab.waitForLoadState();
 await expect.poll(()=>app.wa.length).toBe(1);const url=new URL(app.wa[0]);expect(url.hostname==='wa.me'?url.pathname.slice(1):url.searchParams.get('phone')).toBe('13055550100');expect(url.searchParams.get('text')).toContain('/v/'+app.rows.vitrines[0].token);
});
test('manual V2 has no prior V1, uploads photos, and resumes a failed upload without creating a second link',async({page,context})=>{
 await page.setViewportSize({width:320,height:900});const app=await setup(page,context,'V2',true);await page.getByRole('button',{name:'Criar V2',exact:true}).click();await choose(page);
 await page.getByLabel('Limite do cliente').fill('30k');await page.getByLabel('Nota para o cliente').fill('Customer note');
 await page.getByLabel('Fotos (até 12').setInputFiles({name:'car.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ywI0AAAAASUVORK5CYII=','base64')});
 await page.getByRole('button',{name:'Gerar V2',exact:true}).click();await expect(page.locator('.manual-vitrine-form')).toContainText('Não terminei as fotos');
 await page.getByRole('button',{name:'Gerar V2',exact:true}).click();await expect(page.locator('.manual-vitrine-result')).toContainText('Ver V2');expect(app.creates()).toBe(1);expect(app.rows.vitrines[0].version).toBe('V2');expect(app.rows.vitrine_cars[0].photo_paths).toHaveLength(1);
 const data=publicResponse(app.rows.vitrines[0],app.rows.vitrine_cars);expect(data.cars[0].customerLimitCents).toBe(3000000);expect(data.cars[0].note).toBe('Customer note');expect(app.wa).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await page.screenshot({path:'/tmp/mcs-manual-v2-320.png',fullPage:true});
});
test('history and repeated automatic mounts preserve the unfinished draft and VIN selection',async({page,context})=>{
 await page.setViewportSize({width:390,height:900});await setup(page,context,'V1');await page.getByRole('button',{name:'Criar V1',exact:true}).click();await page.getByLabel('Nome do destinatário').fill('Draft name');await choose(page);
 await page.evaluate(()=>window.manualMount());await page.getByRole('button',{name:'Histórico de criações'}).click();await expect(page.getByLabel('Nome do destinatário')).toHaveValue('Draft name');await expect(page.locator('.manual-vitrine-form')).toContainText('VIN final 004352');
 await page.getByRole('button',{name:'Gerar V1',exact:true}).click();await expect(page.locator('.manual-vitrine-result')).toContainText('Copiar mensagem');await expect(page.getByRole('link',{name:'Enviar pelo WhatsApp',exact:true})).toHaveCount(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:'/tmp/mcs-manual-v1-390.png',fullPage:true});
});

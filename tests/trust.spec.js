'use strict';
const {test,expect}=require('@playwright/test');
const fs=require('node:fs'),path=require('node:path');
const base='http://127.0.0.1:4173';
const contact={
  en:['Add us to contacts',"Know it's us when your specialist reaches out",'SAVE'],
  es:['Agréganos a tus contactos','Así sabrás que somos nosotros cuando tu especialista te escriba','GUARDAR'],
  pt:['Adicione a gente aos contatos','Para saber que somos nós quando o seu especialista entrar em contato','SALVAR']
};
const landing={
  en:{eyebrow:'OUR BUYING STANDARD',title:['SAME CARS DEALERS STOCK','HAND-PICKED FOR YOU'],items:['LEASE RETURNS, TRADE-INS, FLEET','MATCHED TO YOUR CRITERIA','CLEAN TITLE, DOCUMENTED MILES','REVIEWED WITH YOU'],step:'REAL NUMBERS FIRST',stepCopy:'Wholesale reference, photos and condition info before we bid anything',ready:'Wholesale numbers before you commit, no pressure'},
  es:{eyebrow:'NUESTRO ESTÁNDAR DE COMPRA',title:['LOS MISMOS AUTOS DE LOS DEALERS','ELEGIDOS PARA TI'],items:['FIN DE LEASING, AUTOS DE INTERCAMBIO, FLOTA','SEGÚN TUS CRITERIOS','TÍTULO LIMPIO, MILLAS DOCUMENTADAS','REVISADO CONTIGO'],step:'NÚMEROS REALES PRIMERO',stepCopy:'Referencia mayorista, fotos y condición antes de cualquier oferta',ready:'Números mayoristas antes de comprometerte, sin presión'},
  pt:{eyebrow:'NOSSO PADRÃO DE COMPRA',title:['OS MESMOS CARROS DAS LOJAS','ESCOLHIDOS A DEDO PARA VOCÊ'],items:['FIM DE LEASING, CARROS DE TROCA, FROTA','ESCOLHIDO PELO SEU CRITÉRIO','TÍTULO LIMPO, MILHAGEM DOCUMENTADA','REVISADO COM VOCÊ'],step:'NÚMEROS REAIS PRIMEIRO',stepCopy:'Referência de atacado, fotos e condição antes de qualquer lance',ready:'Números de atacado antes de você se comprometer, sem pressão'}
};
async function isolate(page){await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());}
for(const width of [320,390,1440])test('trust content and mobile layout at '+width,async({page})=>{
  await page.setViewportSize({width,height:900});const errors=[];page.on('pageerror',e=>errors.push(e.message));await isolate(page);await page.goto(base+'/');
  for(const lang of ['en','es','pt']){
    if(lang!=='en'){await page.locator('#btn-lang').click();await page.locator('#sheet-lang [data-set-lang="'+lang+'"]').click();}
    const c=landing[lang];await expect(page.locator('#padrao .buying-standard__eyebrow')).toHaveText(c.eyebrow);await expect(page.locator('#padrao h2')).toHaveText(c.title.join(''));await expect(page.locator('#padrao h2 br')).toHaveCount(1);await expect(page.locator('#padrao h3')).toHaveText(c.items);
    await expect(page.locator('#como-funciona .step').nth(2).locator('.step-text > p').first()).toHaveText(c.step);await expect(page.locator('#como-funciona .step').nth(2).locator('.step-desc > span')).toHaveText(c.stepCopy);await expect(page.locator('#como-funciona .step').nth(2).locator('.step-desc')).toContainText('CARFAX as the deal advances');await expect(page.locator('#comecar .ready-wholesale')).toHaveText(c.ready);
    expect(await page.locator('#padrao').innerText()).not.toMatch(/salvage|rebuilt|we pass|few cars/i);
    const position=await page.evaluate(()=>{const how=document.getElementById('como-funciona'),standard=document.getElementById('padrao'),ready=document.getElementById('comecar'),promise=ready.querySelector('.ready-wholesale');let next=how.nextElementSibling;while(next?.classList.contains('sep'))next=next.nextElementSibling;return {afterHow:next===standard,promiseAfterText:promise.previousElementSibling.classList.contains('ready-text'),promiseBeforeButtons:Boolean(promise.compareDocumentPosition(ready.querySelector('.ready-btn'))&Node.DOCUMENT_POSITION_FOLLOWING),overflow:document.documentElement.scrollWidth>innerWidth};});
    expect(position).toEqual({afterHow:true,promiseAfterText:true,promiseBeforeButtons:true,overflow:false});
  }
  expect(errors).toEqual([]);
});
for(const width of [320,390,1440])test('contact card in each path and language at '+width,async({page})=>{
  await page.setViewportSize({width,height:900});await isolate(page);await page.goto(base+'/msc-calculadora.html');await expect(page.locator('.mcs-save-contact')).toHaveCount(3);
  for(const [choice,id]of [['calculate','path-a'],['find','path-b'],['finance','path-finance']]){
    await page.locator('[data-start="'+choice+'"]').click();const screen=page.locator('#'+id),card=screen.locator('.mcs-save-contact');await expect(card).toBeVisible();await expect(card.locator('a')).toHaveAttribute('href','/mycarscout.vcf');await expect(card.locator('a')).toHaveAttribute('target','_top');
    for(const lang of ['en','es','pt']){await screen.locator('[data-lang="'+lang+'"]').click();await expect(card.locator('strong')).toHaveText(contact[lang][0]);await expect(card.locator('.mcs-save-contact__copy')).toHaveText(contact[lang][1]);await expect(card.locator('a')).toHaveText(contact[lang][2]);const bounds=await card.evaluate(el=>{const rect=el.getBoundingClientRect(),button=el.querySelector('a').getBoundingClientRect();return {inside:button.left>=rect.left&&button.right<=rect.right,hitHeight:button.height};});expect(bounds.inside).toBe(true);expect(bounds.hitHeight).toBeGreaterThanOrEqual(44);}
    const order=await card.evaluate(el=>{const primary=el.parentElement.querySelector('.contact-cta__choices')||document.getElementById('finance-submit');return el.getBoundingClientRect().top>=primary.getBoundingClientRect().bottom;});expect(order).toBe(true);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await screen.locator('[data-back-choice]').click();
  }
});
test('SAVE leaves the iframe with a valid static vCard',async({page})=>{
  await page.setViewportSize({width:390,height:900});await isolate(page);const vcf=fs.readFileSync(path.join(__dirname,'..','mycarscout.vcf'));const config=JSON.parse(fs.readFileSync(path.join(__dirname,'..','vercel.json'),'utf8'));const headers=Object.fromEntries(config.headers.find(h=>h.source==='/mycarscout.vcf').headers.map(h=>[h.key.toLowerCase(),h.value]));let top=false;
  await page.route('**/mycarscout.vcf',route=>{top=route.request().frame()===page.mainFrame();return route.fulfill({status:200,headers,body:vcf});});await page.goto(base+'/');const frame=page.frameLocator('iframe.calc-frame');await frame.locator('[data-start="finance"]').click();const pending=page.waitForEvent('download');await frame.locator('#path-finance .mcs-save-contact a').click();const download=await pending;expect(top).toBe(true);expect(download.suggestedFilename()).toBe('mycarscout.vcf');const file=fs.readFileSync(await download.path(),'utf8');expect(file).toBe(vcf.toString('utf8'));expect(file.split('\r\n')).toEqual(['BEGIN:VCARD','VERSION:3.0','FN:My Car Scout','N:;My Car Scout;;;','ORG:My Car Scout','TEL;TYPE=CELL:+13055400742','URL:https://mycarscout.net','END:VCARD','']);expect(headers['content-type']).toMatch(/^text\/vcard/);
});

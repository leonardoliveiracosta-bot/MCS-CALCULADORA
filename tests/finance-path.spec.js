'use strict';
const {test,expect}=require('@playwright/test');
const model=require('../finance-model'),base='http://127.0.0.1:4173';
test.use({viewport:{width:390,height:900}});
async function routes(page){await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());}
async function fill(page){for(const [field,value]of Object.entries({credit_profile:'very_good',down_payment:'2500_5000',monthly_payment:'400_600',trade_in:'yes'}))await page.locator('#finance-form input[name="'+field+'"][value="'+value+'"]').check();}
for(const lang of ['en','es','pt'])test('mobile finance '+lang+' validates, preserves selection and sends localized saved Ref',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));let saved;
  await routes(page);await page.route('**/api/finance-request',route=>{saved=route.request().postDataJSON();return route.fulfill({json:{ok:true,ref:'FNA23'}});});
  await page.addInitScript(()=>{window.open=()=>({closed:false,opener:null,close(){this.closed=true;},location:{replace(url){window.financeWhatsApp=url;}}});});
  await page.goto(base+'/msc-calculadora.html');await page.locator('#path-entry [data-lang="'+lang+'"]').click();await expect(page.locator('[data-start="finance"] strong')).toHaveText(model.copy(lang).gate);await page.locator('[data-start="finance"]').click();
  await expect(page.locator('#path-finance h1')).toHaveText(model.copy(lang).title);await page.locator('#finance-submit').click();await expect(page.locator('#finance-form .err.on')).toHaveCount(4);expect(saved).toBeUndefined();
  await fill(page);await expect(page.locator('#finance-ready')).toBeVisible();await expect(page.locator('#finance-form .err.on')).toHaveCount(0);
  await page.locator('#path-finance [data-back-choice]').click();await expect(page.locator('#path-entry')).toBeVisible();await page.locator('[data-start="finance"]').click();await expect(page.locator('#finance-ready')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#finance-submit').click();await expect.poll(()=>page.evaluate(()=>window.financeWhatsApp)).toContain('https://wa.me/13055400742?text=');
  expect(saved.language).toBe(lang);expect(model.valid(saved.answers)).toBe(true);expect(await page.evaluate(()=>decodeURIComponent(window.financeWhatsApp.split('?text=')[1]))).toBe(model.message(saved.answers,lang,'FNA23'));expect(errors).toEqual([]);
});
test('failed save stays on finance and allows retry without losing answers',async({page})=>{
  await routes(page);let calls=0,ids=[];await page.route('**/api/finance-request',route=>{calls++;ids.push(route.request().postDataJSON().requestId);return route.fulfill({status:calls===1?503:200,json:calls===1?{error:'FINANCE_UNAVAILABLE'}:{ok:true,ref:'FNA23'}});});await page.addInitScript(()=>{window.open=()=>({closed:false,opener:null,close(){this.closed=true;},location:{replace(url){window.financeWhatsApp=url;}}});});
  await page.goto(base+'/msc-calculadora.html?start=finance');await fill(page);await page.locator('#finance-submit').click();await expect(page.locator('#finance-save-error')).toBeVisible();expect(await page.evaluate(()=>window.financeWhatsApp)).toBeUndefined();await expect(page.locator('#finance-ready')).toBeVisible();await page.locator('#finance-submit').click();await expect.poll(()=>page.evaluate(()=>window.financeWhatsApp)).toBeTruthy();expect(ids[0]).toBe(ids[1]);
});
test('landing accepts listing inline in all languages and preserves existing financing values',async({page})=>{
  await routes(page);let reads=0;await page.route('**/api/listing-reference?**',route=>{reads++;return route.fulfill({json:{vehicle:{make:'BMW',model:'X3',year:2021,trim:'xDrive30i'}}});});await page.goto(base+'/');
  const form=page.locator('[data-mcs-listing-reference]');await expect(form.locator('input')).toBeVisible();expect(await form.getByText('Close',{exact:true}).count()).toBe(0);
  for(const [lang,heading,placeholder]of [['en','Already found a car?','Paste listing link'],['es','¿Ya encontraste un auto?','Pega el enlace del anuncio'],['pt','Já encontrou um carro?','Cole o link do anúncio']]){await page.locator('#btn-lang').click();await page.locator('#sheet-lang [data-set-lang="'+lang+'"]').click();await expect(form.locator('label')).toHaveText(heading);await expect(form.locator('input')).toHaveAttribute('placeholder',placeholder);}
  await form.locator('input').fill('https://example.com/download.exe');await form.locator('button').click();await expect(page.locator('#criteria-reference-status')).toContainText('válido');expect(reads).toBe(0);
  await form.locator('input').fill('https://example.com/car?original=1');await form.locator('button').click();const frame=page.frameLocator('iframe.calc-frame');await expect(frame.locator('#path-reference')).toBeVisible();await expect(frame.locator('.listing-reference-car')).toContainText('BMW X3');expect(reads).toBe(1);await expect(frame.locator('#listing-reference-toggle')).toHaveCount(0);
  await page.locator('#fin-down').fill('5000');await page.locator('#fin-month').fill('600');const href=decodeURIComponent(await page.locator('#fin-send').getAttribute('href'));expect(href).toContain('$5,000');expect(href).toContain('$600');
});
test('320px and desktop finance keep two columns and no horizontal overflow',async({page})=>{
  await routes(page);for(const width of [320,1440]){await page.setViewportSize({width,height:900});await page.goto(base+'/msc-calculadora.html?start=finance');await page.locator('#path-finance [data-lang="es"]').click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const chips=page.locator('.finance-chips').first();expect((await chips.evaluate(el=>getComputedStyle(el).gridTemplateColumns)).split(' ').length).toBe(2);await expect(chips.locator('.finance-chip--wide')).toHaveCount(1);}
});

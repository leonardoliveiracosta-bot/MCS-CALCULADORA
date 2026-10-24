'use strict';
const {test,expect}=require('@playwright/test');
const model=require('../finance-model'),base='http://127.0.0.1:4173';
test.use({viewport:{width:390,height:900}});
async function routes(page){await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());}
async function fill(page){for(const [field,value]of Object.entries({credit_profile:'very_good',down_payment:'2500_5000',monthly_payment:'400_600',trade_in:'yes'}))await page.locator('#finance-form input[name="'+field+'"][value="'+value+'"]').check();}
for(const lang of ['en','es','pt'])test('mobile finance '+lang+' validates, saves contact and offers application or WhatsApp',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));let saved;
  await routes(page);await page.route('**/api/finance-request',route=>{saved=route.request().postDataJSON();return route.fulfill({json:{ok:true,ref:'FNA23'}});});
  await page.goto(base+'/msc-calculadora.html');await page.locator('#path-entry [data-lang="'+lang+'"]').click();await expect(page.locator('[data-start="finance"] strong')).toHaveText(model.copy(lang).gate);await page.locator('[data-start="finance"]').click();
  await expect(page.locator('#path-finance h1')).toHaveText(model.copy(lang).title);await page.locator('#finance-submit').click();await expect(page.locator('#finance-form .err.on')).toHaveCount(4);expect(saved).toBeUndefined();
  await fill(page);await expect(page.locator('#finance-contact')).toBeVisible();await expect(page.locator('#finance-form .err.on')).toHaveCount(0);
  await page.locator('#path-finance [data-back-choice]').click();await expect(page.locator('#path-entry')).toBeVisible();await page.locator('[data-start="finance"]').click();await expect(page.locator('#finance-contact')).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.locator('#finance-submit').click();expect(saved).toBeUndefined();
  await page.locator('#finance-name').fill('Finance Test');await page.locator('#finance-phone').fill('2025550123');await page.locator('#finance-consent').check();
  await page.locator('#finance-submit').click();await expect(page.locator('#finance-result')).toBeVisible();
  expect(saved.contact).toEqual({name:'Finance Test',phone:'+12025550123',consent:true});expect(saved.language).toBe(lang);expect(model.valid(saved.answers)).toBe(true);
  await expect(page.locator('#finance-application')).toHaveAttribute('href','/finance?lang='+lang);await expect(page.locator('#finance-application')).toHaveAttribute('target','_top');
  expect(decodeURIComponent((await page.locator('#finance-whatsapp').getAttribute('href')).split('?text=')[1])).toBe(model.message(saved.answers,lang,'FNA23'));expect(errors).toEqual([]);
});
test('failed save keeps contact and answers, blocks the partner and retries with the same key',async({page})=>{
  await routes(page);let calls=0,ids=[];await page.route('**/api/finance-request',route=>{calls++;ids.push(route.request().postDataJSON().requestId);return route.fulfill({status:calls===1?503:200,json:calls===1?{error:'FINANCE_UNAVAILABLE'}:{ok:true,ref:'FNA23'}});});
  await page.goto(base+'/msc-calculadora.html?start=finance');await fill(page);await page.locator('#finance-name').fill('Finance Test');await page.locator('#finance-phone').fill('2025550123');await page.locator('#finance-consent').check();
  await page.locator('#finance-submit').click();await expect(page.locator('#finance-save-error')).toBeVisible();await expect(page.locator('#finance-application')).toBeHidden();await expect(page.locator('#finance-name')).toHaveValue('Finance Test');
  await page.locator('#finance-submit').click();await expect(page.locator('#finance-result')).toBeVisible();expect(ids[0]).toBe(ids[1]);expect(calls).toBe(2);
});
test('landing accepts listing inline in all languages and preserves existing financing values',async({page})=>{
  await routes(page);let reads=0;await page.route('**/api/listing-reference?**',route=>{reads++;return route.fulfill({json:{vehicle:{make:'BMW',model:'X3',year:2021,trim:'xDrive30i'}}});});await page.goto(base+'/');
  const form=page.locator('[data-mcs-listing-reference]');await expect(form.locator('input')).toBeVisible();expect(await form.getByText('Close',{exact:true}).count()).toBe(0);
  for(const [lang,heading,placeholder]of [['en','Found a car you want?','Paste listing link'],['es','¿Encontraste un auto que quieres?','Pega el enlace del anuncio'],['pt','Encontrou um carro que você quer?','Cole o link do anúncio']]){await page.locator('#btn-lang').click();await page.locator('#sheet-lang [data-set-lang="'+lang+'"]').click();await expect(form.locator('label')).toHaveText(heading);await expect(form.locator('input')).toHaveAttribute('placeholder',placeholder);await expect(form.locator('#criteria-reference-help')).toHaveText({en:"We use your listing as a reference to search dealer auctions for a similar car",es:'Usamos el anuncio como referencia para buscar un auto similar en subastas',pt:'Usamos o anúncio como referência para buscar um carro semelhante nos leilões'}[lang]);}
  await form.locator('input').fill('https://example.com/download.exe');await form.locator('button').click();await expect(page.locator('#criteria-reference-status')).toContainText('válido');expect(reads).toBe(0);
  await form.locator('input').fill('https://example.com/car?original=1');await form.locator('button').click();const frame=page.frameLocator('iframe.calc-frame');await expect(frame.locator('#path-reference')).toBeVisible();await expect(frame.locator('.listing-reference-car')).toContainText('BMW X3');expect(reads).toBe(1);await expect(frame.locator('#listing-reference-toggle')).toHaveCount(0);
  await page.locator('#fin-down').fill('5000');await page.locator('#fin-month').fill('600');const href=decodeURIComponent(await page.locator('#fin-send').getAttribute('href'));expect(href).toContain('$5,000');expect(href).toContain('$600');
});
test('320px and desktop finance keep two columns and no horizontal overflow',async({page})=>{
  await routes(page);for(const width of [320,1440]){await page.setViewportSize({width,height:900});await page.goto(base+'/msc-calculadora.html?start=finance');await page.locator('#path-finance [data-lang="es"]').click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const chips=page.locator('.finance-chips').first();expect((await chips.evaluate(el=>getComputedStyle(el).gridTemplateColumns)).split(' ').length).toBe(2);await expect(chips.locator('.finance-chip--wide')).toHaveCount(1);}
});
for(const [lang,title]of [['en','Finance your next car'],['es','Financia tu próximo auto'],['pt','Financie seu próximo carro']])test('partner bridge '+lang+' redirects at three seconds and Back returns to MCS',async({page})=>{
  await routes(page);const partner='https://www.mymetawholesalecars.com/apply-online/';await page.route('**/api/finance-handoff',route=>route.fulfill({json:{authorized:true,destination:partner,handedOffAt:"2026-10-24T13:00:00Z"}}));
  await page.route(partner,route=>route.fulfill({contentType:'text/html',body:'<h1>Partner application test</h1>'}));
  await page.clock.install();await page.goto(base+'/msc-calculadora.html');await page.goto(base+'/finance/index.html?lang='+lang);
  await expect(page.locator('#finance-title')).toHaveText(title);await expect(page.locator('.finance-copy')).toContainText('Meta Wholesale Cars');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.clock.fastForward(2999);expect(page.url()).toContain('/finance/index.html');
  await page.clock.fastForward(1);await expect(page).toHaveURL(partner);
  await page.goBack();await expect(page).toHaveURL(base+'/msc-calculadora.html');
});
test('partner bridge button opens in the same tab without waiting',async({page})=>{
  await routes(page);const partner='https://www.mymetawholesalecars.com/apply-online/';await page.route('**/api/finance-handoff',route=>route.fulfill({json:{authorized:true,destination:partner,handedOffAt:"2026-10-24T13:00:00Z"}}));await page.route(partner,route=>route.fulfill({body:'Partner application test'}));
  await page.clock.install();await page.goto(base+'/msc-calculadora.html');await page.goto(base+'/finance/index.html');await expect(page.locator('#finance-continue')).toHaveAttribute('href',partner);await page.locator('#finance-continue').click();await expect(page).toHaveURL(partner);expect(page.context().pages()).toHaveLength(1);await page.goBack();await expect(page).toHaveURL(base+'/msc-calculadora.html');
});
test('partner departure records only at navigation, retries failed saves and prevents double clicks',async({page})=>{
  await routes(page);const partner='https://www.mymetawholesalecars.com/apply-online/';let posts=0,method;
  await page.route('**/api/finance-handoff',route=>{
    if(route.request().method()==='GET')return route.fulfill({json:{authorized:true,destination:partner}});
    posts++;method=route.request().postDataJSON().method;
    return route.fulfill({status:posts===1?503:200,json:posts===1?{error:'FINANCE_UNAVAILABLE'}:{authorized:true,destination:partner,handedOffAt:'2026-10-24T13:00:00Z'}});
  });
  await page.route(partner,route=>route.fulfill({body:'Partner application test'}));await page.clock.install();await page.goto(base+'/msc-calculadora.html');await page.goto(base+'/finance/index.html?lang=pt');
  await expect(page.locator('#finance-continue')).toHaveAttribute('href',partner);expect(posts).toBe(0);
  await page.clock.fastForward(3000);await expect(page.locator('#finance-retry')).toBeVisible();expect(posts).toBe(1);expect(method).toBe('automatic');expect(page.url()).toContain('/finance/index.html');
  await expect(page.locator('.finance-copy')).toHaveText('Não conseguimos continuar para o pedido Tente novamente');
  await page.locator('#finance-continue').dblclick();await expect(page).toHaveURL(partner);expect(posts).toBe(2);expect(method).toBe('manual');
  await page.goBack();await expect(page).toHaveURL(base+'/msc-calculadora.html');
});
for(const lang of ['en','pt','es'])test('direct finance entry '+lang+' cannot bypass contact capture with a plain Ref',async({page})=>{
  await routes(page);let partnerRequests=0;
  await page.route('https://www.mymetawholesalecars.com/**',route=>{partnerRequests++;return route.abort();});
  await page.route('**/api/finance-handoff',route=>route.fulfill({json:{authorized:false}}));
  await page.clock.install();await page.goto(base+'/finance/index.html?lang='+lang+'&ref=FNA23');
  await expect(page.locator('#finance-continue')).toHaveAttribute('href','/msc-calculadora.html?start=finance&lang='+lang);
  await page.clock.fastForward(12000);expect(page.url()).toContain('/finance/index.html');expect(partnerRequests).toBe(0);
  await page.locator('#finance-continue').click();await expect(page.locator('#path-finance')).toBeVisible();
});
test('failed bridge verification offers retry and never redirects before it succeeds',async({page})=>{
  await routes(page);let calls=0;const partner='https://www.mymetawholesalecars.com/apply-online/';
  await page.route('**/api/finance-handoff',route=>{calls++;return route.fulfill({status:calls===1?503:200,json:calls===1?{error:'FINANCE_UNAVAILABLE'}:{authorized:true,destination:partner,handedOffAt:"2026-10-24T13:00:00Z"}});});
  await page.clock.install();await page.goto(base+'/finance/index.html?lang=pt');await expect(page.locator('#finance-retry')).toBeVisible();
  await page.clock.fastForward(12000);expect(page.url()).toContain('/finance/index.html');await expect(page.locator('#finance-continue')).toContainText('Iniciar');
  await page.locator('#finance-retry').click();await expect(page.locator('#finance-continue')).toHaveAttribute('href',partner);await expect(page.locator('#finance-continue')).toHaveText('Continuar para o pedido');
});

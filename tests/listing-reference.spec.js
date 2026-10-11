'use strict';
const {test,expect}=require('@playwright/test');
const base='http://127.0.0.1:4173';
test.use({viewport:{width:390,height:900},launchOptions:{executablePath:process.env.CHROMIUM_PATH||undefined}});
async function open(page, payload={vehicle:{make:'BMW',model:'X3',year:2021,trim:'xDrive30i'}}, status=200) {
  let reads=0;const outgoing=[];
  await page.route('**/*',route=>{
    const url=route.request().url();
    if(url.includes('/api/listing-reference?')){reads++;return route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});}
    if(url.startsWith(base))return route.continue();
    outgoing.push(url);return route.abort();
  });
  await page.goto(base+'/msc-calculadora.html');
  return {reads:()=>reads,outgoing};
}
async function use(page,url='https://example.com/car?original=1'){
 await page.locator('#listing-reference-toggle').click();await page.fill('#listing-reference-url',url);await page.locator('#listing-reference-box .listing-reference-use').click();await expect(page.locator('#path-reference')).toBeVisible();
}
test('existing calculator and Find stay direct with zero listing reads',async({page})=>{
 const state=await open(page);await page.locator('[data-start="calculate"]').click();await expect(page.locator('#path-a')).toBeVisible();await page.locator('#path-a [data-back-choice]').click();await page.locator('[data-start="find"]').click();await expect(page.locator('#path-b')).toBeVisible();expect(state.reads()).toBe(0);
});
test('short screen sends identity and full original link without manual fields',async({page})=>{
 const state=await open(page);await page.evaluate(()=>document.getElementById('lance').value='26771');await use(page);
 await expect(page.locator('#path-b')).toBeHidden();await expect(page.locator('.listing-reference-car')).toContainText('BMW X3');
 expect(await page.locator('#path-reference input').count()).toBe(0);
 for(const id of ['reference-wa','reference-sms']) { const href=decodeURIComponent(await page.locator('#'+id).getAttribute('href'));expect(href).toContain('2021 BMW X3 xDrive30i');expect(href).toContain('https://example.com/car?original=1'); }
 expect(state.reads()).toBe(1);await expect(page.locator('#lance')).toHaveValue('26771');
 await page.locator('.listing-reference-back').click();await page.locator('[data-start="find"]').click();await expect(page.locator('#find-marca')).toHaveValue('');
});
test('unreadable listing still sends link with no invented identity',async({page})=>{
 await open(page,{error:'LISTING_UNAVAILABLE'},503);await use(page);await expect(page.locator('.listing-reference-car')).toBeHidden();expect(decodeURIComponent(await page.locator('#reference-wa').getAttribute('href'))).toContain('https://example.com/car?original=1');
});
test('Find draft survives reference and languages translate the short screen',async({page})=>{
 await open(page);await page.locator('[data-start="find"]').click();await page.selectOption('#find-marca','Tesla');await page.selectOption('#find-modelo','Model 3');await page.fill('#find-zip','33101');await page.locator('#path-b [data-back-choice]').click();await use(page);
 await page.locator('#path-reference [data-lang="pt"]').click();await expect(page.locator('#path-reference h1')).toHaveText('Envie este carro para nós');expect(decodeURIComponent(await page.locator('#reference-wa').getAttribute('href'))).toContain('Tenho interesse');
 await page.locator('#path-reference [data-lang="es"]').click();await expect(page.locator('#path-reference h1')).toHaveText('Envíanos este auto');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(0);
 await page.locator('.listing-reference-back').click();await page.locator('[data-start="find"]').click();await expect(page.locator('#find-marca')).toHaveValue('Tesla');await expect(page.locator('#find-modelo')).toHaveValue('Model 3');await expect(page.locator('#find-zip')).toHaveValue('33101');
});
test('executable URL blocked before read and close escapes',async({page})=>{
 const state=await open(page);await page.locator('#listing-reference-toggle').click();await page.fill('#listing-reference-url','https://example.com/download.exe');await page.locator('#listing-reference-box .listing-reference-use').click();await expect(page.locator('.listing-reference-status')).toContainText('valid');expect(state.reads()).toBe(0);await page.keyboard.press('Escape');await expect(page.locator('#listing-reference-box')).toBeHidden();
});
test('navigation while reading cannot reopen the short screen',async({page})=>{
 await open(page);await page.route('**/api/listing-reference?**',async route=>{await new Promise(r=>setTimeout(r,200));await route.fulfill({json:{vehicle:{make:'BMW',model:'X3'}}}).catch(()=>{});});
 await page.locator('#listing-reference-toggle').click();await page.fill('#listing-reference-url','https://example.com/car');await page.locator('#listing-reference-box .listing-reference-use').click();await page.locator('[data-start="calculate"]').click();await page.waitForTimeout(350);await expect(page.locator('#path-a')).toBeVisible();await expect(page.locator('#path-reference')).toBeHidden();
});
for(const name of ['porsche','lincoln'])test(name+' actual fixture shows exact identity',async({page})=>{
 const server=require('../listing-reference-server');const fixture=require('./fixtures/'+name+'-listing.json');const vehicle=name==='porsche'?server.parseListing('<script type="application/ld+json">'+JSON.stringify(fixture)+'</script>'):server.parseVehicleRecord(fixture,fixture.vin,{dealer:'11373'});
 await open(page,{vehicle});await use(page);await expect(page.locator('.listing-reference-car h2')).toHaveText(vehicle.make+' '+vehicle.model);await expect(page.locator('.listing-reference-car p')).toHaveText(vehicle.year+' · '+vehicle.trim);
});

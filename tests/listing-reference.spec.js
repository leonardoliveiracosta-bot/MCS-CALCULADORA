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
async function use(page){await page.locator('#listing-reference-toggle').click();await page.fill('#listing-reference-url','https://example.com/2021-bmw-x3');await page.locator('.listing-reference-use').click();await expect(page.locator('#path-b')).toBeVisible();}
async function remaining(page){
  await page.fill('#find-miles-from','1000');await page.fill('#find-miles-to','60000');await page.fill('#find-zip','33101');
  await page.check('input[name="find-prazo"][value="30d"]');await page.check('input[name="find-exp"][value="1st"]');
}
test('normal calculator/find paths unchanged and zero listing reads before use',async({page})=>{
  const state=await open(page);await expect(page.locator('#listing-reference-box')).toBeHidden();
  await page.locator('[data-start="calculate"]').click();await expect(page.locator('#path-a')).toBeVisible();
  await page.locator('#path-a [data-back-choice]').click();await page.locator('[data-start="find"]').click();
  await expect(page.locator('#path-b')).toBeVisible();await expect(page.locator('#listing-reference-attached')).toBeHidden();
  expect(state.reads()).toBe(0);await expect(page.locator('#find-marca')).toHaveValue('');
});
test('one read fills identity only, preserves exact calculator amount and sends source through both existing links',async({page})=>{
  const state=await open(page);
  await page.evaluate(()=>document.getElementById('lance').value='26771');
  await use(page);expect(state.reads()).toBe(1);
  await expect(page.locator('#find-marca')).toHaveValue('BMW');await expect(page.locator('#find-modelo')).toHaveValue('X3');
  await expect(page.locator('#find-year-from')).toHaveValue('2021');await expect(page.locator('#find-year-to')).toHaveValue('2021');
  await expect(page.locator('#find-miles-from')).toHaveValue('');await expect(page.locator('#lance')).toHaveValue('26771');
  await remaining(page);
  const wa=decodeURIComponent(await page.locator('#find-wa').getAttribute('href'));
  const sms=decodeURIComponent(await page.locator('#find-sms').getAttribute('href'));
  expect(wa).toContain('BMW X3');expect(wa).toContain('Reference listing: https://example.com/2021-bmw-x3');expect(sms).toContain('Reference listing: https://example.com/2021-bmw-x3');
  await page.locator('.listing-reference-remove').click();expect(decodeURIComponent(await page.locator('#find-wa').getAttribute('href'))).not.toContain('example.com');
  expect(state.outgoing.filter(url=>url.includes('example.com'))).toHaveLength(0);
});
test('existing vehicle/year/mileage/trim/ZIP survive using another reference',async({page})=>{
  await open(page);await page.locator('[data-start="find"]').click();
  await page.selectOption('#find-marca','Tesla');await page.selectOption('#find-modelo','Model 3');await page.selectOption('#find-year-from','2020');await page.selectOption('#find-year-to','2024');await page.fill('#find-trim','Long Range');await page.fill('#find-miles-to','50000');await page.fill('#find-zip','33101');
  await page.locator('#path-b [data-back-choice]').click();await use(page);
  await expect(page.locator('#find-marca')).toHaveValue('Tesla');await expect(page.locator('#find-modelo')).toHaveValue('Model 3');await expect(page.locator('#find-year-from')).toHaveValue('2020');await expect(page.locator('#find-trim')).toHaveValue('Long Range');await expect(page.locator('#find-miles-to')).toHaveValue('50,000');await expect(page.locator('#find-zip')).toHaveValue('33101');
});
test('unreadable listing is explicitly reported and source remains attached',async({page})=>{
  await open(page,{error:'LISTING_UNAVAILABLE'},503);await use(page);
  await expect(page.locator('#listing-reference-attached')).toContainText('We could not read this listing');await expect(page.locator('#find-marca')).toHaveValue('');
  await page.selectOption('#find-marca','BMW');await page.selectOption('#find-modelo','X3');await page.selectOption('#find-year-from','2021');await page.selectOption('#find-year-to','2022');await remaining(page);
  expect(decodeURIComponent(await page.locator('#find-wa').getAttribute('href'))).toContain('example.com/2021-bmw-x3');
});
test('close/back escape and language switch work without adding steps to main buttons',async({page})=>{
  const state=await open(page);await page.locator('#path-entry [data-lang="pt"]').click();
  await expect(page.locator('#listing-reference-toggle')).toHaveText('Já encontrou um carro? Cole o anúncio');
  await page.locator('#listing-reference-toggle').click();await page.keyboard.press('Escape');await expect(page.locator('#listing-reference-box')).toBeHidden();
  await page.locator('#listing-reference-toggle').click();await page.locator('.listing-reference-close').click();await expect(page.locator('#listing-reference-box')).toBeHidden();
  expect(state.reads()).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(0);
});
test('leaving while reading never reopens the form or changes the other path',async({page})=>{
  await open(page);
  await page.route('**/api/listing-reference?**',async route=>{
    await new Promise(resolve=>setTimeout(resolve,200));
    await route.fulfill({contentType:'application/json',body:JSON.stringify({vehicle:{make:'BMW',model:'X3',year:2021}})}).catch(()=>{});
  });
  await page.locator('#listing-reference-toggle').click();await page.fill('#listing-reference-url','https://example.com/car');await page.locator('.listing-reference-use').click();
  await page.locator('[data-start="calculate"]').click();await expect(page.locator('#path-a')).toBeVisible();
  await expect(page.locator('#path-b')).toBeHidden();await page.waitForTimeout(350);await expect(page.locator('#path-a')).toBeVisible();
  await expect(page.locator('#listing-reference-attached')).toBeHidden();
});

test('Porsche reference fills year and version without treating asking price or electric range as criteria',async({page})=>{
  const {parseListing}=require('../listing-reference-server');
  const fixture=require('./fixtures/porsche-listing.json');
  const vehicle=parseListing('<script type="application/ld+json">'+JSON.stringify(fixture)+'</script>');
  const state=await open(page,{vehicle});
  await page.locator('#listing-reference-toggle').click();
  await page.fill('#listing-reference-url','https://finder.porsche.com/us/en-US/details/246805?store=4500940');
  await page.locator('.listing-reference-use').click();
  await expect(page.locator('#find-marca')).toHaveValue('Porsche');
  await expect(page.locator('#find-modelo')).toHaveValue('Macan');
  await expect(page.locator('#find-year-from')).toHaveValue('2026');
  await expect(page.locator('#find-year-to')).toHaveValue('2026');
  await expect(page.locator('#find-trim')).toHaveValue('Turbo Electric');
  await expect(page.locator('#find-miles-from')).toHaveValue('');
  await expect(page.locator('#find-miles-to')).toHaveValue('');
  expect(state.reads()).toBe(1);
});

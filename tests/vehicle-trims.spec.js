'use strict';
const {test,expect}=require('@playwright/test');const base='http://127.0.0.1:4173';
test.use({viewport:{width:390,height:844}});
async function open(page,{fail=false,hold=false}={}) {
  const requests=[];let release;const gate=new Promise(resolve=>release=resolve);
  await page.route('**/*',async route=>{
    const u=route.request().url();
    if(u.includes('/vehicle-trims.json')){requests.push(u);if(hold)await gate;if(fail)return route.fulfill({status:503,body:'{}'});}
    if(u.startsWith(base))return route.continue();return route.abort();
  });
  await page.goto(base+'/msc-calculadora.html');return {requests,release};
}
async function car(page,make='Toyota',model='Camry',from='2020',to='2020') {
  await page.selectOption('#find-marca',make);await page.selectOption('#find-modelo',model);await page.selectOption('#find-year-from',from);await page.selectOption('#find-year-to',to);
}
test('loads only on complete preference; offers scoped versions without altering drafts',async({page})=>{
  const state=await open(page);expect(state.requests).toHaveLength(0);await page.locator('[data-start=find]').click();
  await page.fill('#find-trim','My preference');await car(page);await expect(page.locator('#find-trim')).toHaveAttribute('list','find-trim-options');
  const labels=await page.locator('#find-trim-options option').evaluateAll(nodes=>nodes.map(n=>n.value));expect(labels).toContain('SE');expect(labels).not.toContain('xDrive30i');
  await expect(page.locator('#find-trim')).toHaveValue('My preference');await expect(page.locator('#find-trim')).toBeEditable();await expect(page.locator('#find-miles-to')).toHaveValue('');
  await page.fill('#find-trim','SE');await page.fill('#find-miles-from','1000');await page.fill('#find-miles-to','60000');await page.fill('#find-zip','33101');await page.check('input[name=find-prazo][value="30d"]');await page.check('input[name=find-exp][value="1st"]');
  expect(decodeURIComponent(await page.locator('#find-wa').getAttribute('href'))).toContain('Trim: SE');expect(decodeURIComponent(await page.locator('#find-sms').getAttribute('href'))).toContain('Trim: SE');
  await car(page,'BMW','X3','2021','2021');await expect(page.locator('#find-trim-options option[value="xDrive30i"]')).toHaveCount(1);await expect(page.locator('#find-trim-options option[value=SE]')).toHaveCount(0);await expect(page.locator('#find-trim')).toHaveValue('SE');expect(state.requests).toHaveLength(1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(0);
});
test('requires a trim response and accepts the first non-specific choice in every language without sending',async({page})=>{
  const state=await open(page);await page.locator('[data-start=find]').click();await car(page);
  await page.fill('#find-miles-from','1000');await page.fill('#find-miles-to','60000');await page.fill('#find-zip','33101');await page.check('input[name=find-prazo][value="30d"]');await page.check('input[name=find-exp][value="1st"]');
  await expect(page.locator('#find-wa')).toHaveAttribute('aria-disabled','true');await expect(page.locator('#find-sms')).toHaveAttribute('href','#');
  await page.locator('#find-wa').click({force:true});await expect(page.locator('#find-err-trim')).toBeVisible();
  expect(await page.locator('#find-trim-unsure').evaluate(node=>Boolean(node.compareDocumentPosition(document.getElementById('find-trim'))&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await page.check('#find-trim-unsure');await expect(page.locator('#find-err-trim')).toBeHidden();await expect(page.locator('#find-trim')).toBeDisabled();
  for(const [lang,text] of [['en','No specific trim'],['pt','Sem versão específica'],['es','Sin versión específica']]){
    await page.locator('#path-b [data-lang='+lang+']').click();await expect(page.locator('#find-wa')).not.toHaveAttribute('aria-disabled','true');
    for(const id of ['#find-wa','#find-sms'])expect(decodeURIComponent(await page.locator(id).getAttribute('href'))).toContain(text);
  }
  await page.uncheck('#find-trim-unsure');await expect(page.locator('#find-wa')).toHaveAttribute('href','#');await expect(page.locator('#find-err-trim')).toBeVisible();
  await page.fill('#find-trim','   ');await expect(page.locator('#find-sms')).toHaveAttribute('href','#');
  await page.fill('#find-trim','SE');await expect(page.locator('#find-wa')).not.toHaveAttribute('aria-disabled','true');await expect(page.locator('#find-err-trim')).toBeHidden();
  await page.fill('#find-trim','');await expect(page.locator('#find-wa')).toHaveAttribute('href','#');
  await car(page,'Saab','9-3','2020','2020');await page.fill('#find-trim','Aero');await expect(page.locator('#find-wa')).not.toHaveAttribute('aria-disabled','true');
  expect(state.requests).toHaveLength(1);
});
test('unsure, missing coverage, manual text and language switches keep the existing behavior',async({page})=>{
  await open(page);await page.locator('[data-start=find]').click();await car(page);await expect(page.locator('#find-trim')).toHaveAttribute('list','find-trim-options');
  await page.fill('#find-trim','SE');await page.check('#find-trim-unsure');await expect(page.locator('#find-trim')).toBeDisabled();await expect(page.locator('#find-trim')).toHaveValue('');await expect(page.locator('#find-trim-options option')).toHaveCount(0);
  await page.uncheck('#find-trim-unsure');await car(page,'Saab','9-3','2020','2020');await expect(page.locator('#find-trim-options option')).toHaveCount(0);await page.fill('#find-trim','Aero');await expect(page.locator('#find-trim')).toHaveValue('Aero');
  await page.locator('#path-b [data-back-choice]').click();await page.locator('#path-entry [data-lang=pt]').click();await page.locator('[data-start=find]').click();await expect(page.locator('#find-trim')).toHaveValue('Aero');await expect(page.locator('#path-b')).toContainText('Sem versão específica');
});
test('catalog failure is visible and does not block manual preference or calculator',async({page})=>{
  await open(page,{fail:true});await page.locator('[data-start=find]').click();await car(page);await expect(page.locator('.vehicle-trims-state')).toContainText('Could not load versions');await page.fill('#find-trim','SE');await expect(page.locator('#find-trim')).toHaveValue('SE');await page.locator('#path-b [data-back-choice]').click();await page.locator('[data-start=calculate]').click();await expect(page.locator('#path-a')).toBeVisible();
});
test('a delayed response cannot attach versions to another model or to an unchecked range',async({page})=>{
  const state=await open(page,{hold:true});await page.locator('[data-start=find]').click();await car(page);await car(page,'BMW','X3','2021','2021');state.release();await expect(page.locator('#find-trim-options option[value="xDrive30i"]')).toHaveCount(1);await expect(page.locator('#find-trim-options option[value=SE]')).toHaveCount(0);await page.selectOption('#find-year-from','2022');await expect(page.locator('#find-trim-options option')).toHaveCount(0);
});

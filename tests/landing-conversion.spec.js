'use strict';
const {test,expect}=require('@playwright/test');
const base='http://127.0.0.1:4173';
const copy={
  en:{search:'START MY SEARCH',chat:'TALK TO US ON WHATSAPP',benefit:'So we can search for cars that fit you',finance:"LET'S TALK FINANCING",down:'DOWN PAYMENT',month:'PREFERRED MONTHLY PAYMENT',intro:"Hi! I'd like to talk about financing a car with you"},
  es:{search:'INICIAR MI BÚSQUEDA',chat:'HABLA CON NOSOTROS POR WHATSAPP',benefit:'Para buscar opciones que encajen contigo',finance:'HABLEMOS DE FINANCIAMIENTO',down:'ENGANCHE',month:'PAGO MENSUAL DESEADO',intro:'Hola, quiero hablar sobre financiar un auto con ustedes'},
  pt:{search:'COMEÇAR MINHA BUSCA',chat:'CONVERSE COM A GENTE NO WHATSAPP',benefit:'Para buscarmos opções que combinem com você',finance:'VAMOS FALAR DE FINANCIAMENTO',down:'ENTRADA',month:'PARCELA DESEJADA',intro:'Olá! Quero conversar sobre financiar um carro com vocês'}
};
async function isolate(page){
  const writes=[];
  await page.route('**/*',route=>{
    const req=route.request();if(req.method()!=='GET')writes.push(req.url());
    return req.url().startsWith(base)&&req.method()==='GET'?route.continue():route.abort();
  });
  return writes;
}
async function language(page,lang){await page.locator('#btn-lang').click();await page.locator('#sheet-lang [data-set-lang="'+lang+'"]').click();await expect(page.locator('html')).toHaveAttribute('lang',lang);}
async function destination(page){
  await expect.poll(()=>page.locator('#calculadora-widget').evaluate(el=>{const top=el.getBoundingClientRect().top;return top>=0&&top<160;})).toBe(true);
  await expect(page.frameLocator('iframe.calc-frame').locator('html')).toHaveAttribute('lang',await page.locator('html').getAttribute('lang'));
}
async function clickCalculator(page,selector){
  const frame=page.frameLocator('iframe.calc-frame');
  const zoom=await page.locator('html').evaluate(el=>Number(getComputedStyle(el).zoom)||1);
  if(zoom===1)return frame.locator(selector).click();
  // Playwright 1.55 does not scale iframe hit coordinates with the site's desktop CSS zoom.
  // Use a real mouse click at the measured, scaled DOM position; do not force or dispatch a click.
  await page.locator('#calculadora-widget').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
  const measure=()=>page.locator('iframe.calc-frame').evaluate((el,selector)=>{
    const f=el.getBoundingClientRect(),r=el.contentDocument.querySelector(selector).getBoundingClientRect(),scale=f.width/el.clientWidth;
    return {x:f.left+(r.left+r.width/2)*scale,y:f.top+(r.top+r.height/2)*scale};
  },selector);
  let point=await measure();
  if(point.y>=860){await page.mouse.wheel(0,point.y-450);await expect.poll(async()=>{point=await measure();return point.y<860;}).toBe(true);}
  expect(point.y).toBeGreaterThan(90);expect(point.y).toBeLessThan(900);await page.mouse.click(point.x,point.y);
}
for(const width of [320,390,430,1440])for(const lang of ['en','es','pt'])test('search, contact and mobile layout '+width+' '+lang,async({page,context})=>{
  await page.setViewportSize({width,height:900});const writes=await isolate(page),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');await language(page,lang);const c=copy[lang];
  const final=page.locator('#comecar .ready-btn'),chat=page.locator('#comecar .ready-whatsapp');
  await expect(final).toHaveText(c.search);await expect(final).toHaveAttribute('href','#calculadora-widget');await expect(final).not.toHaveAttribute('target','_blank');
  await expect(page.locator('#comecar .ready-text')).toContainText(c.benefit);await expect(chat).toHaveText(c.chat);await expect(chat).toHaveAttribute('href','https://wa.me/13055400742');
  // Generic entrances point to the choices; each home choice opens its form in one tap.
  await expect(page.locator('#calculadora-widget')).toBeHidden();
  await expect(page.locator('iframe.calc-frame')).not.toHaveAttribute('src',/.+/);
  await expect(page.locator('.calc-stage')).toHaveCount(0);
  await expect(page.locator('.sold-launcher')).toBeHidden();
  for(const entry of ['.sticky-cta','#comecar .ready-btn'])await expect(page.locator(entry)).toHaveAttribute('href','#calculadora-widget');
  for(const path of ['calculate','find','finance']) {
    const button=page.locator('[data-home-start="'+path+'"]');
    await expect(button).toHaveAttribute('href','/msc-calculadora.html?start='+path);
    const box=await button.boundingBox();expect(box.y+box.height).toBeLessThan(900);
  }
  await page.locator('#btn-menu').click();await page.locator('#sheet-menu [data-i18n="m_start"]').click();await expect(page.locator('#sheet-menu')).toBeHidden();
  await expect(page.locator('#calculadora-widget')).toBeHidden();
  await final.click();await expect(page.locator('#calculadora-widget')).toBeHidden();
  const frame=page.frameLocator('iframe.calc-frame');
  for(const [path,id] of [['find','path-b'],['calculate','path-a'],['finance','path-finance']]){
    await page.locator('[data-home-start="'+path+'"]').click();await expect(frame.locator('#'+id)).toBeVisible();await destination(page);
    await expect(frame.locator('#path-entry')).toBeHidden();expect(context.pages()).toHaveLength(1);
    await expect(page.locator('.sticky-bar')).toBeHidden();
    await clickCalculator(page,'#'+id+' [data-back-choice]');await expect(page.locator('#calculadora-widget')).toBeHidden();
  }
  // Keep the independent human contact paths and callback form accessible.
  for(const selector of ['.wa-float','footer a[href="https://wa.me/13055400742"]','#sheet-fone a[href="https://wa.me/13055400742"]'])await expect(page.locator(selector)).toHaveAttribute('href','https://wa.me/13055400742');
  await expect(page.locator('#sheet-fone a[href="sms:+13055400742"]')).toHaveCount(1);
  await page.locator('[data-mcs-contact-request="footer"]').click();await expect(page.locator('.mcs-contact-dialog')).toBeVisible();await page.locator('.mcs-contact-close').click();
  for(const action of [final,chat,page.locator('[data-mcs-contact-request="footer"]')]){
    await expect(action).toBeVisible();const r=await action.boundingBox();expect(r.height).toBeGreaterThanOrEqual(44);expect(r.x).toBeGreaterThanOrEqual(0);expect(r.x+r.width).toBeLessThanOrEqual(width);
    // Text fits the content area before the arrow, including at 320px in PT/ES.
    expect(await action.evaluate(el=>{const range=document.createRange();range.selectNodeContents(el);const style=getComputedStyle(el),r=el.getBoundingClientRect();return [...range.getClientRects()].every(t=>t.right<=r.right-parseFloat(style.paddingRight)+1);})).toBe(true);
  }
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(writes).toEqual([]);expect(errors).toEqual([]);
  if(process.env.LANDING_SHOTS)await page.locator('#comecar').screenshot({path:require('node:path').join(process.env.LANDING_SHOTS,'ready-'+width+'-'+lang+'.png')});
});
for(const lang of ['en','es','pt'])test('financing stays direct, localized and preserves partial answers '+lang,async({page})=>{
  const writes=await isolate(page);await page.setViewportSize({width:320,height:900});await page.goto(base+'/');await language(page,lang);
  const link=page.locator('#fin-send'),c=copy[lang],message=async()=>new URL(await link.getAttribute('href')).searchParams.get('text');
  await expect(link).toHaveText(c.finance);await expect(page.locator('label[for="fin-down"]')).toHaveText(c.down);await expect(page.locator('label[for="fin-month"]')).toHaveText(c.month);expect(await message()).toBe(c.intro);
  await page.locator('#fin-down').fill('5000');expect(await message()).toContain('$5,000');expect(await message()).not.toContain('$600');
  await page.locator('#fin-down').fill('');await page.locator('#fin-month').fill('600');expect(await message()).toContain('$600');expect(await message()).not.toContain('$5,000');
  await page.locator('#fin-down').fill('5000');expect(await message()).toContain('$5,000');expect(await message()).toContain('$600');expect(await message()).toContain(c.intro);
  for(const other of ['en','es','pt']){await language(page,other);await expect.poll(message).toContain(copy[other].intro);await expect(page.locator('#fin-down')).toHaveValue('5,000');await expect(page.locator('#fin-month')).toHaveValue('600');expect(await message()).toContain('$5,000');expect(await message()).toContain('$600');}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(writes).toEqual([]);
});
test('returning from the final CTA preserves an unfinished vehicle search and listing reference',async({page})=>{
  await isolate(page);await page.goto(base+'/');const frame=page.frameLocator('iframe.calc-frame');
  await page.locator('[data-home-start="find"]').click();await frame.locator('#find-marca').selectOption('BMW');await frame.locator('#find-modelo').selectOption('X5');await frame.locator('#find-trim').fill('M Sport');
  await page.locator('#comecar .ready-btn').click();await destination(page);await expect(frame.locator('#path-b')).toBeVisible();await expect(frame.locator('#find-modelo')).toHaveValue('X5');await expect(frame.locator('#find-trim')).toHaveValue('M Sport');
  await page.route('**/api/listing-reference?**',r=>r.fulfill({json:{vehicle:{make:'BMW',model:'X3',year:2021,trim:'xDrive30i'}}}));
  await page.locator('#criteria-reference-url').fill('https://example.com/car');await page.locator('[data-mcs-listing-reference] button').click();await expect(frame.locator('#path-reference')).toBeVisible();
  await page.locator('#comecar .ready-btn').click();await destination(page);await expect(frame.locator('#path-reference')).toBeVisible();await expect(frame.locator('.listing-reference-car')).toContainText('BMW X3');
});
test('the final search link works without JavaScript',async({browser})=>{
  const context=await browser.newContext({javaScriptEnabled:false,viewport:{width:390,height:844}}),page=await context.newPage();await isolate(page);await page.goto(base+'/');await page.locator('#comecar .ready-btn').click();await expect(page).toHaveURL(base+'/#calculadora-widget');await expect(page.locator('#comecar .ready-whatsapp')).toHaveAttribute('href','https://wa.me/13055400742');await context.close();
});
for(const lang of ['en','es','pt'])test('touch visitor can open human WhatsApp directly without submitting a search '+lang,async({browser})=>{
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true}),page=await context.newPage();
  const writes=await isolate(page);await context.route('https://wa.me/**',r=>r.fulfill({contentType:'text/html',body:'<title>Intercepted WhatsApp link, no message sent</title>'}));
  await page.goto(base+'/');await language(page,lang);const popupPending=page.waitForEvent('popup');await page.locator('#comecar .ready-whatsapp').tap();const popup=await popupPending;await popup.waitForLoadState();expect(popup.url()).toBe('https://wa.me/13055400742');
  expect(writes).toEqual([]);await context.close();
});

for(const [start,id] of [['calculate','path-a'],['find','path-b'],['finance','path-finance']])test('cold home tap opens '+start+' without showing another choice screen',async({page})=>{
  await page.setViewportSize({width:390,height:844});await isolate(page);
  let release;const pending=new Promise(resolve=>{release=resolve;});
  await page.route('**/msc-calculadora.html?**',async route=>{await pending;return route.continue();});
  await page.goto(base+'/');await page.locator('[data-home-start="'+start+'"]').click();
  await expect(page.locator('#calculadora-widget')).toBeVisible();release();
  const frame=page.frameLocator('iframe.calc-frame');await expect(frame.locator('#'+id)).toBeVisible();await expect(frame.locator('#path-entry')).toBeHidden();await destination(page);
});
test('home back and path changes preserve vehicle preferences, bid, ZIP and displayed estimate',async({page})=>{
  await isolate(page);await page.setViewportSize({width:390,height:844});await page.goto(base+'/');
  if(process.env.LANDING_SHOTS)await page.screenshot({path:require('node:path').join(process.env.LANDING_SHOTS,'home-390-en.png')});
  const frame=page.frameLocator('iframe.calc-frame');
  await page.locator('[data-home-start="find"]').click();await frame.locator('#find-marca').selectOption('BMW');await frame.locator('#find-modelo').selectOption('X5');await frame.locator('#find-trim').fill('M Sport');
  await clickCalculator(page,'#path-b [data-back-choice]');await expect(page.locator('#calculadora-widget')).toBeHidden();
  await page.locator('[data-home-start="calculate"]').click();await frame.locator('#lance').fill('10000');await frame.locator('#zip').fill('33060');
  await expect(frame.locator('#resultado')).toContainText('$13,130');
  if(process.env.LANDING_SHOTS)await page.screenshot({path:require('node:path').join(process.env.LANDING_SHOTS,'form-390-en.png')});
  await clickCalculator(page,'#path-a [data-back-choice]');await page.locator('[data-home-start="find"]').click();await expect(frame.locator('#find-modelo')).toHaveValue('X5');await expect(frame.locator('#find-trim')).toHaveValue('M Sport');
  await clickCalculator(page,'#path-b [data-back-choice]');await page.locator('[data-home-start="calculate"]').click();await expect(frame.locator('#lance')).toHaveValue('10000');await expect(frame.locator('#zip')).toHaveValue('33060');await expect(frame.locator('#resultado')).toContainText('$13,130');
});

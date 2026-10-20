'use strict';
const {test,expect}=require('@playwright/test');
const parser=require('../panel-calc-message');
const base='http://127.0.0.1:4173';

for(const lang of ['en','es','pt'])for(const mode of ['calculate','find'])test('complete '+mode+' in '+lang+' without an experience answer; keep Ref, routing, WhatsApp and SMS',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(base)&&r.request().method()==='GET'?r.continue():r.abort());
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'/msc-calculadora.html?start='+mode+'&lang='+lang);
  await expect(page.locator('html')).toHaveAttribute('lang',lang);
  await expect(page.locator('input[name="exp"],input[name="find-exp"],[data-i18n="q_exp"]')).toHaveCount(0);
  const prefix=mode==='find'?'find-':'';
  await page.locator('#'+prefix+'marca').selectOption('BMW');
  await page.locator('#'+prefix+'modelo').selectOption('X5');
  await page.locator('#'+prefix+'nome').fill('Ana Teste');
  await page.locator('#'+prefix+'zip').fill('33060');
  if(mode==='find'){
    await page.locator('#find-trim').fill('M Sport');
    await page.locator('#find-year-from').selectOption('2020');await page.locator('#find-year-to').selectOption('2025');
    await page.locator('#find-miles-from').fill('1000');await page.locator('#find-miles-to').fill('10000');
  }else await page.locator('#lance').fill('10000');
  const radio='input[name="'+prefix+'prazo"][value="30d"]';
  // Timing still qualifies the lead; the removed experience question does not block contact.
  expect(await page.evaluate(mode=>mode==='find'?validarFind(false):formOk(),mode)).toBe(false);
  await page.locator(radio).check();
  expect(await page.evaluate(mode=>mode==='find'?validarFind(true):validar(),mode)).toBe(true);
  const wa=await page.locator(mode==='find'?'#find-wa':'#wa').getAttribute('href');
  const sms=await page.locator(mode==='find'?'#find-sms':'#sms').getAttribute('href');
  expect(wa).toMatch(/^https:\/\/wa\.me\/13055400742\?text=/);expect(sms).toMatch(/^sms:\+13055400742[?&]body=/);
  const message=decodeURIComponent(wa.split('?text=')[1]);
  expect(decodeURIComponent(sms.split('body=')[1])).toBe(message);
  expect(message).toContain('BMW X5');expect(message).toContain('33060');
  expect(message).not.toMatch(/\b1st\b|\brepeat\b|first time|bought before|primeira vez|primera vez/i);
  const parsed=parser.parse(message);expect(parsed.calculator).toBe(true);expect(parsed.refState).toBe('REF');expect(parsed.name).toBe('Ana Teste');expect(parsed.vehicle).toBe('BMW X5');
  if(mode==='calculate'){
    await expect(page.locator('#wa-bottom')).toHaveAttribute('href',wa);await expect(page.locator('#sms-bottom')).toHaveAttribute('href',sms);
    await expect(page.locator('#resultado')).toContainText('$13,130');
  }else{expect(message).toContain('2020-2025');expect(message).toContain('1,000-10,000');}
  expect(errors).toEqual([]);
});

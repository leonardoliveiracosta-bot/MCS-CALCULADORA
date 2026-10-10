'use strict';
const {test,expect}=require('@playwright/test');
const path=require('node:path');
const base='http://127.0.0.1:4173';

for(const failMeasurement of [false,true])test(`Destravar keeps two cards, selection and the existing two-click send (measurement fails: ${failMeasurement})`,async({page})=>{
  await page.route('**/*',route=>route.request().url()===base+'/fixture'?route.fulfill({contentType:'text/html',body:'<main id="fixture"></main>'}):route.abort());
  await page.goto(base+'/fixture');
  await page.addScriptTag({path:path.join(__dirname,'../painel/action.js')});
  await page.addScriptTag({path:path.join(__dirname,'../painel/lead.js')});
  await page.evaluate(async(fail)=>{
    window.aiCalls=[];
    const request=async(url,options={})=>{
      const body=options.body?JSON.parse(options.body):null;
      window.aiCalls.push({url,body});
      if(url.startsWith('/api/panel/lead?'))return {timezone:'America/New_York',record:{id:'11111111-1111-4111-8111-111111111111',contact:{display_name:'Test Client'},phones:[{phone_e164:'+13055550100'}],conversation:[]}};
      if(url==='/api/panel/unlock-sale'){
        if(body.action==='feedback'){if(fail)throw Error('measurement offline');return {ok:true};}
        return {options:['OpenAI','Claude'].map((provider,index)=>({ok:true,provider,role:'Especialista em pessoas e vendas',titulo:'Retomar conversa',acao:'Conversar sobre o pedido',mensagemPt:'Oi',mensagemEn:'Hello there',suggestionId:`00000000-0000-4000-8000-00000000000${index+1}`}))};
      }
      if(url==='/api/panel/reply')return {sent:true};
      return {};
    };
    await MCSLead.open({kind:'journey',key:'test',root:document.querySelector('#fixture'),request,onChanged:async()=>{}});
  },failMeasurement);
  await page.getByRole('button',{name:'Destravar esta venda',exact:true}).click();
  await expect(page.locator('.unlock-option')).toHaveCount(2);
  const card=page.locator('.unlock-option').first();
  await card.locator('.unlock-message').fill('Hello there!');
  await card.getByRole('button',{name:'Escolher esta',exact:true}).click();
  await expect(card).toHaveClass(/is-chosen/);
  await card.getByRole('button',{name:'Enviar por WhatsApp',exact:true}).click();
  expect(await page.evaluate(()=>aiCalls.filter(c=>c.url==='/api/panel/reply').length)).toBe(0);
  await card.getByRole('button',{name:'Confirmar envio por WhatsApp',exact:true}).click();
  await expect(card.getByRole('button',{name:'Enviado',exact:true})).toBeVisible();
  const calls=await page.evaluate(()=>aiCalls);
  expect(calls.filter(c=>c.url==='/api/panel/reply')).toHaveLength(1);
  expect(calls.filter(c=>c.body?.action==='feedback').map(c=>[c.body.event,c.body.editDistance])).toEqual([['PICKED',1],['SENT',1]]);
});

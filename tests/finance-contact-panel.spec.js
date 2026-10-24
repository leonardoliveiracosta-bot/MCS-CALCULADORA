'use strict';
const {test,expect}=require('@playwright/test'),fs=require('node:fs'),path=require('node:path');
const base='http://127.0.0.1:4173',model=require('../finance-model');
for(const width of [320,390,1280])test('finance card combines contact and context and preserves archive actions at '+width,async({page})=>{
  await page.setViewportSize({width,height:900});
  const panel=fs.readFileSync(path.join(__dirname,'../painel/index.html'),'utf8');
  const section=panel.match(/<section id="site-contact-requests"[\s\S]*?<\/section>/)[0];
  const finance={id:'f3eedafa-6b3d-4cca-801c-0b934f0d0e9c',name:'Finance Test',phone_e164:'+12025550123',source:'finance',channel:'CALL',language:'en',status:'OPEN',created_at:'2026-10-23T17:00:00Z',finance:{ref:'FNA23',details:model.details({credit_profile:'very_good',down_payment:'2500_5000',monthly_payment:'400_600',trade_in:'yes'},'pt')}};
  const regular={...finance,id:'regular',name:'Regular Contact',source:'footer',finance:undefined};
  await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
  await page.route(base+'/finance-card-fixture',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/painel/painel.css"><link rel="stylesheet" href="/painel/tema-mcs.css"><link rel="stylesheet" href="/painel/identidade.css"><link rel="stylesheet" href="/painel/site-contact.css"><main class="shell">'+section+'</main><script src="/painel/site-contact.js"></script><script>MCSSiteRequests.load(async(url,options)=>{const response=await fetch(url,options);return response.json()})</script>'}));
  await page.route('**/api/panel/contact-requests',route=>{
    if(route.request().method()==='POST'){finance.status=route.request().postDataJSON().status;return route.fulfill({json:{ok:true}});}
    return route.fulfill({json:{items:finance.status==='OPEN'?[finance,regular]:[regular],recent:finance.status==='OPEN'?[]:[finance],nextOffset:null}});
  });
  await page.goto(base+'/finance-card-fixture');const card=page.locator('[data-request-id="'+finance.id+'"]');
  await expect(card).toContainText('Recebido na MCS');await expect(card).not.toContainText('confirmado no DealerCenter');await expect(card.getByRole('button',{name:'Copiar identificação',exact:true})).toBeVisible();await expect(card).toContainText('Finance Test');await expect(card).toContainText('+12025550123');await expect(card).toContainText('Financiamento · Ref: FNA23');
  await expect(card.locator('dt')).toHaveText(['Perfil de crédito','Entrada','Parcela mensal','Troca']);await expect(card.locator('dd')).toHaveCount(4);
  await expect(card.getByRole('link',{name:'Ligar',exact:true})).toHaveAttribute('href','tel:+12025550123');
  await expect(page.locator('[data-request-id="regular"]')).not.toContainText('Financiamento');await expect(page.locator('[data-request-id="regular"]')).toContainText('Pediu contato · Ligação');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.context().grantPermissions(['clipboard-read','clipboard-write']);await card.getByRole('button',{name:'Copiar identificação',exact:true}).click();const copied=await page.evaluate(()=>navigator.clipboard.readText());expect(copied).toContain('Finance Test\n+12025550123\nRef: FNA23');expect(copied).toContain('Pedido de financiamento recebido na MCS');expect(copied).not.toContain('confirmado no DealerCenter');
  await card.getByRole('button',{name:'Arquivar',exact:true}).click();await page.getByText('Já resolvidos · últimos 7 dias',{exact:true}).click();
  const archived=page.locator('.site-contact-resolved [data-request-id="'+finance.id+'"]');await expect(archived).toContainText('FNA23');await archived.getByRole('button',{name:'Desfazer',exact:true}).click();
  await expect(page.locator('.site-contact-list [data-request-id="'+finance.id+'"]')).toContainText('FNA23');
});

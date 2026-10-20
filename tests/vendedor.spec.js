'use strict';
const path=require('node:path');const {test,expect}=require('@playwright/test');
const {createPanel}=require('./fixtures/painel-visual');
const base=process.env.PANEL_LOCAL_URL||'http://127.0.0.1:4173';
const J='69000000-0000-4000-8000-000000000010';
test.use({launchOptions:{executablePath:'/root/.cache/ms-playwright/chromium_headless_shell-1193/chrome-linux/headless_shell'}});
test.setTimeout(120000);
const suggestion={mensagens:[{texto:'Macan S, I understand your target',pt:'Macan S, entendi o que você procura'},{texto:'When are you looking to buy?',pt:'Quando você pretende comprar?'}],nivel:'compra',etapa:'qualificar',proximo:'Confirmar prazo',temperatura:'morno',link:true};
const result=(allowed=true)=>({id:'77000000-0000-4000-8000-000000000001',suggestion,state:'PRONTA',fingerprint:'abc',version:1,send:{allowed,channel:'WHATSAPP',phone:'+13055550101',name:'Mariana Costa',openUntil:new Date(Date.now()+(allowed?3600000:-3600000)).toISOString()}});
async function isolated(page,width,allowed=true){
 await page.setViewportSize({width,height:900});await page.goto(base+'/painel/',{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>{document.body.className='';document.body.innerHTML='<main id="test-host" style="max-width:640px;margin:auto;padding:12px"></main>';window.copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});});
 const calls=[];
 await page.evaluate(({allowed,data})=>{window.testData=data;window.calls=[];window.testRequest=async(url,options)=>{const b=JSON.parse(options.body);window.calls.push(b);if(b.action==='window')return {send:window.testData.send};if(b.action==='send')return {ok:true,simulated:true};if(b.adjust)return {...window.testData,adjusted:true};return window.testData;};document.querySelector('#test-host').append(MCSVendedor.box('77000000-0000-4000-8000-000000000010',{request:window.testRequest}));},{allowed,data:result(allowed)});
 await expect(page.locator('.vendedor-bubble')).toHaveCount(3);return calls;
}
for(const width of [360,390,1440])test(`sugestão e ajuste em ${width}px, sem envio automático ou overflow`,async({page})=>{
 await isolated(page,width);
 if(width===390)await page.screenshot({path:'../vendedor-mobile.png',fullPage:true});
 await expect(page.locator('.vendedor-new')).toHaveCount(0);
 expect(await page.evaluate(()=>window.calls.filter(x=>x.action==='send').length)).toBe(0);
 await expect(page.getByText('Macan S, entendi o que você procura',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Copiar',exact:true}).click();expect(await page.evaluate(()=>window.copied)).toBe(suggestion.mensagens.map(m=>m.texto).join('\n')+'\nmycarscout.net');
 await page.getByRole('button',{name:'Ajustar',exact:true}).click();await page.getByLabel('O que você quer mudar',{exact:true}).fill('Fale em espanhol');await page.getByRole('button',{name:'Gerar nova sugestão'}).click();
 await expect(page.locator('.vendedor-new')).toBeVisible();await expect(page.getByRole('button',{name:'Copiar as mensagens'})).toBeVisible();await expect(page.getByRole('link',{name:'Abrir WhatsApp'})).toHaveAttribute('href','https://wa.me/13055550101');
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);expect(overflow).toBe(false);
 await page.getByRole('button',{name:'Revisar e enviar'}).click();await expect(page.getByRole('dialog')).toBeVisible();expect(await page.evaluate(()=>window.calls.some(x=>x.action==='send'))).toBe(false);
 await page.getByRole('button',{name:'Enviar as mensagens'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);expect(await page.evaluate(()=>window.calls.filter(x=>x.action==='send').length)).toBe(1);
});
test('24h fechada troca envio por copiar e avisa; revisão não aparece',async({page})=>{
 await isolated(page,390,false);await expect(page.locator('.vendedor-warning')).toBeVisible();await expect(page.getByRole('button',{name:'Revisar e enviar'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Copiar',exact:true})).toBeVisible();
});
test('erro permite tentar de novo, última mensagem MCS oculta bloco',async({page})=>{
 await isolated(page,390);await page.evaluate(()=>{document.querySelector('#test-host').replaceChildren(MCSVendedor.box('x',{request:async()=>{throw Error('AI_UNAVAILABLE');}}));});
 await expect(page.getByText('Não consegui gerar agora')).toBeVisible();await expect(page.getByRole('button',{name:'Tentar de novo'})).toBeVisible();
 await page.evaluate(()=>{document.querySelector('#test-host').replaceChildren(MCSVendedor.box('x',{request:async()=>({skipped:true})}));});await expect(page.locator('.vendedor-card')).toBeHidden();
});
test('configuração mostra versão e salva/restaura sem apagar histórico',async({page})=>{
 await isolated(page,390);await page.evaluate(async()=>{
  const versions=[{id:'v1',nome:'mcs-vendedor',conteudo:'# Primeira skill',versao:1,ativa:false,criado_em:'2026-10-19T12:00:00Z'},{id:'v2',nome:'mcs-vendedor',conteudo:'# Segunda skill',versao:2,ativa:true,criado_em:'2026-10-20T12:00:00Z'}];
  window.settingsCalls=[];const request=async(url,opts)=>{const b=JSON.parse(opts.body);window.settingsCalls.push(b);if(b.action==='save'||b.action==='restore'){versions.forEach(v=>v.ativa=false);versions.push({id:'v'+(versions.length+1),nome:'mcs-vendedor',conteudo:b.content||versions.find(v=>v.id===b.versionId).conteudo,versao:versions.length+1,ativa:true,criado_em:new Date().toISOString()});}return {active:versions.find(v=>v.ativa),versions:versions.slice().reverse()};};document.querySelector('#test-host').replaceChildren();await MCSVendedor.settings(document.querySelector('#test-host'),{request});
 });
 await expect(page.getByText('Anthropic (Claude Sonnet)',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Ver anterior'}).click();await expect(page.getByText('# Primeira skill',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Restaurar',exact:true}).click();await expect(page.getByText('Versão restaurada',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Colar versão nova'}).click();await page.getByLabel('Cole o texto inteiro da skill').fill('# Nova skill completa');await page.getByRole('button',{name:'Salvar nova versão'}).click();await expect(page.getByText('Nova versão ativa',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>window.settingsCalls.filter(x=>x.action==='save').length)).toBe(1);
});
test('ficha real mantém telefone/Ref no topo e monta vendedor abaixo da conversa',async({page})=>{
 const panel=await createPanel();try{
 await panel.open(page,base,{width:390});await page.route('**/api/panel/vendedor',async route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result())}));
 await page.goto(base+'/painel/#ficha/'+J,{waitUntil:'domcontentloaded'});
 await expect(page.locator('.vendedor-card')).toBeVisible({timeout:60000});await expect(page.locator('#record-detail')).toContainText('Mariana Costa');await expect(page.locator('#record-detail')).toContainText('MCQ2A');
 const positions=await page.evaluate(()=>{const t=document.querySelector('.lead-thread'),s=document.querySelector('.vendedor-card');return {threadBefore:!!(t.compareDocumentPosition(s)&Node.DOCUMENT_POSITION_FOLLOWING),phone:document.querySelector('#record-detail').textContent.includes('555')};});expect(positions).toEqual({threadBefore:true,phone:true});expect(panel.failures).toEqual([]);
 }finally{await panel.close();}
});

'use strict';
const path=require('node:path');const {test,expect}=require('@playwright/test');
const {createPanel}=require('./fixtures/painel-visual');
const base=process.env.PANEL_LOCAL_URL||'http://127.0.0.1:4173';
const J='69000000-0000-4000-8000-000000000010';
test.use({launchOptions:{executablePath:process.env.CHROMIUM_PATH||'/root/.cache/ms-playwright/chromium_headless_shell-1193/chrome-linux/headless_shell',...(process.env.PANEL_CHROMIUM_SINGLE_PROCESS==='1'?{args:['--single-process','--no-zygote']}:{})}});
test.setTimeout(120000);
const suggestion={mensagens:[{texto:'Macan S, I understand your target',pt:'Macan S, entendi o que você procura'},{texto:'When are you looking to buy?',pt:'Quando você pretende comprar?'}],nivel:'compra',etapa:'qualificar',proximo:'Confirmar prazo',temperatura:'morno',link:true};
const result=(allowed=true)=>({id:'77000000-0000-4000-8000-000000000001',suggestion,state:'PRONTA',fingerprint:'abc',lastMessageId:'last-one',version:1,send:{allowed,channel:'WHATSAPP',phone:'+13055550101',name:'Mariana Costa',openUntil:new Date(Date.now()+(allowed?3600000:-3600000)).toISOString()}});
async function isolated(page,width,allowed=true){
 await page.setViewportSize({width,height:900});await page.goto(base+'/painel/',{waitUntil:'domcontentloaded'});
 await page.evaluate(()=>{document.body.className='';document.body.innerHTML='<main id="test-host" style="max-width:640px;margin:auto;padding:12px"></main>';window.copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text;}}});});
 const calls=[];
 await page.evaluate(({allowed,data})=>{window.testData=data;window.calls=[];window.testRequest=async(url,options)=>{const b=JSON.parse(options.body);window.calls.push(b);if(b.action==='window')return {send:window.testData.send};if(b.action==='updates')return {lastMessageId:window.testData.lastMessageId};if(b.action==='send')return {ok:true,simulated:true};if(b.adjust)return {...window.testData,adjusted:true};return window.testData;};document.querySelector('#test-host').append(MCSVendedor.box('77000000-0000-4000-8000-000000000010',{request:window.testRequest}));},{allowed,data:result(allowed)});
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
 await page.getByRole('checkbox',{name:'Mensagem 2',exact:true}).uncheck();await page.getByRole('checkbox',{name:'Link do site',exact:true}).uncheck();
 await page.getByRole('button',{name:'Enviar selecionadas (1)',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 expect(await page.evaluate(()=>window.calls.filter(x=>x.action==='send'))).toEqual([expect.objectContaining({selected:[0]})]);
});
test('24h fechada troca envio por copiar e avisa; revisão não aparece',async({page})=>{
 await isolated(page,390,false);await expect(page.locator('.vendedor-warning')).toBeVisible();await expect(page.getByRole('button',{name:/Enviar selecionadas/})).toHaveCount(0);await expect(page.getByRole('button',{name:'Copiar',exact:true})).toBeVisible();
});
test('erro permite tentar de novo, última mensagem MCS oculta bloco',async({page})=>{
 await isolated(page,390);await page.evaluate(()=>{document.querySelector('#test-host').replaceChildren(MCSVendedor.box('x',{request:async()=>{throw Error('AI_UNAVAILABLE');}}));});
 await expect(page.getByText('Não consegui gerar agora')).toBeVisible();await expect(page.getByRole('button',{name:'Tentar de novo'})).toBeVisible();
 await page.evaluate(()=>{document.querySelector('#test-host').replaceChildren(MCSVendedor.box('x',{request:async()=>({skipped:true})}));});await expect(page.getByText('Aguardando resposta do cliente…',{exact:true})).toBeVisible();
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
 await page.clock.install();await page.getByRole('button',{name:'Ajustar',exact:true}).click();await page.getByLabel('O que você quer mudar',{exact:true}).fill('Não perder meu ajuste');
 await panel.backend.db.exec(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('69000000-0000-4000-8000-999999999999','preview','69000000-0000-4000-8000-000000000012','WHATSAPP','CUSTOMER','I can buy tomorrow','tomorrow',now(),'new-live-response',1,'IMPORT',now());insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','69000000-0000-4000-8000-999999999999','${J}','IMPORT',now());`);
 await page.route('**/api/panel/vendedor',async route=>{const body=route.request().postDataJSON();const next={...result(),id:'next-id',lastMessageId:'69000000-0000-4000-8000-999999999999',fingerprint:'next-fingerprint',suggestion:{...suggestion,mensagens:[{texto:'Tomorrow works, let us discuss next steps',pt:'Amanhã funciona, vamos conversar sobre os próximos passos'}]}};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body.action==='updates'?{lastMessageId:next.lastMessageId}:next)});});
 await page.clock.fastForward(5100);await expect(page.locator('.lead-thread')).toContainText('I can buy tomorrow');await expect(page.getByText('Tomorrow works, let us discuss next steps',{exact:true})).toBeVisible();await expect(page.getByLabel('O que você quer mudar',{exact:true})).toHaveValue('Não perder meu ajuste');

 const positions=await page.evaluate(()=>{const t=document.querySelector('.lead-thread'),s=document.querySelector('.vendedor-card');return {threadBefore:!!(t.compareDocumentPosition(s)&Node.DOCUMENT_POSITION_FOLLOWING),phone:document.querySelector('#record-detail').textContent.includes('555')};});expect(positions).toEqual({threadBefore:true,phone:true});expect(panel.failures).toEqual([]);
 }finally{await panel.close();}
});

test('nova resposta chega sozinha, atualiza sugestão e preserva ajuste em digitação',async({page})=>{
 await page.clock.install();await isolated(page,390);
 await page.getByRole('button',{name:'Ajustar',exact:true}).click();await page.getByLabel('O que você quer mudar',{exact:true}).fill('Meu ajuste ainda não enviado');
 await page.evaluate(()=>{window.testData={...window.testData,id:'new-suggestion',lastMessageId:'customer-next',fingerprint:'new-fingerprint',suggestion:{...window.testData.suggestion,mensagens:[{texto:'Thanks, we can discuss the next step',pt:'Obrigado, podemos conversar sobre o próximo passo'}]}};});
 await page.clock.fastForward(5100);await expect(page.getByText('Thanks, we can discuss the next step',{exact:true})).toBeVisible();
 await expect(page.getByLabel('O que você quer mudar',{exact:true})).toHaveValue('Meu ajuste ainda não enviado');
 expect(await page.evaluate(()=>window.calls.filter(x=>x.action==='suggest').length)).toBe(2);
 await page.clock.fastForward(5100);expect(await page.evaluate(()=>window.calls.filter(x=>x.action==='suggest').length)).toBe(2);
});
test('sem seleção não envia; seleção 1 e 2 envia só índices escolhidos',async({page})=>{
 await isolated(page,390);for(const c of await page.getByRole('checkbox').all())await c.uncheck();
 await expect(page.getByRole('button',{name:'Enviar selecionadas (0)',exact:true})).toBeDisabled();expect(await page.evaluate(()=>window.calls.some(x=>x.action==='send'))).toBe(false);
 await page.getByRole('checkbox',{name:'Mensagem 1',exact:true}).check();await page.getByRole('checkbox',{name:'Mensagem 2',exact:true}).check();
 await page.getByRole('button',{name:'Enviar selecionadas (2)',exact:true}).click();expect(await page.evaluate(()=>window.calls.find(x=>x.action==='send').selected)).toEqual([0,1]);
});
test('resposta chega durante geração: prepara a mais recente sem esperar outro evento',async({page})=>{
 await isolated(page,390);await page.evaluate(()=>{window.raced=0;document.querySelector('#test-host').replaceChildren(MCSVendedor.box('x',{request:async()=>{window.raced++;return window.raced===1?{skipped:true,from:'CUSTOMER',lastMessageId:'newest'}:{...window.testData,lastMessageId:'newest'};}}));});
 await expect(page.locator('.vendedor-bubble')).toHaveCount(3);expect(await page.evaluate(()=>window.raced)).toBe(2);
});

for(const channel of ['SMS','WHATSAPP'])test(`SMS na sugestão ${channel}: QR contém só seleção, telefone e link escolhidos`,async({page})=>{
 await isolated(page,1440,false);
 await page.evaluate(channel=>{
  window.smsRecords=[];const original=window.testRequest;
  window.testData.send.channel=channel;
  window.testRequest=async(url,options)=>{const body=JSON.parse(options.body);if(body.action==='sms_sent'){window.smsRecords.push(body);return {recorded:true,messageId:'sms-id'};}if(body.action==='sms_undo')return {undone:true};return original(url,options);};
  const open=MCSWaHandoff.openModal;MCSWaHandoff.openModal=(href,request,options)=>{window.smsHref=href;return open(href,request,options);};
  document.querySelector('#test-host').replaceChildren(MCSVendedor.box('sms-journey',{request:window.testRequest}));
 },channel);
 const sms=page.getByRole('link',{name:'Enviar por SMS',exact:true});await expect(sms).toBeVisible();
 await page.getByRole('checkbox',{name:'Mensagem 1',exact:true}).uncheck();
 await sms.click();await expect(page.locator('.wa-handoff-dialog')).toBeVisible();await expect(page.locator('.wa-handoff-qr svg')).toHaveCount(1);
 const expected=suggestion.mensagens[1].texto+'\nmycarscout.net';
 expect(await page.evaluate(()=>window.smsHref)).toBe('sms:+13055550101&body='+encodeURIComponent(expected));
 expect(await page.evaluate(()=>window.smsRecords)).toEqual([{action:'sms_sent',journeyId:'sms-journey',text:expected}]);
 await page.getByRole('button',{name:'Fechar',exact:true}).click();
 await page.getByRole('button',{name:'Desfazer (não enviei)',exact:true}).click();await expect(page.getByText('Registro desfeito',{exact:true})).toBeVisible();
 for(const check of await page.getByRole('checkbox').all())await check.uncheck();await expect(sms).toHaveAttribute('aria-disabled','true');
 expect(await page.evaluate(()=>window.calls.some(c=>c.action==='send'))).toBe(false);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});

test('SMS no celular usa link nativo e sem telefone não oferece envio',async({page})=>{
 await isolated(page,390,false);
 await page.evaluate(()=>{MCSWaHandoff.isPhone=()=>true;window.nativeHref=null;document.addEventListener('click',event=>{const link=event.target.closest('.vendedor-sms');if(link){window.nativeHref=link.href;event.preventDefault();}},true);});
 await page.getByRole('checkbox',{name:'Link do site',exact:true}).uncheck();
 await page.getByRole('link',{name:'Enviar por SMS',exact:true}).click();
 expect(await page.evaluate(()=>window.nativeHref)).toBe('sms:+13055550101&body='+encodeURIComponent(suggestion.mensagens.map(m=>m.texto).join('\n')));
 await expect(page.locator('.wa-handoff-dialog')).toHaveCount(0);
 await page.evaluate(()=>{window.testData.send.phone=null;document.querySelector('#test-host').replaceChildren(MCSVendedor.box('no-phone',{request:window.testRequest}));});
 await expect(page.locator('.vendedor-bubble')).toHaveCount(3);await expect(page.getByRole('link',{name:'Enviar por SMS',exact:true})).toHaveCount(0);
});

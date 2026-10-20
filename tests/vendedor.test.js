'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
Object.assign(process.env,{VERCEL_ENV:'preview',ANTHROPIC_API_KEY:'test-only',D360_API_KEY:'test-only',SUPABASE_URL:'http://banco-simulado.local',SUPABASE_SECRET_KEY:'test-only',ANTHROPIC_VENDEDOR_MODEL:'claude-sonnet-test'});
const {createBackend,BASE}=require('./fixtures/banco-simulado');
const server=require('../panel-server'),v=require('../panel-vendedor'),reply=require('../api/panel/reply');
const id=n=>`77aa0000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const J=id(1),C=id(2),CHAT=id(3),M=id(4);
const valid=()=>({mensagens:[{texto:'Macan S, I understand your target',pt:'Macan S, entendi o que você procura'},{texto:'When are you looking to buy?',pt:'Quando você pretende comprar?'}],nivel:'compra',etapa:'qualificar',proximo:'Confirmar prazo',temperatura:'morno',link:true});
let db,s,ctx,paid=0,prompts=[],sent=[],answer=()=>valid();
const sql=async(q,p)=>(await db.db.query(q,p)).rows;
test.before(async()=>{
 db=await createBackend({seed:`insert into contacts(id,environment,display_name,source,created_at,updated_at) values('${C}','preview','Test Customer','WHATSAPP_DIRECT',now(),now());
insert into journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,vehicle_text,payment_text,created_at,updated_at) values('${J}','preview','${C}','QA7M2','WHATSAPP_DIRECT','NOVO','ATIVO','{}','Porsche Macan S','cash',now(),now());
insert into chats(id,environment,channel,contact_id,canonical_key,is_group,resolution_status,first_seen_at,last_seen_at,created_at,updated_at) values('${CHAT}','preview','WHATSAPP','${C}','wa:+13055550121',false,'RESOLVED',now(),now(),now(),now());
insert into contact_phones(environment,contact_id,phone_e164,phone_raw,is_primary,is_current,created_at) values('preview','${C}','+13055550121','+13055550121',true,true,now());
insert into messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${M}','preview','${CHAT}','WHATSAPP','CUSTOMER','2019 Macan S around 22k','2019 macan',now()-interval '2 hours','seller-test',1,'IMPORT',now());
insert into message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${M}','${J}','IMPORT',now());
insert into calc_runs(zip,estado,lance,pagamento,idioma,dados) values('33060','Florida',20000,'cash','en','{"ref":"QA7M2","sid":"vendedor-test","evento":"whatsapp","logical_mode":"VALOR","marca":"Porsche","modelo":"Macan S","prazo":"30d"}');`});
 global.fetch=db.fetch;ctx={config:{url:BASE,secretKey:'test-only'},environment:'preview'};
 s={...server,resolveTarget:reply.resolveTarget,windowState:reply.windowState,reserveCall:async()=>{},paidCall:async(b,opts)=>{paid++;prompts.push(opts);return opts.send();},fetch:async(url,opts)=>{assert.equal(url,'https://api.anthropic.com/v1/messages');const body=JSON.parse(opts.body);assert.equal(body.max_tokens,800);assert.equal('temperature' in body,false);assert.match(body.model,/^claude-sonnet-/);return {ok:true,status:200,json:async()=>({content:[{type:'text',text:typeof answer()==='string'?answer():JSON.stringify(answer())}],usage:{input_tokens:100,output_tokens:100}})};},reply:async(c,b)=>{sent.push(b.textEn);return {status:200,ok:true,simulated:true};}};
});
test.after(async()=>{if(db)await db.db.close();});
test('JSON: limite de mensagens, palavras, pergunta, tradução e link separados',()=>{
 assert.deepEqual(v.validate(valid()),valid());
 for(const mutate of [x=>x.mensagens.push(...x.mensagens),x=>x.mensagens[0].texto='one two three four five six seven eight nine ten eleven',x=>x.mensagens[0].texto+='.',x=>x.mensagens[0].texto+='?',x=>x.mensagens[0].pt='',x=>x.link='true',x=>x.mensagens[0].texto='https://example.com',x=>x.nivel='other']){const x=valid();mutate(x);assert.throws(()=>v.validate(x));}
 assert.deepEqual(v.texts(valid()),[...valid().mensagens.map(m=>m.texto),'mycarscout.net']);
});
test('contexto inteiro em ordem e pedido completo sem corte de 150 mensagens',async()=>{
 const data=await v.context(ctx,J,s);const p=JSON.parse(v.prompt(data,'Não perguntar o ano',null));
 assert.equal(p.pedidosCalculadora[0].modo,'VALOR');assert.equal(p.pedidosCalculadora[0].carros[0].make,'Porsche');assert.equal(p.pedidosCalculadora[0].lanceMaximo,20000);assert.equal(p.pedidosCalculadora[0].estado,'FLORIDA');assert.equal(p.pedidosCalculadora[0].pagamento,'cash');assert.equal(p.pedidosCalculadora[0].Ref,'QA7M2');assert.equal(p.pedidosCalculadora[0].prazo,'30d');assert.equal(p.ajusteDoLeo,'Não perguntar o ano');assert.equal(p.conversa[0].quem,'cliente');
 const many={...data,messages:Array.from({length:220},(_,i)=>({...data.messages[0],body_text:'Message '+i}))};assert.equal(JSON.parse(v.prompt(many,null)).conversa.length,220);
});
test('duas aberturas simultâneas pagam uma vez; reabertura usa cache',async()=>{
 const [a,b]=await Promise.all([v.handle(ctx,{journeyId:J},s),v.handle(ctx,{journeyId:J},s)]);assert.equal(paid,1);assert.ok(a.suggestion||b.suggestion);const next=await v.handle(ctx,{journeyId:J},s);assert.equal(next.cached,true);assert.equal(next.send.allowed,true);assert.equal(paid,1);assert.match(prompts[0].system,/No máximo 10 palavras/);assert.match(prompts[0].system,/de 1 a 3 mensagens/);assert.equal(sent.length,0);
});
test('ajustar é explícito e substitui só o cache da mensagem correta',async()=>{
 const out=await v.handle(ctx,{journeyId:J,adjust:'Fale em espanhol'},s);assert.equal(out.adjusted,true);assert.equal(paid,2);assert.equal(JSON.parse(prompts.at(-1).user).ajusteDoLeo,'Fale em espanhol');assert.equal(sent.length,0);
});
test('JSON inválido tenta uma vez; falha preserva sugestão anterior',async()=>{
 answer=()=>'{broken';const n=paid;const out=await v.handle(ctx,{journeyId:J,adjust:'Ajuste'},s);assert.equal(out.status,503);assert.equal(paid-n,2);answer=()=>valid();const cached=await v.handle(ctx,{journeyId:J},s);assert.deepEqual(cached.suggestion,valid());assert.equal(cached.state,'PRONTA');
});
test('versões atômicas, restauração guarda histórico e seed integral',async()=>{
 const before=await v.handle(ctx,{action:'settings'},s);assert.equal(before.active.versao,1);const original=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20261020031218_vendedor_ia.sql'),'utf8').split('$mcs_skill$')[1];assert.equal(before.active.conteudo,original);
 const newer=await v.handle(ctx,{action:'save',content:'Nova skill completa'},s);assert.equal(newer.active.versao,2);const restored=await v.handle(ctx,{action:'restore',versionId:before.active.id},s);assert.equal(restored.active.versao,3);assert.equal(restored.active.conteudo,original);assert.equal(restored.versions.filter(x=>x.ativa).length,1);assert.equal((await v.handle(ctx,{journeyId:J},s)).version,1,'cache não custa de novo ao trocar skill');
 const prod=await v.handle({...ctx,environment:'production'},{action:'settings'},s);assert.equal(prod.active.versao,1);
});
test('envio exige revisão do conteúdo atual, envia sequencial e não duplica',async()=>{
 let out=await v.handle(ctx,{journeyId:J},s);
 assert.equal((await v.handle(ctx,{action:'send',journeyId:J,id:out.id,fingerprint:'old'},s)).error,'SUGGESTION_CHANGED');assert.equal(sent.length,0);
 const sentOut=await v.handle(ctx,{action:'send',journeyId:J,id:out.id,fingerprint:out.fingerprint},s);assert.equal(sentOut.ok,true);assert.deepEqual(sent,v.texts(valid()));
 const duplicate=await v.handle(ctx,{action:'send',journeyId:J,id:out.id,fingerprint:out.fingerprint},s);assert.equal(duplicate.error,'SEND_ALREADY_STARTED');assert.equal(sent.length,3);
});
test('24h usa só última recebida; resposta MCS recente não reabre janela',async()=>{
 await sql(`update messages set occurred_at_utc=now()-interval '25 hours' where id=$1`,[M]);
 const state=await v.handle(ctx,{action:'window',journeyId:J},s);assert.equal(state.send.allowed,false);
 const out=await v.handle(ctx,{journeyId:J},s);assert.equal((await v.handle(ctx,{action:'send',journeyId:J,id:out.id,fingerprint:out.fingerprint},s)).error,'WINDOW_CLOSED');
 await sql(`insert into messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values($1,'preview',$2,'WHATSAPP','MCS','Latest answer','latest',now(),'seller-mcs',1,'IMPORT',now())`,[id(9),CHAT]);await sql(`insert into message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview',$1,$2,'IMPORT',now())`,[id(9),J]);
 assert.equal((await v.handle(ctx,{journeyId:J},s)).skipped,true);assert.equal((await v.handle(ctx,{action:'window',journeyId:J},s)).send.allowed,false);
});
test('RLS e grants impedem navegador de ler instruções/cache ou executar RPCs',async()=>{
 for(const role of ['anon','authenticated']){await db.db.exec('set role '+role);try{await assert.rejects(()=>sql('select * from ia_instrucoes'));await assert.rejects(()=>sql('select * from ia_sugestoes'));await assert.rejects(()=>sql("select panel_vendedor_version('preview','unsafe')"));}finally{await db.db.exec('reset role');}}
 const rows=await sql("select relname,relrowsecurity,relforcerowsecurity from pg_class where relname in ('ia_sugestoes','ia_instrucoes')");assert.ok(rows.every(r=>r.relrowsecurity&&r.relforcerowsecurity));
});

test('Sonnet 5.5 usa opções compatíveis e resposta curta sem thinking inicial',async()=>{
 const before=process.env.ANTHROPIC_VENDEDOR_MODEL;process.env.ANTHROPIC_VENDEDOR_MODEL='claude-sonnet-5-5';
 try{let body;const out=await v.generate(ctx,'System','Fictitious client','TEST',{...s,fetch:async(url,opts)=>{body=JSON.parse(opts.body);return {ok:true,status:200,json:async()=>({content:[{type:'text',text:JSON.stringify(valid())}]})};}});assert.equal(out.model,'claude-sonnet-5-5');assert.equal(body.max_tokens,800);assert.equal('temperature' in body,false);assert.deepEqual(body.thinking,{type:'between_tools'});assert.deepEqual(body.output_config,{effort:'low'});}
 finally{process.env.ANTHROPIC_VENDEDOR_MODEL=before;}
});
test('lista de modelos escolhe Sonnet mais recente, nunca Opus',async()=>{
 const before=process.env.ANTHROPIC_VENDEDOR_MODEL;delete process.env.ANTHROPIC_VENDEDOR_MODEL;
 try{const model=await v.sonnetModel({fetch:async url=>{assert.match(url,/^https:\/\/api.anthropic.com\/v1\/models/);return {ok:true,json:async()=>({data:[{id:'claude-sonnet-5',created_at:'2026-07-01'},{id:'claude-opus-6',created_at:'2026-10-20'},{id:'claude-sonnet-5-5',created_at:'2026-09-28'}],has_more:false})};}});assert.equal(model,'claude-sonnet-5-5');}
 finally{process.env.ANTHROPIC_VENDEDOR_MODEL=before;}
});

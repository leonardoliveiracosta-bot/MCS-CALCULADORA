'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(process.env.PANEL_WASTE_BASELINE||path.join(__dirname,'..'));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function load(relative,mocks,sourceRoot=root){
  const file=path.join(sourceRoot,relative),mod={exports:{}};
  const req=name=>Object.hasOwn(mocks,name)?mocks[name]:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);
  new Function('require','module','exports',fs.readFileSync(file,'utf8'))(req,mod,mod.exports);return mod.exports;
}
test('dicionário: duas listas simultâneas consultam uma vez e recebem os mesmos dados',async()=>{
  const gate=deferred(),configured=[];let calls=0;
  const aliases=load('panel-model-aliases.js',{'./vehicle-catalog':{configureAliases:(...args)=>configured.push(args)}});
  const ctx={},dictionary={aliases:[{alias:'test'}],known:['test'],revision:'r1'};
  const services={rpc:async()=>{calls++;await gate.promise;return dictionary;}};
  const a=aliases.load(ctx,services),b=aliases.load(ctx,services);await tick();
  try {assert.equal(calls,1);} finally {gate.resolve();await Promise.all([a,b]);}
  assert.deepEqual(ctx.modelDictionary,dictionary);assert.deepEqual(configured,[[dictionary.aliases,dictionary.known,'r1']]);
  await aliases.load(ctx,services);assert.equal(calls,1);
  await aliases.load({},services);assert.equal(calls,2,'outro pedido consulta novamente');
});
test('dicionário: falha compartilhada libera nova tentativa e não marca dados como carregados',async()=>{
  const aliases=load('panel-model-aliases.js',{'./vehicle-catalog':{configureAliases(){}}});
  let calls=0;const ctx={},services={rpc:async()=>{calls++;if(calls===1)throw new Error('offline');return {aliases:[],revision:'fresh'};}};
  const results=await Promise.allSettled([aliases.load(ctx,services),aliases.load(ctx,services)]);
  assert.equal(calls,1);assert.ok(results.every(result=>result.status==='rejected'));
  assert.equal(ctx.modelAliasesLoaded,undefined);assert.equal(ctx.modelAliasesLoading,undefined);
  await aliases.load(ctx,services);assert.equal(calls,2);assert.equal(ctx.modelAliasesLoaded,true);
});
test('dicionário: resposta inválida continua erro, sem marcar sucesso',async()=>{
  const aliases=load('panel-model-aliases.js',{'./vehicle-catalog':{configureAliases(){throw new Error('must not configure');}}});
  const ctx={};await assert.rejects(aliases.load(ctx,{rpc:async()=>({})}),/MODEL_DICTIONARY_UNAVAILABLE/);
  assert.equal(ctx.modelAliasesLoaded,undefined);
});
function metaFixture(failBalance=false){
  const source=fs.readFileSync(path.join(root,'panel-server.js'),'utf8'),gate=deferred(),calls=[];
  const context={Date,rows:async(_ctx,table)=>{calls.push(table);await gate.promise;return table==='import_jobs'?[{completed_at:'2026-10-10T10:00:00Z'}]:[{occurred_at_utc:'2026-10-10T11:00:00Z'}];},
    rpc:async(_ctx,name,args)=>{calls.push(args.p_provider);if(failBalance)throw new Error('offline');return {balance:25,remaining:20,spent:5,warn:false,informed:true};}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function panelMeta('),source.indexOf('\nasync function recordMutation(')),context);
  return {gate,calls,run:()=>context.panelMeta({environment:'production'})};
}
test('metadados: saldos iniciam sem esperar datas, com os mesmos valores e duas consultas distintas',async()=>{
  const f=metaFixture(),pending=f.run();await tick();
  try {assert.deepEqual(f.calls,['import_jobs','messages','OPENAI','ANTHROPIC']);} finally {f.gate.resolve();}
  const result=JSON.parse(JSON.stringify(await pending));
  assert.equal(result.lastWhatsAppImportAt,'2026-10-10T10:00:00Z');assert.equal(result.lastWhatsAppMessageAt,'2026-10-10T11:00:00Z');
  assert.equal(result.ai.openai.remainingUsd,20);assert.equal(result.ai.anthropic.remainingUsd,20);assert.equal(result.ai.openai.spentUsd,5);
});
test('metadados: saldo indisponível continua null, sem exibir zero inventado',async()=>{
  const f=metaFixture(true),pending=f.run();f.gate.resolve();const result=await pending;
  assert.equal(result.ai,null);assert.equal(result.lastWhatsAppImportAt,'2026-10-10T10:00:00Z');
});
const id=n=>'40000000-0000-4000-8000-'+String(n).padStart(12,'0');
async function whatsapp({failFirst=false,empty=false,noSuggestions=false}={},sourceRoot=root){
  const ctx={environment:'production',config:{}},reads=[],writes=[];
  const suggestions=noSuggestions?[]:[{id:id(1),source_chat_id:id(11),source_contact_id:id(21),target_contact_id:id(31),target_ref:'AB234'},
    {id:id(2),source_chat_id:id(12),source_contact_id:id(22),target_contact_id:id(32),target_ref:'XY789'}];
  const messages=empty?[]:[{chat_id:id(11),body_text:'My Car Scout · Ref: AB234'}, {chat_id:id(12),body_text:'My Car Scout · Ref: ZZ678'}];
  let messageReads=0;
  const server={requirePanel:async()=>ctx,isUuid:()=>true,send:(res,status,body)=>{res.status=status;res.body=body;return body;},
    rows:async(_ctx,table)=>table==='contacts'?[{id:id(21),display_name:'Origem 1',is_lead:true},{id:id(31),display_name:'Destino 1',is_lead:true}]:[],
    allRows:async(_ctx,table,params)=>{
      reads.push({table,params});
      if(table==='whatsapp_link_suggestions')return suggestions;
      if(table==='messages'){messageReads++;if(failFirst&&messageReads===1)throw new Error('offline');const ids=params.chat_id.slice(4,-1).split(',');return messages.filter(row=>ids.includes(row.chat_id));}
      return [];
    },patchRows:async(_ctx,table,filters,body)=>{writes.push({table,filters,body});return[{id:filters.id.slice(3)}];},insert:async()=>{},jsonBody:async()=>({})};
  const handler=load('api/panel/whatsapp.js',{'../../panel-server':server,'../../whatsapp-maintenance':{resolveStoredItemErrors:async()=>{},recoverStalledEvents:async()=>{}},'../../whatsapp-receiver':{},'../../panel-triage':{activeRows:async()=>[]}},sourceRoot);
  const res={};await handler({method:'GET'},res);assert.equal(res.status,200);
  return {body:res.body,reads,writes,messageReads};
}
test('WhatsApp: mensagens lidas uma vez mantêm confirmação e recusa de Ref, nomes e ordem',async()=>{
  const result=await whatsapp();assert.equal(result.messageReads,1);
  assert.equal(result.body.suggestions.length,1);const suggestion=result.body.suggestions[0];
  assert.equal(suggestion.id,id(1));assert.equal(suggestion.refConfirmed,true);assert.equal(suggestion.sourceName,'Origem 1');assert.equal(suggestion.targetName,'Destino 1');
  assert.equal(result.writes.length,1);assert.equal(result.writes[0].filters.id,'eq.'+id(2));assert.deepEqual(result.writes[0].body.undo_json.writtenRefs,['ZZ678']);
});
test('WhatsApp: leitura vazia confirmada não gera nova consulta nem confirma Ref',async()=>{
  const result=await whatsapp({empty:true});assert.equal(result.messageReads,1);assert.equal(result.body.suggestions.length,2);
  assert.ok(result.body.suggestions.every(row=>row.refConfirmed===false));assert.equal(result.writes.length,0);
});
test('WhatsApp: falha da primeira leitura mantém tentativa de confirmação que já existia',async()=>{
  const result=await whatsapp({failFirst:true});assert.equal(result.messageReads,2);assert.equal(result.body.suggestions.length,2);
  assert.equal(result.body.suggestions[0].refConfirmed,true);assert.equal(result.body.suggestions[1].refConfirmed,false);assert.equal(result.writes.length,0);
});
test('WhatsApp: sem sugestões não lê mensagens nem cria trabalho adicional',async()=>{
  const result=await whatsapp({noSuggestions:true});assert.equal(result.messageReads,0);assert.equal(result.writes.length,0);assert.deepEqual(result.body.suggestions,[]);
});
test('WhatsApp A/B: resposta inteira e gravações idênticas, incluindo falha e ausência de mensagens', {skip:!process.env.PANEL_PERF_BASELINE},async()=>{
  const RealDate=Date,fixed=RealDate.parse('2026-10-11T04:00:00Z');
  global.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[fixed]));}static now(){return fixed;}};
  try {
    for(const scenario of [{},{empty:true},{failFirst:true},{noSuggestions:true}]){
      const before=await whatsapp(scenario,path.resolve(process.env.PANEL_PERF_BASELINE)),after=await whatsapp(scenario);
      assert.deepEqual(after.body,before.body);assert.deepEqual(after.writes,before.writes);
      assert.ok(after.messageReads<=before.messageReads);
    }
  } finally {global.Date=RealDate;}
});

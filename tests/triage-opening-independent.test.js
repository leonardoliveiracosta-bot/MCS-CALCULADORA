'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const root=path.resolve(process.env.PANEL_TRIAGE_BASELINE||path.join(__dirname,'..'));
const id=n=>'40000000-0000-4000-8000-'+String(n).padStart(12,'0');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve}};
const tick=()=>new Promise(done=>setImmediate(done));
function fixture({activeGate,chatGate}={}){
  const calls=[],ctx={environment:'preview'};
  const active=[{id:id(1),chat_id:id(2),journey_id:id(3),decision:'PENDENTE',category:'REVISAR',evidence_message_ids:[id(4)],created_at:'2026-10-10T12:00:00Z'}];
  const read=async(_ctx,table)=>{calls.push(table);if(table==='chats'){if(chatGate)await chatGate.promise;return[{id:id(2),contact_id:id(5)}]}
    if(table==='messages')return[{id:id(4),body_text:'Quero comprar um carro'}];if(table==='contacts')return[{id:id(5),display_name:'Contato fictício'}];return[]};
  const mocks={
    '../../panel-server':{requirePanel:async()=>ctx,allRows:read,rows:read,send:(res,status,body)=>{res.status=status;res.body=body}},
    '../../panel-triage':{activeRows:async()=>{if(activeGate)await activeGate.promise;return active},status:()=> 'LIGADA',LABELS:{REVISAR:'Revisar'},redact:text=>text},
    '../../panel-topic':{loadTopic:async()=>null},'../../panel-chat-groups':{chatGroupIndex:async()=>new Map()}
  };
  const mod={exports:{}};new Function('require','module','exports',fs.readFileSync(path.join(root,'api/panel/triage.js'),'utf8'))(name=>mocks[name],mod,mod.exports);
  const res={};return{calls,res,run:()=>mod.exports({method:'GET',query:{}},res)};
}
test('triagem: candidatos Fora da MCS começam sem esperar a leitura de classificações',async()=>{
  const gate=deferred(),f=fixture({activeGate:gate}),pending=f.run();await tick();
  try{assert.ok(f.calls.includes('panel_conversation_class'),'independent source started before active classifications finish')}
  finally{gate.resolve();await pending}
  assert.equal(f.res.status,200);assert.deepEqual(f.res.body.offMcs,[]);
});
test('triagem: citações começam junto com conversas e mantêm nome, texto e evidência',async()=>{
  const gate=deferred(),f=fixture({chatGate:gate}),pending=f.run();await tick();
  try{assert.ok(f.calls.includes('messages'),'evidence started before chats finish')}
  finally{gate.resolve();await pending}
  assert.equal(f.res.status,200);assert.equal(f.res.body.review.length,1);
  assert.equal(f.res.body.review[0].name,'Contato fictício');assert.deepEqual(f.res.body.review[0].evidence,['Quero comprar um carro']);
  assert.deepEqual(f.res.body.out,[]);assert.deepEqual(f.res.body.offTopic,[]);
});

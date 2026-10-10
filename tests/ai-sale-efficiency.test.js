'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const feedback=require('../panel-ai-feedback');
const unlock=require('../api/panel/unlock-sale');
const ctx={environment:'preview',panel:{id:'11111111-1111-4111-8111-111111111111'}};

test('suggestion measurement stores no customer text and checks author before accepting feedback',async()=>{
  const log=[],services={insert:async(_ctx,_table,row)=>{log.push(row);},rows:async(_ctx,_table,params)=>{
    assert.equal(params.actor_user_id,'eq.'+ctx.panel.id);assert.equal(params.environment,'eq.preview');return [log[0]];
  }};
  const id=await feedback.generated(ctx,{provider:'OpenAI',text:'Sensitive customer message',latencyMs:100,promptVersion:'test'},services);
  assert.ok(id);assert.ok(!JSON.stringify(log).includes('Sensitive customer message'));
  assert.deepEqual(await feedback.feedback(ctx,{suggestionId:id,event:'PICKED',text:'Changed sensitive message',editDistance:7},services),{ok:true});
  assert.equal(log[1].after_json.edited,true);assert.ok(!JSON.stringify(log).includes('Changed sensitive message'));
  assert.equal((await feedback.feedback(ctx,{suggestionId:id,event:'SENT',text:'x'},{rows:async()=>[]})).error,'AI_SUGGESTION_NOT_FOUND');
  assert.equal((await feedback.feedback(ctx,{suggestionId:id,event:'SALE',text:'x'},services)).error,'AI_FEEDBACK_INVALID');
  assert.equal(await feedback.generated(ctx,{provider:'Claude',text:'Hi',latencyMs:1},{insert:async()=>{throw Error('offline');}}),null);
});

test('measurement deduplicates repeated clicks and separates opening an app from confirmed sending',async()=>{
  const row=(type,id,action,metadata)=>({entity_type:type,entity_id:id,action,after_json:metadata});
  const data=[row('ai_sale_suggestion','a','GENERATED',{provider:'OpenAI',latencyMs:800}),row('ai_sale_suggestion','b','GENERATED',{provider:'Claude',latencyMs:1200}),
    row('ai_sale_feedback','a','PICKED',{edited:false,editDistance:0}),row('ai_sale_feedback','a','PICKED',{edited:true,editDistance:5}),
    row('ai_sale_feedback','a','OPENED_WHATSAPP',{edited:true,editDistance:5}),row('ai_sale_feedback','b','SENT',{edited:false,editDistance:0})];
  const out=await feedback.metrics(ctx,{allRows:async()=>data});
  assert.equal(out.providers[0].chosen,1);assert.equal(out.providers[0].edited,1);
  assert.equal(out.providers[0].sentByPanel,0);assert.equal(out.providers[0].openedWhatsApp,1);
  assert.equal(out.providers[0].meanEditDistance,5);assert.equal(out.providers[1].sentByPanel,1);
});

test('sale brief receives each actual request separately; CARRO never gains a bid requirement',()=>{
  const out=unlock.searchContext({maxBidCents:999999,searchRequests:[{mode:'CARRO',wishes:[{model:'X3',yearMin:2020}],bidCents:1230000},{mode:'VALOR',wishes:[{model:'Civic'}],bidCents:1000000}]});
  assert.deepEqual(out.tiposBusca,['POR_CARRO','POR_VALOR']);
  assert.equal(out.pedidos[0].lanceMaximo,undefined);assert.equal(out.pedidos[1].lanceMaximo,10000);
});

test('sale context excludes stale batches, expired Lane/Run and standalone Buy Now',async()=>{
  const future=new Date(Date.now()+86400000).toISOString(),past=new Date(Date.now()-86400000).toISOString();
  const offers=[{model:'Current',lane:'1',run:'12',startsAt:future},{model:'Expired',lane:'1',run:'13',startsAt:past},
    {model:'BuyNow',buyNowPrice:'10000'},{model:'GroupedExpired',purchaseOptions:[{lane:'1',run:'1',startsAt:past},{buyNowPrice:'12000'}]}];
  for(const batchActive of [true,false]){
    const out=await unlock.contextOf(ctx,{}, {ref:'ABC'},{leadData:async()=>({batchActive,offers,record:{conversation:[]},wishes:[],searchModes:['CARRO']})});
    assert.deepEqual(out.input.cliente.carrosNoLote.map(c=>c.modelo),batchActive?['Current']:[]);
  }
});

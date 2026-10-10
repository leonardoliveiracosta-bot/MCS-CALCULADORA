'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {record,exportTrace}=require('../panel-ai-observability');
const event={provider:'openai',model:'gpt-6-luna',environment:'production',feature:'V2_DRAFT',startedAt:1000,endedAt:1250,
  ok:true,costUsd:0.00015,result:{usage:{inputTokens:1000,outputTokens:100,secret:'never export'},payload:{choices:[{message:{content:'private customer answer'}}]}},
  subject:'private customer reference',prompt:'private conversation'};
const env={LANGFUSE_ENABLED:'true',LANGFUSE_PUBLIC_KEY:'pk-test',LANGFUSE_SECRET_KEY:'sk-test'};
test('Langfuse is inactive without explicit enablement; enabled export has only operational metadata',async()=>{
  let calls=0,body;
  const fetchImpl=async(url,options)=>{calls++;assert.equal(url.pathname,'/api/public/otel/v1/traces');assert.equal(options.headers['x-langfuse-ingestion-version'],'4');body=JSON.parse(options.body);return {ok:true};};
  assert.equal(await exportTrace(event,{env:{...env,LANGFUSE_ENABLED:'false'},fetchImpl}),false);assert.equal(calls,0);
  assert.equal(await exportTrace(event,{env,fetchImpl}),true);assert.equal(calls,1);
  const text=JSON.stringify(body);assert.ok(!text.includes('private'));assert.ok(!text.includes('secret'));assert.ok(!text.includes('sk-test'));
  const span=body.resourceSpans[0].scopeSpans[0].spans[0];assert.match(span.traceId,/^[a-f0-9]{32}$/);assert.equal(span.endTimeUnixNano,'1250000000');
  assert.equal(JSON.parse(span.attributes.find(a=>a.key.endsWith('cost_details')).value.stringValue).total,0.00015);
});
test('background observability failures never affect the AI response',async()=>{
  let task;
  assert.equal(record(event,{env,fetchImpl:async()=>{throw Error('offline');},waitUntil:p=>{task=p;}}),undefined);
  assert.equal(await task,false);
});

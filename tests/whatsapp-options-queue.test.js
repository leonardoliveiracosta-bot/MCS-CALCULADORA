'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {queueTimer,queueProbe,TOPIC}=require('../whatsapp-options-queue');
function response(){return {code:null,payload:null,status(code){this.code=code;return this;},json(payload){this.payload=payload;return this;},end(){return this;},setHeader(){}};}
test('deployed consumer is private with one queue subscription; recovery uses a protected minute cron',()=>{
  const config=require('../vercel.json'),trigger=config.functions['api/whatsapp/options-timer.js'];
  assert.deepEqual(trigger.experimentalTriggers,[{type:'queue/v2beta',topic:TOPIC,retryAfterSeconds:10}]);
  assert.equal(Object.values(config.functions).flatMap(f=>f.experimentalTriggers||[]).filter(t=>t.topic===TOPIC).length,1);
  assert.deepEqual(config.crons.find(c=>c.path==='/api/whatsapp/options-cron'),{path:'/api/whatsapp/options-cron',schedule:'* * * * *'});
});
async function isolated(run){
  const names=['VERCEL_ENV','VERCEL_DEPLOYMENT_ID','VERCEL_OIDC_TOKEN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','SUPABASE_SECRET_KEY','AUTO_REPLY_ENABLED','CRON_SECRET'],previous=names.map(n=>process.env[n]),beforeFetch=global.fetch;
  process.env.VERCEL_ENV='production';process.env.VERCEL_DEPLOYMENT_ID='dpl_unit_queue';
  process.env.VERCEL_OIDC_TOKEN='unit.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.unit';
  process.env.SUPABASE_URL='https://db.invalid';process.env.SUPABASE_PUBLISHABLE_KEY='unit';process.env.SUPABASE_SECRET_KEY='unit';process.env.AUTO_REPLY_ENABLED='false';process.env.CRON_SECRET='unit';
  try{await run();}finally{global.fetch=beforeFetch;names.forEach((n,i)=>{if(previous[i]===undefined)delete process.env[n];else process.env[n]=previous[i];});}
}
test('real Queue SDK serializes delayed timers, stable deduplication keys and deployment isolation',()=>isolated(async()=>{
  const requests=[];global.fetch=async(url,request)=>{requests.push({url:String(url),request});return Response.json({messageId:'timer.receipt'},{status:201});};
  const id='10000000-0000-4000-8000-000000000002';
  const dueAt=new Date(Date.now()+90000).toISOString();
  assert.equal((await queueTimer(id,'LINK',dueAt,'production')).messageId,'timer.receipt');
  await queueTimer(id,'LINK',dueAt,'production');await queueTimer(id,'EXPLANATION',new Date(Date.now()+35000).toISOString(),'production');
  const first=requests[0];assert.equal(first.url,'https://iad1.vercel-queue.com/api/v3/topic/'+TOPIC);assert.equal(first.request.method,'POST');
  assert.equal(first.request.headers.get('Vqs-Delay-Seconds'),'90');assert.equal(requests[2].request.headers.get('Vqs-Delay-Seconds'),'35');
  assert.equal(first.request.headers.get('Vqs-Idempotency-Key'),requests[1].request.headers.get('Vqs-Idempotency-Key'));
  assert.notEqual(first.request.headers.get('Vqs-Idempotency-Key'),requests[2].request.headers.get('Vqs-Idempotency-Key'));
  assert.equal(first.request.headers.get('Vqs-Retention-Seconds'),'600');assert.equal(first.request.headers.get('Vqs-Deployment-Id'),'dpl_unit_queue');
  assert.deepEqual(JSON.parse(Buffer.from(first.request.body).toString()),{jobId:id,step:'LINK',environment:'production'});
  const count=requests.length;await assert.rejects(queueTimer(id,'LINK','bad','production'),/TIMER_INVALID/);assert.equal(requests.length,count);
}));
test('real Node callback accepts queue v2 payload, acknowledges it and never dispatches when disabled',()=>isolated(async()=>{
  const requests=[];global.fetch=async(url,request)=>{requests.push({url:String(url),request});return new Response('',{status:200});};
  const callback=require('../api/whatsapp/options-timer');
  const req={method:'POST',body:{jobId:'10000000-0000-4000-8000-000000000002',step:'LINK',environment:'production'},headers:{
    'content-type':'application/json','ce-type':'com.vercel.queue.v2beta','ce-vqsqueuename':TOPIC,
    'ce-vqsconsumergroup':'unit-consumer','ce-vqsmessageid':'unit-timer','ce-vqsregion':'iad1','ce-vqsreceipthandle':'unit-receipt'
  }},res=response();
  await callback(req,res);assert.equal(res.code,200);assert.deepEqual(res.payload,{status:'success'});
  assert.equal(requests.length,1);assert.equal(requests[0].request.method,'DELETE');assert.match(requests[0].url,/vercel-queue[.]com\/api\/v3\/topic\/mcs-whatsapp-options\/consumer\/unit-consumer\/lease\/unit-receipt$/);
  assert.ok(requests.every(r=>!r.url.includes('360dialog')&&!r.url.includes('db.invalid')));
}));
test('timer recovery cron rejects unauthenticated requests and does no database or provider work',()=>isolated(async()=>{
  global.fetch=async()=>{throw Error('must not fetch');};
  const cron=require('../api/whatsapp/options-cron'),res=response();
  await cron({method:'GET',headers:{}},res);assert.equal(res.code,401);
  const ok=response();await cron({method:'GET',headers:{authorization:'Bearer unit'}},ok);assert.equal(ok.code,200);assert.deepEqual(ok.payload,{queued:0});
}));
test('operational timing probe has no job, contact or recipient and cannot dispatch a customer message',()=>isolated(async()=>{
  let payload;global.fetch=async(_url,request)=>{payload=JSON.parse(Buffer.from(request.body).toString());assert.equal(request.headers.get('Vqs-Delay-Seconds'),'35');return Response.json({messageId:'probe.receipt'},{status:201});};
  const probe=await queueProbe(35,'production');assert.equal(probe.messageId,'probe.receipt');assert.equal(payload.kind,'PROBE');assert.equal(payload.jobId,undefined);assert.equal(payload.phone,undefined);assert.equal(payload.contactId,undefined);
  const callback=require('../api/whatsapp/options-timer'),oldInfo=console.info;let log;
  try{
    console.info=(label,data)=>{log={label,data};};
    global.fetch=async(url,request)=>{
      if(String(url).startsWith('https://db.invalid/rest/v1/rpc/panel_whatsapp_options_probe_received')){
        assert.equal(JSON.parse(request.body).p_probe,probe.probeId);return Response.json({updated:true});
      }
      assert.ok(String(url).includes('vercel-queue.com'));assert.equal(request.method,'DELETE');return new Response('',{status:200});
    };
    const res=response();await callback({method:'POST',body:payload,headers:{'content-type':'application/json','ce-type':'com.vercel.queue.v2beta','ce-vqsqueuename':TOPIC,'ce-vqsconsumergroup':'unit-consumer','ce-vqsmessageid':'probe.receipt','ce-vqsreceipthandle':'receipt'}},res);
    assert.equal(res.code,200);assert.equal(log.label,'[whatsapp-options-probe]');assert.equal(log.data.probeId,probe.probeId);
  }finally{console.info=oldInfo;}
}));

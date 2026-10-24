'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {grantCookie,verifiedRef,PARTNER_URL,TTL}=require('../finance-handoff-server');
const ref='FNA23',id='f3eedafa-6b3d-4cca-801c-0b934f0d0e9c',secret='test-server-secret';
const req={method:'GET',headers:{host:'finance-preview.vercel.app'}};
const withCookie=cookie=>({...req,headers:{...req.headers,cookie:cookie.split(';')[0]}});
const response=()=>({status(c){this.code=c;return this;},json(data){this.data=data;return data;}});
function handler(server){const mod={exports:{}};new Function('require','module','exports',fs.readFileSync(path.join(__dirname,'../api/finance-handoff.js'),'utf8'))(name=>name==='../panel-server'?server:name==='./contact-request'?{originAllowed:r=>r.headers.origin==='https://finance-preview.vercel.app'}:require(path.resolve(__dirname,'../api',name)),mod,mod.exports);return mod.exports;}
test('handoff proof is signed, short-lived, host-bound, environment-bound and HttpOnly',()=>{
  const now=Date.now(),cookie=grantCookie(req,secret,'preview',ref,now);
  assert.match(cookie,/HttpOnly; Secure; SameSite=Lax/);assert.match(cookie,/Path=\/api\/finance-handoff/);
  assert.equal(verifiedRef(withCookie(cookie),secret,'preview',now),ref);
  assert.equal(verifiedRef(withCookie(cookie),secret,'production',now),null);
  assert.equal(verifiedRef(withCookie(cookie),secret,'preview',now+TTL),null);
  assert.equal(verifiedRef(withCookie(cookie),secret+'wrong','preview',now),null);
  assert.equal(verifiedRef({...withCookie(cookie),headers:{...withCookie(cookie).headers,host:'other.vercel.app'}},secret,'preview',now),null);
  assert.equal(verifiedRef(withCookie(cookie.replace(ref,'ABCDE')),secret,'preview',now),null);
  assert.equal(verifiedRef(withCookie('mcs_finance_handoff='+ref),secret,'preview',now),null);
});
test('departure POST requires proof and same-origin JSON, records the verified request only, and fails visibly',async()=>{
  const cookie=grantCookie(req,secret,'preview',ref),calls=[];
  let broken=false;
  const serve=handler({SERVER_ENVIRONMENT:'preview',configuration:()=>({url:'db',secretKey:secret}),isUuid:require('../panel-server').isUuid,jsonBody:async r=>r.body,supabase:async(_u,_k,url,options)=>{calls.push({url,options});if(url.includes('/rpc/')){if(broken)throw Error('DB');return {at:'2026-10-24T13:00:00Z',method:'manual'};}return url.includes('calc_runs')?[{id}]:[{id}];},send:(r,c,p)=>r.status(c).json(p)});
  const input={...withCookie(cookie),method:'POST',body:{method:'manual',ref:'WRONG',requestId:'forged'},headers:{...withCookie(cookie).headers,origin:'https://finance-preview.vercel.app','content-type':'application/json'}};
  for(const change of [{headers:{...input.headers,origin:'https://evil.example'}},{headers:{...input.headers,cookie:''}},{body:{method:'invalid'}}]){const before=calls.length,res=response();await serve({...input,...change},res);assert.ok([400,403].includes(res.code));assert.equal(calls.length,before);}
  const res=response();await serve(input,res);assert.equal(res.code,200);assert.equal(res.data.handedOffAt,'2026-10-24T13:00:00Z');assert.deepEqual(JSON.parse(calls.at(-1).options.body),{p_environment:'preview',p_request_key:id,p_method:'manual'});
  broken=true;const failed=response();await serve(input,failed);assert.equal(failed.code,503);assert.equal(failed.data.handedOffAt,undefined);
});
test('direct entry, a plain Ref and forged cookies never read private data or unlock the partner',async()=>{
  let reads=0;const serve=handler({SERVER_ENVIRONMENT:'preview',configuration:()=>({url:'db',secretKey:secret}),supabase:async()=>{reads++;throw Error('must not read');},send:(r,c,p)=>r.status(c).json(p)});
  for(const input of [req,{...req,query:{ref}},withCookie('mcs_finance_handoff='+ref)]){const res=response();await serve(input,res);assert.deepEqual(res.data,{authorized:false});}assert.equal(reads,0);
});
test('valid proof still requires the saved calculator request and consenting contact in the same environment',async()=>{
  for(const state of ['saved','no-contact','no-run','db-error']){
    const calls=[],serve=handler({SERVER_ENVIRONMENT:'preview',configuration:()=>({url:'db',secretKey:secret}),isUuid:require('../panel-server').isUuid,supabase:async(_u,_k,url)=>{calls.push(url);if(state==='db-error')throw Error('DB');if(url.includes('calc_runs'))return state==='no-run'?[]:[{id,dados:{ref}}];return state==='no-contact'?[]:[{id}];},send:(r,c,p)=>r.status(c).json(p)});
    const res=response();await serve(withCookie(grantCookie(req,secret,'preview',ref)),res);
    assert.equal(res.code,state==='db-error'?503:200);
    if(state==='saved'){assert.deepEqual(res.data,{authorized:true,destination:PARTNER_URL});assert.ok(calls[0].includes('is_test=eq.true'));assert.ok(calls[1].includes('environment=eq.preview'));assert.ok(calls[1].includes('consent_version=eq.finance-contact-v1'));}else assert.ok(!res.data.authorized);
    assert.doesNotMatch(JSON.stringify(res.data),/phone|name|dados|request_key/);
  }
});

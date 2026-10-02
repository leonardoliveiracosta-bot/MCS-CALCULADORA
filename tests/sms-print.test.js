'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {candidate,detectedImage}=require('../panel-sms-print');
const root=path.join(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

test('SMS print accepts only real image signatures',()=>{
  assert.equal(detectedImage('text.png','image/png',16,Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0])),'image/png');
  assert.equal(detectedImage('text.png','image/png',16,Buffer.from('not an image')),null);
  assert.equal(detectedImage('print.pdf','application/pdf',16,Buffer.from('%PDF-1.7')),null);
});

test('SMS print candidates keep only a valid number and Ref',()=>{
  assert.deepEqual(candidate({phone:'(786) 555-0192',name:'Patricia',ref:'l5lbd',message:'Hi',translation:'Oi'}),{phone:'+17865550192',name:'Patricia',ref:'L5LBD',message:'Hi',translation:'Oi'});
  assert.deepEqual(candidate({phone:'not a phone',ref:'OOOOO',message:'  full text  '}),{phone:'',name:'',ref:'',message:'full text',translation:''});
  assert.equal(candidate({name:'A'}).name,'');
  assert.equal(candidate({name:'  · A  '}).name,'');
});

test('SMS print normalizes an already formatted existing US phone before duplicate lookup',()=>{
  assert.equal(candidate({phone:'+1 (305) 540-0742'}).phone,'+13055400742');
  assert.equal(candidate({phone:'305.540.0742'}).phone,'+13055400742');
});

test('SMS print uses the shared attachment validator and one Anthropic content block list',()=>{
  const reader=read('panel-sms-print.js');
  assert.match(reader,/validateAttachment/);
  assert.match(reader,/await reservePrintRead\(ctx\)/);
  assert.doesNotMatch(reader,/reserveCall/);
  assert.match(reader,/anthropicJson\(/);
  assert.match(reader,/type:'image'/);
  assert.match(reader,/type:'text'/);
});

test('discard keeps the screenshot in quarantine and AI failure opens a manual-ready review',()=>{
  const api=read('api/panel/sms-print.js');
  const discard=api.match(/if\(body\.action==='discard'\)[\s\S]*?return send\(res,200,\{discarded:true\}\);/)[0];
  assert.doesNotMatch(discard,/method:'DELETE'/);
  assert.match(api,/status:'READY',extracted_json:\{\},error_code/);
  assert.match(api,/manual:true/);
});

test('automatic print routes a different existing Ref without asking',()=>{
  const api=read('api/panel/sms-print.js');
  const client=read('painel/painel.js');
  assert.match(api,/automaticTarget/);
  assert.match(api,/byRef&&\(!record\.source_journey_id\|\|byRef\.id!==record\.source_journey_id\)/);
  assert.match(client,/action:'confirm',auto:true/);
  assert.doesNotMatch(client,/Gravar neste lead mesmo assim/);
});

test('card UI preserves the missing-phone and missing-SMS paths',()=>{
  const client=read('painel/painel.js');
  assert.match(client,/📞 falta o número/);
  assert.match(client,/Falta o print do SMS/);
  assert.match(client,/Não chegou SMS/);
});

test('SMS print reads count on their own daily counter (no cap) and reserve the Claude prepaid balance first',async()=>{
  const {readPrint}=require('../panel-sms-print');
  const ctx={environment:'preview',config:{url:'https://banco.test',secretKey:'segredo-simulado'}};
  const png=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  const saved={fetch:globalThis.fetch,key:process.env.ANTHROPIC_API_KEY,model:process.env.ANTHROPIC_MODEL};
  process.env.ANTHROPIC_API_KEY='chave-simulada';process.env.ANTHROPIC_MODEL='modelo-simulado';
  const calls=[];let held=true;
  const answer=(payload)=>new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});
  globalThis.fetch=async(url)=>{const path=String(url);calls.push(path);
    if(path.endsWith('panel_anthropic_budget_hold'))return answer(held?{held:true,id:'reserva-1'}:{held:false,reason:'SALDO_INSUFICIENTE'});
    if(path.endsWith('panel_anthropic_budget_settle'))return answer({settled:true});
    return answer({allowed:true,count:1});};
  let anthropicCalls=0;
  const anthropic=async()=>{anthropicCalls++;return new Response(JSON.stringify({content:[{type:'text',text:'{"phone":"+13055550100","name":"Ana","ref":"","message":"Oi","translation":""}'}],usage:{input_tokens:900,output_tokens:40}}),{status:200});};
  try{
    const read=await readPrint(ctx,png,'image/png',anthropic);
    assert.equal(read.phone,'+13055550100');
    assert.deepEqual(calls.map((url)=>url.replace('https://banco.test/rest/v1/rpc/','')),['panel_sms_print_reserve_read','panel_anthropic_budget_hold','panel_anthropic_budget_settle']);
    assert.ok(!calls.some((url)=>url.includes('panel_ai_reserve_call')));
    // Without prepaid balance left the provider is never called.
    held=false;calls.length=0;
    await assert.rejects(readPrint(ctx,png,'image/png',anthropic),/AI_UNAVAILABLE/);
    assert.equal(anthropicCalls,1);
  }finally{globalThis.fetch=saved.fetch;for(const [k,v] of [['ANTHROPIC_API_KEY',saved.key],['ANTHROPIC_MODEL',saved.model]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});

test('a failed print read tells the operator why (daily limit vs. reading failure)',()=>{
  const panel=read('painel/painel.js');
  assert.match(panel,/function printReadFailText\(code\)/);
  assert.match(panel,/SMS_PRINT_DAILY_LIMIT:'Limite de leituras de print do dia atingido/);
  assert.match(panel,/printReadFailText\(result\.read\?\.error_code\)/);
  assert.match(panel,/printReadFailText\(print\.errorCode\)/);
});

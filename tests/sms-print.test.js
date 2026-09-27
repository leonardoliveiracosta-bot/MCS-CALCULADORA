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
});

test('SMS print normalizes an already formatted existing US phone before duplicate lookup',()=>{
  assert.equal(candidate({phone:'+1 (305) 540-0742'}).phone,'+13055400742');
  assert.equal(candidate({phone:'305.540.0742'}).phone,'+13055400742');
});

test('SMS print uses the shared attachment validator and one Anthropic content block list',()=>{
  const reader=read('panel-sms-print.js');
  assert.match(reader,/validateAttachment/);
  assert.match(reader,/await reserveCall\(ctx\)/);
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

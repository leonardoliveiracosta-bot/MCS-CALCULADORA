'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {candidate,detectedImage}=require('../panel-sms-print');

test('SMS print accepts only real image signatures',()=>{
  assert.equal(detectedImage('text.png','image/png',16,Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0])),'image/png');
  assert.equal(detectedImage('text.png','image/png',16,Buffer.from('not an image')),null);
  assert.equal(detectedImage('print.pdf','application/pdf',16,Buffer.from('%PDF-1.7')),null);
});

test('SMS print candidates keep only a valid number and Ref',()=>{
  assert.deepEqual(candidate({phone:'(786) 555-0192',name:'Patricia',ref:'l5lbd',message:'Hi',translation:'Oi'}),{phone:'+17865550192',name:'Patricia',ref:'L5LBD',message:'Hi',translation:'Oi'});
  assert.deepEqual(candidate({phone:'not a phone',ref:'OOOOO',message:'  full text  '}),{phone:'',name:'',ref:'',message:'full text',translation:''});
});

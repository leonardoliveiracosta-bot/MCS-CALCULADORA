'use strict';
process.env.VERCEL_ENV='preview';
process.env.ANTHROPIC_API_KEY='test-key';
process.env.ANTHROPIC_MODEL='test-model';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const domain=require('../panel-domain');
const note=require('../panel-note');
const root=path.join(__dirname,'..');
const ids={journey:'11111111-1111-4111-8111-111111111111',contact:'22222222-2222-4222-8222-222222222222',chat:'33333333-3333-4333-8333-333333333333',customer:'44444444-4444-4444-8444-444444444444',actor:'55555555-5555-4555-8555-555555555555'};

function loadWith(relative,mocks){const file=path.join(root,relative),mod={exports:{}};const localRequire=(name)=>Object.prototype.hasOwnProperty.call(mocks,name)?mocks[name]:name==='../../panel-capture'?{runCaptureCheck:async()=>({missingRefs:[]}),recordCaptureFailure:async()=>{}}:require(name.startsWith('.')?path.resolve(path.dirname(file),name):name);new Function('require','module','exports',fs.readFileSync(file,'utf8'))(localRequire,mod,mod.exports);return mod.exports;}
function response(){return {code:0,payload:null,setHeader(){},status(code){this.code=code;return this;},json(payload){this.payload=payload;return payload;}};}
function aiResponse(value){return {ok:true,json:async()=>({content:[{type:'text',text:JSON.stringify(value)}]})};}
function fixture(mcsCount,{withRef=true}={}){
  const customerAt=new Date(Date.now()-11*60000).toISOString();
  con¶»§q«^
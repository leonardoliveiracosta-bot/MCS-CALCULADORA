'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const root=path.join(__dirname,'..');
const read=(file)=>fs.readFileSync(path.join(root,file),'utf8');

class FakeNode {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.listeners={};this.className='';this.textContent='';this.disabled=false;this.isConnected=true;this.parentNode=null;}
  append(...values){for(const value of values){if(value&&typeof value==='object'){value.parentNode=this;this.children.push(value);}}}
  addEventListener(name,listener){(this.listeners[name]||(this.listeners[name]=[])).push(listener);}
  click(){const event={preventDefault(){},stopPropagation(){}};return this.listeners.click?.[0]?.(event);}
  closest(){return null;}
  setAttribute(){}
  remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter((child)=>child!==this);this.isConnected=false;}
  querySelectorAll(selector){const key=/data-action-key="([^"]+)"/.exec(selector)?.[1];const found=[];const visit=(node)=>{for(const child of node.children){if(String(child.className).includes('action-feedback')&&(!key||child.dataset.actionKey===key))found.push(child);visit(child);}};visit(this);return found;}
}

function actionRuntime(){
  const body=new FakeNode('body');
  const context={window:{},document:{body,createElement:(tag)=>new FakeNode(tag)},Promise,setTimeout,clearTimeout};
  vm.runInNewContext(read('painel/action.js'),context,{filename:'painel/action.js'});
  return{action:context.window.MCSAction,body};
}

test('helper applies the optimistic state immediately and blocks a double click',async()=>{
  const{action,body}=actionRuntime(),button=new FakeNode('button');body.append(button);
  let release,posts=0,optimistic=false;
  const pending=new Promise((resolve)=>{release=resolve;});
  action.bind(button,()=>({scope:body,optimistic:()=>{optimistic=true;},commit:()=>{posts++;return pending;}}));
  const first=button.click();
  assert.equal(optimistic,true);
  assert.equal(button.disabled,true);
  await button.click();
  assert.equal(posts,1);
  release({saved:true});
  await first;
  assert.equal(button.disabled,false);
});

test('helper rolls back a failed optimistic action and shows the required card error',async()=>{
  const{action,body}=actionRuntime(),button=new FakeNode('button');body.append(button);
  let visible=true;
  action.bind(button,()=>({scope:body,optimistic:()=>{visible=false;return true;},commit:()=>Promise.reject(new Error('offline')),rollback:()=>{visible=true;}}));
  await button.click();
  assert.equal(visible,true);
  assert.equal(button.disabled,false);
  assert.equal(body.children.at(-1).textContent,'Não consegui salvar — tente de novo');
});

test('helper undo sends and restores the exact previous disposition',async()=>{
  const{action,body}=actionRuntime(),button=new FakeNode('button');body.append(button);
  const sent=[];
  action.bind(button,()=>({scope:body,successText:'Marcado como Descartado',commit:async()=>{sent.push('DISCARDED');return{status:'DISCARDED'};},undo:{commit:async()=>{sent.push('TREATED');},successText:'Ação desfeita.'}}));
  await button.click();
  const notice=body.children.find((child)=>String(child.className).includes('action-feedback'));
  const undo=notice.children.find((child)=>child.tagName==='BUTTON');
  await undo.click();
  assert.deepEqual(sent,['DISCARDED','TREATED']);
});

test('all mutating panel flows are wired through the single action helper',()=>{
  const panel=read('painel/painel.js'),lead=read('painel/lead.js'),action=read('painel/action.js'),entry=read('api/panel/entry.js');
  assert.match(read('painel/index.html'),/action\.js[\s\S]*lead\.js[\s\S]*painel\.js/);
  assert.match(action,/running\.has\(button\)/);
  assert.match(action,/options\.optimistic/);
  assert.match(action,/options\.rollback/);
  assert.match(action,/Não consegui salvar — tente de novo/);
  for(const marker of ['setDisposition','review_link','review_create','review_dismiss','automatic-messages','phone_review','toggle_journey','manheim_upload','sms-print','increase_budget'])assert.match(panel+read('painel/manheim-upload.js'),new RegExp(marker.replace('-','\\-')));
  assert.match(panel,/MCSAction\.(?:bind|run)/);
  assert.match(lead,/MCSAction\.bind/);
  assert.match(entry,/undone_at/);
  assert.doesNotMatch(panel,/addEventListener\('click',\s*async[\s\S]{0,180}action:'set_disposition'/);
});

test('newer customer activity reopens HOJE but older activity does not',()=>{
  const today=read('api/panel/today.js');
  assert.match(today,/eventAfterDisposition/);
  assert.match(today,/Number\(eventAt \|\| 0\) > \(time\(dispositionAt\) \|\| 0\)/);
  assert.match(today,/wantedAtByRef/);
  assert.match(today,/returnedForJourney/);
});

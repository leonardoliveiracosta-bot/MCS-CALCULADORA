'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const createReadBudget=require('../panel-read-budget');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('boot read budget bounds concurrency, keeps FIFO and returns every result',async()=>{
 const budget=createReadBudget(3),started=[],release=[];
 const pending=Array.from({length:12},(_,i)=>budget.run(()=>new Promise(resolve=>{started.push(i);release.push(()=>resolve(i));})));
 await tick();assert.deepEqual(started,[0,1,2]);
 for(let i=0;i<12;i++){release[i]();await tick();assert.ok(started.length<=i+4);}
 assert.deepEqual(started,Array.from({length:12},(_,i)=>i));assert.deepEqual(await Promise.all(pending),started);
});
test('failed or synchronously thrown reads release slots and do not block later reads',async()=>{
 const budget=createReadBudget(1);
 const a=budget.run(()=>{throw new Error('first');});
 const b=budget.run(()=>Promise.reject(new Error('second')));
 const c=budget.run(()=>17);
 const result=await Promise.allSettled([a,b,c]);
 assert.equal(result[0].status,'rejected');assert.equal(result[1].status,'rejected');assert.deepEqual(result[2],{status:'fulfilled',value:17});
});

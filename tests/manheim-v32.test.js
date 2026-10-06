'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const match=require('../vehicle-match'),catalog=require('../vehicle-catalog'),requests=require('../vehicle-requests'),batch=require('../panel-manheim-batch');
const sql=fs.readFileSync(require.resolve('../supabase/migrations/20261021010000_manheim_regras_v32.sql'),'utf8');
const aliases=JSON.parse(sql.split('$aliases$')[1]);
catalog.configureAliases(aliases,[],'test-v32');
const car=(patch={})=>({year:2020,make:'Toyota',model:'Camry',miles:40000,mmrCents:2000000,lane:'2',run:'3',conditionGrade:'3.0',...patch});
const find=(patch={})=>({mode:'CARRO',wishes:[{make:'Toyota',model:'Camry',yearMin:2019,...patch}]});
const valor=(budget=25000,patch={})=>({mode:'VALOR',bidCents:budget*100,wishes:[{make:'Toyota',model:'Camry',...patch}]});
test('v3.2 grade, title, MMR and sale eligibility are independent rules',()=>{
 for(const grade of ['0.0','1.8',0]) assert.equal(match.matchDemand(car({conditionGrade:grade}),find()),null);
 for(const grade of ['','1.9','5',null]) assert.ok(match.matchDemand(car({conditionGrade:grade}),find()));
 assert.equal(match.matchDemand(car({titleStatus:'Salvage'}),find()),null);
 assert.ok(match.matchDemand(car({titleStatus:'Salvage',conditionGrade:'0'}),find({acceptAnyTitleCondition:true})));
 for(const mmrCents of [null,0,-10,'N/A']) assert.equal(match.matchDemand(car({mmrCents}),find({acceptAnyTitleCondition:true})),null);
 assert.ok(match.matchDemand(car({lane:'',run:'',buyNowPrice:'21,000'}),find()));
 assert.equal(match.matchDemand(car({lane:'',run:'',buyNowPrice:'',saleType:'Make Offer'}),find()),null);
 assert.match(match.matchDemand(car({buyNowPrice:'30000'}),valor()).notice,/Buy Now acima do lance/);
});
test('v3.2 FIND year-only and model/mileage; no MMR floor and no guessed mileage',()=>{
 assert.ok(match.matchDemand(car({make:'Nissan',model:'Altima',year:2012,mmrCents:150000,miles:250000}),{mode:'CARRO',wishes:[{model:'Altima',yearMin:2010,yearMax:2016}]}));
 assert.ok(match.matchDemand(car({miles:null}),find()));
 assert.ok(match.matchDemand(car({year:1990}),{mode:'CARRO',wishes:[{model:'Camry',maxMiles:50000}]}));
 assert.equal(match.matchDemand(car({year:new Date().getUTCFullYear()+2}),find()),null);
 // 99 < 100 but >= floor(100×0,85): inside the widened search; below it: out.
 assert.equal(match.matchDemand(car({miles:99}),find({minMiles:100})).kind,'BATE');
 assert.equal(match.matchDemand(car({miles:84}),find({minMiles:100})),null);
});
test('v3.2 VALOR exact bands, floor, four mileage caps and tighter client cap',()=>{
 for(const [usd,min,max] of [[3000,2100,3450],[60000,42000,69000],[60001,45000.75,66001.1]]){
  for(const dollars of [min,max]) assert.ok(match.matchDemand(car({mmrCents:Math.round(dollars*100)}),valor(usd)));
  for(const cents of [Math.ceil(min*100)-1,Math.floor(max*100)+1])assert.equal(match.matchDemand(car({mmrCents:cents}),valor(usd)),null);
 }
 assert.equal(match.matchDemand(car({mmrCents:174999}),valor(2000)),null);
 for(const [usd,cap] of [[10000,135000],[10001,115000],[20000,115000],[20001,105000],[30000,105000],[30001,95000]]){
  assert.ok(match.matchDemand(car({mmrCents:usd*100,miles:cap}),valor(usd)));
  assert.equal(match.matchDemand(car({mmrCents:usd*100,miles:cap+1}),valor(usd)),null);
 }
 assert.equal(match.matchDemand(car({miles:100001}),valor(25000,{maxMiles:100000})),null);
 assert.ok(match.matchDemand(car({mmrCents:900000}),valor(25000,{budgetUsd:9000})));
});
test('v3.2 fallback only after complete lot, with budget and fees labels',()=>{
 const demand=find({budgetUsd:25000,notes:'value includes shipping and fees',maxMiles:35000});
 const expensive=car({mmrCents:4000000,miles:30000}),affordable=car({mmrCents:2500000,miles:30000});
 let found=match.matchLot([expensive],demand);assert.equal(found.length,1);assert.equal(found[0].result.budgetFallback,true);assert.match(found[0].result.notice,/acima do valor informado/);assert.match(found[0].result.notice,/inclui frete\/taxas/);
 found=match.matchLot([expensive,affordable],demand);assert.deepEqual(found.map(x=>x.index),[1]);
 const snap=batch.snapshotTargets([{...demand,key:'journey:x:CARRO',targetType:'JOURNEY',journeyId:'x'}]);
 const entries=[expensive,affordable].map((vehicle,i)=>({vehicle,mmrCents:vehicle.mmrCents,makeKey:'toyota',fingerprint:'vin:'+i}));
 assert.equal(batch.matchChunk(entries,snap).length,1);assert.equal(batch.matchChunk(entries,snap,undefined,{staging:true}).length,2);
});
test('v3.2 dynamic aliases, directional versions and strict different models',()=>{
 const yes=[['Mercedes-AMG GT','AMG GT','Mercedes-Benz'],['Escalade ESV','Escalade','Cadillac'],['Hardtop','MINI Cooper','MINI'],['Flying Spur','Flying spurs','Bentley'],['Super Duty F-250 SRW','F-250 Super Duty','Ford']];
 yes.forEach(([a,b,m])=>assert.ok(catalog.modelsMatch(a,b,m,m),a+' / '+b));
 const no=[['Escalade','Escalade ESV','Cadillac'],['Range Rover Sport','Range Rover','Land Rover'],['GL-Class','GLC','Mercedes-Benz'],['Mustang Mach-E','Mustang','Ford'],['Corolla Cross','Corolla','Toyota']];no.forEach(([a,b,m])=>assert.equal(catalog.modelsMatch(a,b,m,m),false));
 assert.ok(catalog.modelsMatch('Hardtop','MINI Cooper','MINI',''));
 assert.equal(catalog.recognized('Xyz','Toyota'),false);
 catalog.configureAliases([...aliases,{make:'Toyota',client_model:'Xyz',target_make:'Toyota',manheim_models:['Camry'],kind:'EQUIVALENT'}],[],'new');
 assert.ok(catalog.recognized('Xyz','Toyota'));assert.ok(catalog.modelsMatch('Camry','Xyz','Toyota','Toyota'));catalog.configureAliases(aliases,[],'test-v32');
});
test('v3.2 only exclusively location/trim review is non-blocking',()=>{
 for(const reason of ['Sem evidência verificável para: localização','Sem evidência verificável para: versão','Falta localização e versão'])assert.equal(requests.blockingReview(true,reason),false,reason);
 for(const reason of ['Sem evidência verificável para: localização, orçamento','Ano ambíguo e falta versão','',null])assert.equal(requests.blockingReview(true,reason),true,reason);
 assert.equal(requests.describe({criteria:{model:'Camry',yearMin:2020}}).comparable,true);
 assert.equal(requests.searchModeOf({model:'Camry',maxMiles:50000}),'CARRO');assert.equal(requests.searchModeOf({model:'Camry',maxMiles:100000,budgetUsd:25000}),'VALOR');
});
test('v3.2 VIN + lane/run dedup keeps different auction entries',()=>{
 const parser=require('../painel/manheim');const a=car({vin:'19XFA1F53BE031124'}),b={...a,lane:'4'};
 assert.notEqual(parser.fingerprint(a),parser.fingerprint(b));assert.equal(parser.chooseAuctionRows([a,a,b]).length,2);
});

test('v3.3 FIND with budget keeps cheaper cars and only warns above the ceiling',()=>{
 const demand=find({budgetUsd:25000});
 for(const [amounts,expected,fallback] of [
  [[15000,24000],[15000,24000],false],
  [[15000],[15000],false],
  [[30000],[30000],true],
  [[28000,40000],[28000],false],
  [[1500,24000],[1500,24000],false]
 ]){
  const cars=amounts.map(usd=>car({year:2019,mmrCents:usd*100}));
  const found=match.matchLot(cars,demand);
  assert.deepEqual(found.map(x=>cars[x.index].mmrCents/100),expected);
  for(const {result} of found){
   assert.equal(result.budgetFallback,fallback);
   assert.equal(/acima do valor informado/.test(result.notice||''),fallback);
  }
 }
 const fees=match.matchLot([car({mmrCents:1500000})],find({budgetUsd:25000,notes:'inclui frete e taxas'}))[0].result;
 assert.match(fees.notice,/valor informado inclui frete\/taxas/);
 assert.doesNotMatch(fees.notice,/acima do valor informado/);
 for(const mmrCents of [null,0,-1,'N/A'])assert.equal(match.matchLot([car({mmrCents})],demand).length,0);
 assert.equal(match.RULE_VERSION,'manheim-v3.4');
});

test('v3.3 FIND ceiling edges, VALOR lower bounds and batch-wide fallback stay independent',()=>{
 for(const [budget,ceiling] of [[2500000,2875000],[6000000,6900000],[6000100,6600110]]){
  assert.equal(match.withinClientBudget(1,budget),true);
  assert.equal(match.withinClientBudget(ceiling,budget),true);
  assert.equal(match.withinClientBudget(ceiling+1,budget),false);
 }
 assert.equal(match.matchDemand(car({mmrCents:1500000}),valor(25000)),null);
 assert.equal(match.matchDemand(car({mmrCents:5000000}),valor(80000)),null);
 assert.ok(match.matchDemand(car({mmrCents:6000000}),valor(80000)));
 const [target]=batch.snapshotTargets([{...find({budgetUsd:25000}),key:'journey:x:CARRO',targetType:'JOURNEY',journeyId:'x'}]);
 const entries=[15000,24000,40000].map((usd,i)=>({vehicle:car({mmrCents:usd*100}),mmrCents:usd*100,makeKey:'toyota',fingerprint:'vin:'+i}));
 const found=batch.matchChunk(entries,[target]);
 assert.deepEqual(found.map(m=>m.mmrCents),[1500000,2400000]);
 assert.ok(found.every(m=>!m.vehicle.parsed.budgetFallback));
 assert.equal(batch.matchChunk(entries,[target],undefined,{staging:true}).length,3);
 const audit=require('../panel-manheim-audit');
 assert.match(audit.INSTRUCTIONS,/Não existe limite inferior/);
 assert.doesNotMatch(audit.INSTRUCTIONS,/faixa de MMR igual a VALOR/);
});

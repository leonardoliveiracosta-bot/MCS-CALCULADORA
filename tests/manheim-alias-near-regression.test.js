'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBackend}=require('./fixtures/banco-simulado');
const catalog=require('../vehicle-catalog'),match=require('../vehicle-match');
let backend;
test.before(async()=>{
  backend=await createBackend();
  const {rows}=await backend.db.query('select public.panel_model_dictionary() dictionary');
  const d=rows[0].dictionary;catalog.configureAliases(d.aliases,d.known,d.revision);
});
test.after(async()=>{await backend.db.close();});
const car=(fields={})=>({make:'Ford',model:'F-150',trim:'Raptor SuperCrew',year:2021,miles:60000,mmrCents:4000000,lane:'2',run:'3',conditionGrade:'3.0',cleanTitle:true,...fields});
const find=(make,model,fields={})=>({mode:'CARRO',wishes:[{make,model,yearMin:2018,yearMax:2026,minMiles:1000,maxMiles:120000,...fields}]});
test('aliases EQUIVALENT são direcionais e as versões exigem seu trim, inclusive sem marca',()=>{
  for(const [make,wanted,model,trim,wrong] of [
    ['Ford','Raptor','F-150','Raptor SuperCrew','XLT'],
    ['BMW','M550i','5 Series','M550i xDrive','530i'],
    ['BMW','M340i','3 Series','M340i xDrive','330i'],
    ['Lexus','ES 300h','ES','300h Luxury','350 Luxury'],
    ['','GLE 450','GLE','450 4MATIC','350 4MATIC']
  ]){
    const vehicle=car({make:make||'Mercedes-Benz',model,trim}),demand=find(make,wanted);
    assert.ok(catalog.recognized(wanted,make),'reconhecimento do pedido não exige trim de inventário');
    assert.ok(match.matchDemand(vehicle,demand));
    assert.equal(match.matchDemand({...vehicle,trim:wrong},demand),null);
    assert.equal(match.matchDemand({...vehicle,trim:''},demand),null);
    assert.equal(match.matchCarroNear({...vehicle,trim:wrong,miles:1},demand),null);
    assert.ok(match.matchDemand(vehicle,demand),'cache de modelo não contamina a restrição de versão');
  }
  for(const model of ['Defender','Defender 90','Defender 110','Defender 130'])
    assert.ok(match.matchDemand(car({make:'Land Rover',model,trim:'S'}),find('Land Rover','Defender')));
  assert.equal(match.matchDemand(car({make:'Land Rover',model:'Discovery'}),find('Land Rover','Defender')),null);
  assert.equal(match.matchDemand(car({make:'Land Rover',model:'Defender 90'}),find('Land Rover','Defender 110')),null);
});
test('abaixo do mínimo é somente Próximo; exato, máximo e os controles de qualidade não mudam',()=>{
  for(const [make,model,year,miles,min,max] of [
    ['McLaren','GT',2023,4092,5000,35000],
    ['Rolls-Royce','Wraith',2017,21881,25000,55000],
    ['Porsche','911',2023,2200,20000,100000],
    ['McLaren','570',2018,1,1000,35000]
  ]){
    const wanted=model==='570'?'570S':model,demand=find(make,wanted,{yearMin:year,yearMax:year,minMiles:min,maxMiles:max});
    const vehicle=car({make,model,year,miles});
    assert.equal(match.matchDemand(vehicle,demand),null);
    const near=match.matchCarroNear(vehicle,demand);
    assert.equal(near?.near,true);assert.equal(near?.basis,'CRITERIA_NEAR');
    for(const bad of [{miles:null},{miles:-1},{miles:Math.floor(max*115/100)+1},{year:year-2},{mmrCents:null},{conditionGrade:'1.8'},{cleanTitle:false},{lane:'',run:'',buyNowPrice:''}])
      assert.equal(match.matchCarroNear({...vehicle,...bad},demand),null,JSON.stringify(bad));
    assert.equal(match.matchCarroNear(vehicle,{...demand,mode:'VALOR'}),null);
  }
});
test('720S respeita exatamente o teto de +15%; Próximo nunca amplia o valor informado',()=>{
  const demand=find('McLaren','720S',{yearMin:2018,yearMax:2021,minMiles:5000,maxMiles:15000});
  const vehicle=car({make:'McLaren',model:'720S',year:2018,miles:16900,mmrCents:18800000});
  assert.equal(match.matchDemand(vehicle,demand),null);
  assert.equal(match.matchCarroNear(vehicle,demand)?.near,true);
  assert.equal(match.matchCarroNear({...vehicle,miles:17250},demand)?.near,true);
  assert.equal(match.matchCarroNear({...vehicle,miles:17251},demand),null);
  assert.equal(match.matchCarroNear(vehicle,find('McLaren','720S',{...demand.wishes[0],budgetUsd:100000,budgetExplicit:true})),null);
});

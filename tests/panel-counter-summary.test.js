'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {requestsSummary, optionsSummary} = require('../panel-counter-summary');

test('resumo de pedidos preserva a regra do badge e todos os dados usados por Completar pedido', () => {
  const states = ['PRECISA_DETALHE','PRECISA_REVISAO','FALTA_BUSCAR','COM_OPCOES','SEM_OPCAO'];
  const items = states.flatMap((state) => ['VALOR','CARRO',null].map((searchMode,index) => ({key:state+index,state,searchMode,person:{journeyId:'a',contactId:'b',name:'Cliente'},lacksText:'Falta ano',missing:['Ano'],criteriaText:'BMW X5',source:'FICHA',evidence:['historico pesado'],editWishes:[{}]})));
  const result=requestsSummary(items);
  assert.equal(result.requestCount,items.filter(i=>i.state!=='PRECISA_DETALHE'&&i.state!=='PRECISA_REVISAO'&&['VALOR','CARRO'].includes(i.searchMode)).length);
  const incomplete=x=>(x.items||[]).filter(i=>i.state==='PRECISA_DETALHE').map(i=>({key:i.key,journeyId:i.person.journeyId,contactId:i.person.contactId,name:i.person.name,lacksText:i.lacksText,missing:i.missing,criteriaText:i.criteriaText,source:i.source}));
  assert.deepEqual(incomplete(result),incomplete({items}));
  assert.equal(result.items.length,3);
  assert.ok(result.items.every(i=>!i.evidence&&!i.editWishes));
});

test('contador de opções conta a mesma pessoa uma vez, mesmo com dois modos; inclui Ref sem ficha', () => {
  assert.equal(optionsSummary([{journeyId:'a',matchCount:4},{journeyId:'a',matchCount:8},{journeyId:'b',matchCount:0},{ref:'abcde',matchCount:3},{ref:'ABCDE',matchCount:1}]).peopleWithOptions,2);
});

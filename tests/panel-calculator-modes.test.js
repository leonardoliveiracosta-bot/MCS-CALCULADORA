'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const modes=require('../panel-calculator-modes'),{consolidateCalcRuns}=require('../panel-domain');
test('mesmos eventos e vínculos mantêm modos, desejos e ordem; mudanças e novas aberturas não reutilizam resultado antigo',()=>{
  const rows=[
    {id:'c1',created_at:'2026-10-08T10:00:00Z',dados:{sid:'s1',ref:'HCAR2',evento:'busca',logical_mode:'CARRO',marca:'Honda',modelo:'Civic',ano_de:2020,ano_ate:2025,milhas_de:50000,milhas_ate:90000}},
    {id:'v1',created_at:'2026-10-08T11:00:00Z',dados:{sid:'s2',ref:'BVAL3',evento:'simulacao',logical_mode:'VALOR',marca:'BMW',modelo:'X5',lance:50000}}
  ],links=[{calc_sid:'s1',calc_ref:'HCAR2',logical_mode:'CARRO',journey_id:'journey-1'}];
  const ctx={calculatorModesCache:new Map(),calculatorModesStats:{loads:0,reuses:0,compute:0}};
  const expected=consolidateCalcRuns(rows,links),first=modes(ctx,rows,links);
  assert.equal(expected.length,2);assert.deepEqual(first,expected);
  first[0].wishlists[0].model='isolated';first[1].link.journeyId='isolated';
  assert.deepEqual(modes(ctx,structuredClone(rows),structuredClone(links)),expected);
  assert.equal(ctx.calculatorModesStats.reuses,1);assert.equal(ctx.calculatorModesStats.loads,1);
  const changed=structuredClone(rows);changed[1].dados.lance=60000;
  assert.deepEqual(modes(ctx,changed,links),consolidateCalcRuns(changed,links));
  const newLinks=[{...links[0],journey_id:'journey-2'}];
  assert.deepEqual(modes(ctx,rows,newLinks),consolidateCalcRuns(rows,newLinks));
  assert.equal(ctx.calculatorModesStats.loads,3);
  const fresh={calculatorModesCache:new Map(),calculatorModesStats:{loads:0,reuses:0,compute:0}};
  assert.deepEqual(modes(fresh,rows,links),expected);assert.equal(fresh.calculatorModesStats.loads,1);
  assert.deepEqual(modes({},rows,links),expected);
});
test('uma colisão JSON nunca confunde valores JS distintos',()=>{
  const ctx={calculatorModesCache:new Map()},compute=rows=>structuredClone(rows);
  const a=[{value:undefined}],b=[{}];assert.equal(JSON.stringify(a),JSON.stringify(b));
  assert.deepEqual(modes(ctx,a,[],compute),a);assert.deepEqual(modes(ctx,b,[],compute),b);
});

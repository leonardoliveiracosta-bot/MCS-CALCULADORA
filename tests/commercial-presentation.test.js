'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const plan=require('../purchase-plan'),core=require('../calc-core'),parser=require('../panel-calc-message'),proof=require('../panel-ref-proof');
const data={nome:'Example Buyer',marca:'Toyota',modelo:'Camry',anoDe:2020,anoAte:2025,trim:'XSE',milhasAte:60000,lance:20000.50,pgto:'cash',zip:'33470',prazo:'now',ref:'H2DVX'};
const read=file=>fs.readFileSync(require.resolve('../'+file),'utf8');
function dictionaries(file){
  const source=read(file),start=source.indexOf('const I18N =')>=0?source.indexOf('const I18N ='):source.indexOf('var I18N =');
  assert.ok(start>=0,file);
  const end=source.indexOf('function T(',start),snippet=source.slice(start,end);
  const context={window:{},localStorage:{getItem(){return null;}}};vm.createContext(context);
  vm.runInContext(snippet+'\nthis.translations=I18N;',context);return context.translations;
}
for(const lang of ['en','es','pt'])test(lang+': request summary and messages preserve the entered price, payment and criteria without computed charges',()=>{
  for(const pgto of ['cash','fin']){
    const d={...data,pgto},summary=plan.summary(d,lang),message=plan.message(d,core.calcular(d),lang);
    assert.equal(summary.find(r=>r.key==='target').value,'$20,000.50');
    assert.equal(summary.filter(r=>r.key==='target').length,1);
    assert.deepEqual(summary.map(r=>r.key),['name','vehicle','years','trim','miles','target','payment','zip','when']);
    assert.ok(message.startsWith(lang.toUpperCase()+' · NOW · $20,001 · Toyota Camry\n'));
    assert.ok(message.includes('$20,000.50'));assert.ok(message.endsWith('Ref: H2DVX'));
    assert.doesNotMatch(message,/auction fee|service fee|taxa|tarifa|estimated total|custo total/i);
    assert.equal(parser.parse(message).calculator,true);assert.equal(parser.parse(message).vehicle,'Toyota Camry');assert.equal(parser.parse(message).ref,data.ref);
    assert.equal(proof.messageMode(message),'VALOR');
  }
});
test('the public renderer escapes customer input and never renders a computed price',()=>{
  const source=read('msc-calculadora.html'),html=source.match(/function render\(\)\{[\s\S]*?\n\}/)[0],out={innerHTML:''};
  const ctx={lerForm:()=>({...data,nome:'<img src=x onerror=alert(1)>'}),$:()=>out,aplicarEstado(){},aplicarMarca(){},CONFIG:core.CONFIG,LANG:'en',T:k=>k,MCSPurchasePlan:plan,botaoShare:()=>'<button id="share"></button>',registrarSimulacaoConcluida(){},calcular(){throw Error('public summary must not calculate');}};
  vm.createContext(ctx);vm.runInContext(html,ctx);ctx.render();
  assert.match(out.innerHTML,/&lt;img/);assert.doesNotMatch(out.innerHTML,/<img src=x|plan_auction|plan_service/);assert.match(out.innerHTML,/\$20,000\.50/);
});
test('home removes public usage and fee claims, keeps four steps, a single optional listing entry and no fee section',()=>{
  const home=read('index.html');
  assert.doesNotMatch(home,/<section id="taxas"|href="#taxas"/);
  const how=home.slice(home.indexOf('<section id="como-funciona"'),home.indexOf('</section>',home.indexOf('<section id="como-funciona"')));
  assert.equal((how.match(/class="step"/g)||[]).length,4);
  assert.doesNotMatch(home,/data-i18n="home_service_fee"|id="home-purchase-proof"/);
  assert.doesNotMatch(read('msc-calculadora.html'),/id="gate-proof"|fetch\("\/api\/calc-stats/);
  assert.doesNotMatch(read('home-start.js'),/fetch\('\/api\/calc-stats/);
  assert.equal((home.match(/data-home-start="calculate"/g)||[]).length,1);assert.doesNotMatch(home,/data-home-start="find"/);
});
test('active translations are aligned across EN ES PT, including menu and summary labels',()=>{
  const home=dictionaries('index.html'),calculator=dictionaries('msc-calculadora.html');
  for(const lang of ['en','es','pt']){
    assert.doesNotMatch(home[lang].m_calc,/calculator|calculadora/i);
    assert.doesNotMatch(home[lang].sc_3,/service|serviço|servicio/i);
    assert.doesNotMatch(calculator[lang].plan_bid,/bid|lance|oferta/i);
    assert.doesNotMatch(calculator[lang].title,/calculator|calculadora/i);
    assert.doesNotMatch(calculator[lang].contact_copy+' '+calculator[lang].contact_end_title,/estimate|estimativa|estimación/i);
    assert.ok(calculator[lang].plan_numbers);assert.equal(calculator[lang].plan_bid_help,'');
  }
});
test('shared image contains the same request summary and no fee rows',()=>{
  const source=read('msc-calculadora.html'),draw=source.match(/function desenharCartao\(d,r\)\{[\s\S]*?\n\}/)[0],written=[];
  const canvas={getContext:()=>({fillRect(){},fillText:value=>written.push(value)})};
  const ctx={document:{createElement:()=>canvas},MCSPurchasePlan:plan,LANG:'en',T:k=>k};vm.createContext(ctx);vm.runInContext(draw,ctx);ctx.desenharCartao(data,core.calcular(data));
  assert.ok(written.includes('$20,000.50'));assert.ok(written.includes('Toyota Camry'));assert.ok(written.includes('Ref: H2DVX'));assert.ok(written.includes('Cash'));
  assert.doesNotMatch(written.join(' '),/auction fee|service fee|estimated total/i);
});

test('financing menu follows the same purchase naming without dead fee links',()=>{
  const finance=read('finance/index.html');
  assert.doesNotMatch(finance,/href="\/#taxas"/);
  for(const label of ['Your next car','Tu próximo auto','Seu próximo carro']) assert.ok(finance.includes(label));
  assert.match(finance,/id="finance-continue" href="\/msc-calculadora.html\?start=finance"/);
});

test('the panel keeps target prices distinct from old bid records without changing their amounts',()=>{
  const domain=require('../panel-domain');
  const row=(ref,basis)=>({id:ref,created_at:'2026-11-03T20:00:00Z',dados:{sid:ref,ref,evento:'simulacao',logical_mode:'VALOR',marca:'Toyota',modelo:'Camry',lance:20000,...(basis?{price_basis:basis}: {})}});
  const orders=domain.groupCalculatorByRef(domain.consolidateCalcRuns([row('H2DVX','VEHICLE_TARGET'),row('K3GWT')]));
  const current=orders.find(o=>o.ref==='H2DVX'),old=orders.find(o=>o.ref==='K3GWT');
  assert.equal(current.modeSummaries.VALOR.priceBasis,'VEHICLE_TARGET');
  assert.equal(old.modeSummaries.VALOR.priceBasis,null);
  assert.equal(current.budgetCents,2000000);assert.equal(old.budgetCents,2000000);
  assert.match(read('painel/painel.js'),/v.priceBasis === 'VEHICLE_TARGET' \? 'Preço pretendido' : 'Lance máximo'/);
  assert.match(read('painel/painel.js'),/value\('Preço pretendido'\) \|\| value\('Lance máximo'\)/);
});

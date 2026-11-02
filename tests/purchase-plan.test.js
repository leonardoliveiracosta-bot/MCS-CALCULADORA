'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../calc-core');
const plan=require('../purchase-plan');
const parser=require('../panel-calc-message');
const proof=require('../panel-ref-proof');
const domain=require('../panel-domain');
const fs=require('node:fs');
const vm=require('node:vm');
const data={nome:'Ana Teste',marca:'Toyota',modelo:'Camry',anoDe:2020,anoAte:2025,trim:'XSE',milhasAte:60000,lance:35000,pgto:'cash',florida:true,estado:'',zip:'33470',estadoNome:'Florida',prazo:'now',ref:'H2DVX',inspecao:false};
test('auction estimates use the owner thresholds strictly above each boundary plus the same $95',()=>{
  for(const [bid,fee] of [[3000,400],[5000,400],[5000.01,490],[7500,490],[7500.01,550],[9900,550],[9900.01,600],[19000,600],[19000.01,700],[34000,700],[34000.01,800],[44000,800],[44000.01,900],[54000,900],[54000.01,1000],[75000,1000],[75000.01,1100],[100000,1100],[100000.01,1500],[300000,1500]]){
    const r=core.calcular({...data,lance:bid});
    assert.equal(r.taxaLeilao,fee,String(bid));assert.equal(plan.numbers(r).auction,fee+95,String(bid));
  }
});
test('only bid, auction estimate and MCS fee are public for every payment/state combination',()=>{
  for(const florida of [true,false])for(const pgto of ['cash','fin']){
    const r=core.calcular({...data,lance:20000,florida,estado:florida?'':'0',pgto});
    assert.deepEqual(plan.numbers(r),{bid:20000,auction:795,service:900});
    assert.equal(r.documentacaoFixa,599,'internal calculation was not removed');
  }
});
test('name, year interval, trim and maximum mileage define a complete request',()=>{
  assert.equal(plan.validDetails(data),true);
  for(const override of [{nome:''},{anoDe:0},{anoAte:2019},{anoAte:3000},{trim:''},{milhasAte:0}])assert.equal(plan.validDetails({...data,...override}),false);
  assert.equal(plan.validDetails({...data,trim:'',trimSemCerteza:true}),true);
});
test('purchase requires an explicit payment choice before either pair of send links is enabled',()=>{
  const html=fs.readFileSync(require.resolve('../msc-calculadora.html'),'utf8');
  const radios=[...html.matchAll(/<input\b[^>]*name="pgto"[^>]*>/g)].map(x=>x[0]);
  assert.equal(radios.length,2);radios.forEach(r=>assert.doesNotMatch(r,/\bchecked\b/));
  const values={nome:'Ana Teste',marca:'Toyota',modelo:'Camry','year-from':'2020','year-to':'2025',trim:'XSE','miles-max':'60000',lance:'35000',zip:'33470'};
  const fields=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,focus(){},scrollIntoView(){}}]));
  fields['trim-unsure']={checked:false};fields['wrap-modelo']={hidden:false};
  for(const id of ['wa','sms','wa-bottom','sms-bottom'])fields[id]={href:'#'};
  let selected=null;const errors={};
  const ctx={CONFIG:core.CONFIG,MCSPurchasePlan:plan,$:id=>fields[id],document:{querySelector:selector=>selector==='input[name="pgto"]:checked'?selected:selector.includes('prazo')?{value:'now'}:selector==='input[name="pgto"]'?fields.nome:null},zipEstado:()=>({uf:'FL',nome:'Florida'}),zipValido:()=>true,refSessao:()=>data.ref,num:Number,marcar:()=>true,marcarRadio:(id,bad)=>{errors[id]=bad;return !bad;},calcular:core.calcular,linkWhatsApp:d=>'wa:'+d.pgto,linkSms:d=>'sms:'+d.pgto};
  vm.createContext(ctx);
  for(const name of ['lerForm','formOk','validar','atualizarLink'])vm.runInContext(html.match(new RegExp('function '+name+'\\(\\)\\{[\\s\\S]*?\\n\\}'))[0],ctx);
  assert.equal(ctx.lerForm().pgto,'');assert.equal(ctx.formOk(),false);assert.equal(ctx.validar(),false);assert.equal(errors['err-pgto'],true);
  ctx.atualizarLink();for(const id of ['wa','sms','wa-bottom','sms-bottom'])assert.equal(fields[id].href,'#');
  for(const payment of ['cash','fin']){selected={value:payment};assert.equal(ctx.formOk(),true);assert.equal(ctx.validar(),true);ctx.atualizarLink();assert.equal(fields.wa.href,'wa:'+payment);assert.equal(fields['wa-bottom'].href,fields.wa.href);assert.equal(fields.sms.href,'sms:'+payment);assert.equal(fields['sms-bottom'].href,fields.sms.href);}
});
for(const lang of ['en','es','pt'])test('new '+lang+' message keeps calculator identity, VALOR mode, Ref and all criteria',()=>{
  const message=plan.message(data,core.calcular(data),lang);
  assert.equal(parser.parse(message).calculator,true);
  assert.equal(parser.parse(message).ref,'H2DVX');assert.equal(parser.parse(message).name,'Ana Teste');
  assert.equal(proof.messageMode(message),'VALOR');assert.equal(proof.isCalculatorTemplate(message),true);
  assert.equal(parser.parse(message).vehicle,'Toyota Camry');
  for(const text of ['2020-2025','XSE','60,000','$35,000','$895','$1,200','33470'])assert.ok(message.includes(text),text);
  assert.doesNotMatch(message,/599|deposit|documenta|commercial offer|oferta comercial|oblig|obriga/i);
});
test('panel consolidates all new criteria without changing the standalone CARRO mode',()=>{
  const row={created_at:'2026-10-31T18:00:00Z',lance:35000,pagamento:'cash',dados:{sid:'purchase-unit',logical_mode:'VALOR',evento:'whatsapp',ref:'H2DVX',nome:data.nome,marca:data.marca,modelo:data.modelo,ano_de:2020,ano_ate:2025,trim:'XSE',milhas_ate:60000,lance:35000,pagamento:'cash',zip:'33470',estado:'FL'}};
  const items=domain.consolidateCalcRuns([row]);assert.equal(items.length,1);assert.equal(items[0].logicalMode,'VALOR');
  assert.equal(items[0].wishlist.trim,'XSE');assert.equal(items[0].wishlist.yearMin,2020);assert.equal(items[0].wishlist.yearMax,2025);assert.equal(items[0].wishlist.maxMiles,60000);
  assert.equal(items[0].contactName,'Ana Teste');assert.equal(items[0].contactChannel,'WHATSAPP');
});
test('historical purchases retain the recorded auction fee rather than today’s estimate',()=>{
  const purchases=require('../data/compras.json');
  for(const p of purchases){const params=core.defaultParams();params.ovLeilao=p.auctionFeeAtPurchase;const r=core.calcular({lance:p.lance,florida:true,pgto:'cash',inspecao:false},params);assert.equal(r.dLeilao,p.auctionFeeAtPurchase+95);}
  const escalade=purchases.find(p=>p.modelo==='Escalade Luxury');assert.equal(escalade.auctionFeeAtPurchase,600);assert.equal(core.taxaLeilaoDe(escalade.lance),700);
});
test('switching languages preserves the model and refreshes the estimate and outgoing message',()=>{
  const html=fs.readFileSync(require.resolve('../msc-calculadora.html'),'utf8');
  const source=html.match(/function trocarIdioma\(novo\)\{[\s\S]*?\n\}/)[0];
  const model={value:'Camry'},updates=[];
  const context={I18N:{en:{},es:{},pt:{}},LANG:'en',localStorage:{setItem(){}},$:()=>model,aplicarIdioma(){},aplicarMarca(){model.value='';},render(){updates.push('result:'+context.LANG);},atualizarLink(){updates.push(plan.message(data,core.calcular(data),context.LANG));},atualizarFindIdioma(){updates.push('find:'+context.LANG);}};
  vm.createContext(context);vm.runInContext(source,context);
  for(const [lang,label] of [['es','Oferta máxima'],['pt','Lance máximo'],['en','Maximum bid']]){
    context.trocarIdioma(lang);assert.equal(model.value,'Camry');assert.equal(updates.at(-3),'result:'+lang);assert.ok(updates.at(-2).includes(label+': $35,000'));assert.equal(updates.at(-1),'find:'+lang);
  }
});
test('old Find URLs open the single calculator while partner financing keeps its own destination',()=>{
  const html=fs.readFileSync(require.resolve('../msc-calculadora.html'),'utf8');
  const source=html.match(/try\{var START_PARAM=[^\n]+/)[0];
  for(const [search,expected] of [['?start=find','calculate'],['?start=calculate','calculate'],['?start=finance','finance'],['',null]]){
    const opened=[];vm.runInNewContext(source,{URLSearchParams,location:{search},abrirCaminho:path=>opened.push(path)});
    assert.deepEqual(opened,expected?[expected]:[]);
  }
  const home=fs.readFileSync(require.resolve('../home-start.js'),'utf8');
  const open=home.slice(home.indexOf('function open(path)'),home.indexOf('function goToChoices'));
  const actions=[],context={allowed:['calculate','find','finance'],selected:null,reveal(){},ensureFrame:path=>actions.push(path),sendPath(){},goToForm(){}};
  vm.createContext(context);vm.runInContext(open,context);context.open('find');assert.equal(context.selected,'calculate');assert.deepEqual(actions,['calculate']);
});
test('one purchase entry followed by an optional listing reference, with current send controls and no phone step',()=>{
  const html=fs.readFileSync(require.resolve('../msc-calculadora.html'),'utf8');const home=fs.readFileSync(require.resolve('../index.html'),'utf8');
  for(const id of ['wa','sms','wa-bottom','sms-bottom','mimg-save','err-prazo'])assert.ok(html.includes('id="'+id+'"'));
  assert.ok(html.includes('id="find-trim"'));assert.ok(html.includes('id="finance-form"'));
  const form=html.slice(html.indexOf('<form id="form"'),html.indexOf('</form>',html.indexOf('<form id="form"')));
  assert.doesNotMatch(form,/type="tel"|id="inspecao"|name="placa"|name="finap"/);
  assert.equal((home.match(/data-home-start="calculate"/g)||[]).length,1);assert.equal((home.match(/data-home-start="find"/g)||[]).length,0);assert.equal((home.match(/data-home-start="finance"/g)||[]).length,0);
  const entry=html.slice(html.indexOf('<section id="path-entry"'),html.indexOf('<section id="path-a"'));
  assert.equal((entry.match(/data-start=/g)||[]).length,1);
  assert.ok(entry.indexOf('data-reference-entry')>entry.indexOf('data-start="calculate"'));
  const choices=home.slice(home.indexOf('id="home-start-choices"'),home.indexOf('id="home-purchase-proof"'));
  assert.ok(choices.indexOf('data-mcs-listing-reference')>choices.indexOf('data-home-start="calculate"'));
  assert.equal((home.match(/data-mcs-listing-reference/g)||[]).length,2); // One form and its existing submit handler
  assert.ok(entry.includes('type="url"'));assert.ok(choices.includes('type="url"'));
  assert.ok(home.includes('id="financiamento"'));
});

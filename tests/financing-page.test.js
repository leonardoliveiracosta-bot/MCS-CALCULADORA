'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const home=read('index.html'),page=read('finance/index.html');
test('one financing entry opens the existing questionnaire; other choices and explanatory menu remain',()=>{
  const choices=home.slice(home.indexOf('id="home-start-choices"'),home.indexOf('id="home-purchase-proof"'));
  assert.deepEqual([...choices.matchAll(/data-home-start="([^"]+)"/g)].map(m=>m[1]),['finance','calculate','find']);
  assert.equal((choices.match(/href="\/finance"/g)||[]).length,0);
  assert.match(home,/href="#financiamento"[\s\S]*?data-i18n="m_fin"/);
});
test('partner page defaults to the questionnaire and requires server verification before redirecting',()=>{
  assert.match(page,/<meta name="robots" content="noindex, nofollow">/);assert.match(page,/src="\/mcs-logo.svg"/);assert.doesNotMatch(page,/<iframe|dealercenter\.net/i);
  assert.match(page,/id="finance-continue" href="\/msc-calculadora.html\?start=finance"/);
  assert.match(page,/src="\/finance-handoff.js/);assert.doesNotMatch(page,/window\.setTimeout/);
  assert.match(page,/Meta Wholesale Cars/);assert.match(page,/I18N.es,\{finance_kicker/);assert.match(page,/I18N.pt,\{finance_kicker/);
  assert.doesNotMatch(page,/aplicação de crédito|Continuar para a aplicação/);
});
test('legacy financing pages redirect before the calculator fallback and no obsolete embeds remain',()=>{
  const config=JSON.parse(read('vercel.json'));
  for(const source of ['/financing','/financing/:path*'])assert.ok(config.redirects.some(r=>r.source===source&&r.destination==='/finance'));
  for(const source of ['/finance','/finance/'])assert.ok(config.rewrites.some(r=>r.source===source&&r.destination==='/finance/index.html'));
  assert.deepEqual(config.rewrites.at(-1),{source:'/(.*)',destination:'/msc-calculadora.html'});
  assert.equal(fs.existsSync(path.join(root,'financing/index.html')),false);assert.equal(fs.existsSync(path.join(root,'financing/teste.html')),false);
});

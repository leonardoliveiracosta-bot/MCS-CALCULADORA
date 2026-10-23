'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.join(__dirname,'..'),read=f=>fs.readFileSync(path.join(root,f),'utf8');
const home=read('index.html'),page=read('finance/index.html'),destination='https://www.mymetawholesalecars.com/apply-online/';
test('finance is the first entry and existing calculator paths retain their relative order and destinations',()=>{
  const choices=home.slice(home.indexOf('<div class="home-start-choices"'),home.indexOf('<p class="home-purchase-proof"'));
  const entries=[...choices.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];assert.equal(entries.length,4);
  assert.match(entries[0][1],/href="\/finance"/);assert.doesNotMatch(entries[0][1],/data-home-start/);
  assert.match(entries[0][2],/>Finance my car</);assert.match(entries[0][2],/>Apply for financing in minutes</);
  assert.deepEqual(entries.slice(1).map(e=>e[1].match(/data-home-start="([^"]+)"/)[1]),['calculate','find','finance']);
  for(const entry of entries.slice(1))assert.ok(entry[1].includes('href="/msc-calculadora.html?start='+entry[1].match(/data-home-start="([^"]+)"/)[1]+'"'));
  assert.match(home,/href="\/finance"[^>]*>[\s\S]*?data-i18n="m_fin">Financing/);
});
test('finance uses the dealer website in the same tab and redirects after exactly three seconds',()=>{
  assert.match(page,/<meta name="robots" content="noindex, nofollow">/);assert.doesNotMatch(page,/<iframe|dealercenter[.]net|Meta Wholesale Cars/i);
  assert.ok(page.includes('<h1 id="finance-title">Finance your next car</h1>'));
  assert.ok(page.includes('Secure credit application with our dealer partner'));
  const anchor=page.match(/<a class="finance-continue"[^>]+>/)[0];assert.ok(anchor.includes('href="'+destination+'"'));assert.doesNotMatch(anchor,/target=/);
  let timer,delay,opened;
  const scripts=[...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  vm.runInNewContext(scripts.at(-1)[1],{window:{setTimeout:(fn,ms)=>{timer=fn;delay=ms;},location:{replace:url=>{opened=url;}}},document:{getElementById:()=>({href:destination})}});
  assert.equal(delay,3000);assert.equal(opened,undefined);timer();assert.equal(opened,destination);
});
test('legacy financing URLs redirect internally before the calculator fallback and diagnostic embeds are removed',()=>{
  const config=JSON.parse(read('vercel.json'));
  for(const source of ['/financing','/financing/:path*'])assert.deepEqual(config.redirects.find(r=>r.source===source),{source,destination:'/finance',permanent:false});
  for(const source of ['/finance','/finance/'])assert.equal(config.rewrites.find(r=>r.source===source).destination,'/finance/index.html');
  assert.deepEqual(config.rewrites.at(-1),{source:'/(.*)',destination:'/msc-calculadora.html'});
  assert.equal(fs.existsSync(path.join(root,'financing/index.html')),false);assert.equal(fs.existsSync(path.join(root,'financing/teste.html')),false);
});

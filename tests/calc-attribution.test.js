'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const attribution = require('../calc-attribution');
const html = fs.readFileSync(require('node:path').join(__dirname, '../msc-calculadora.html'), 'utf8');
function windowAt(url, referrer = '', framed = false, storage = new Map()) {
  const win = { location: { href: url }, document: { referrer }, sessionStorage: { getItem: k => storage.get(k) || null, setItem: (k, v) => storage.set(k, v) } };
  win.self = win; win.top = framed ? {} : win;
  return win;
}
test('ad attribution survives a query-free reload, keeps campaign/ad IDs and excludes personal/click data', () => {
  const store = new Map();
  const result = attribution.capture(windowAt('https://mycarscout.net/msc-calculadora.html?utm_source=meta&utm_medium=paid_social&utm_campaign=taycan2021_6estados_pesquisa&utm_content=video&campaign_id=123&adset_id=456&ad_id=789&placement=Instagram_Reels&fbclid=private-click&email=private@example.com', '', false, store));
  assert.deepEqual(attribution.capture(windowAt('https://mycarscout.net/msc-calculadora.html', '', false, store)), result);
  assert.equal(result.ad_id, '789');
  assert.equal(result.placement, 'Instagram_Reels');
  assert.equal(result.email, undefined);
  assert.equal(result.fbclid, undefined);
  assert.equal(attribution.origin(result), 'meta / paid_social / taycan2021_6estados_pesquisa');
  const next = attribution.capture(windowAt('https://mycarscout.net/msc-calculadora.html?utm_source=instagram&utm_medium=dm&utm_campaign=scout', '', false, store));
  assert.deepEqual(next, { utm_source: 'instagram', utm_medium: 'dm', utm_campaign: 'scout' });
});
test('homepage iframe inherits campaign labels only from the MCS parent and direct URL wins', () => {
  const own = attribution.capture(windowAt('https://www.mycarscout.net/msc-calculadora.html?utm_content=calculator', 'https://mycarscout.net/?utm_source=meta&utm_content=home', true));
  assert.deepEqual(own, { utm_source: 'meta', utm_content: 'calculator' });
  assert.deepEqual(attribution.capture(windowAt('https://mycarscout.net/msc-calculadora.html', 'https://untrusted.example/?utm_source=meta', true)), {});
});
test('blocked storage and unresolved Meta templates do not break the calculator or create fake IDs', () => {
  const win = windowAt('https://mycarscout.net/msc-calculadora.html?utm_source=meta&ad_id={{ad.id}}');
  win.sessionStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.deepEqual(attribution.capture(win), { utm_source: 'meta' });
  assert.equal(attribution.clean({ utm_campaign: 'x'.repeat(200) }).utm_campaign.length, 120);
});
test('a bid alone never fires completion; a complete estimate fires once and contact click has its own event', () => {
  const events = [];
  const context = { metricaSimulacaoEnviada: false, formOk: () => false, faixaLance: () => '20-30k', metricaVercel: (name, data) => events.push({ name, data }) };
  vm.createContext(context);
  const completion = html.slice(html.indexOf('function registrarSimulacaoConcluida(d){'), html.indexOf('\nvar I18N'));
  vm.runInContext(completion, context);
  context.registrarSimulacaoConcluida({ lance: 20000, zipUf: 'CA' });
  assert.equal(events.length, 0);
  context.formOk = () => true;
  context.registrarSimulacaoConcluida({ lance: 20000, zipUf: 'CA' });
  context.registrarSimulacaoConcluida({ lance: 20000, zipUf: 'CA' });
  assert.deepEqual(events.map(e => e.name), ['simulacao_concluida']);
  const contact = html.slice(html.indexOf('function registrarCliqueContato('), html.indexOf('\nfunction registrar(evento)'));
  vm.runInContext(contact, context);
  context.registrarCliqueContato('whatsapp', 'VALOR');
  assert.deepEqual(events.map(e => e.name), ['simulacao_concluida', 'contato_iniciado']);
  assert.ok(!events.some(e => /lead|recebido|qualificado/i.test(e.name)));
});

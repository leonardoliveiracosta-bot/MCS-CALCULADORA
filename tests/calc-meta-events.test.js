'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const create = require('../calc-meta-events');
function fixture(overrides = {}) {
  const scripts = [], calls = [];
  const win = { location: { hostname: 'mycarscout.net', pathname: '/msc-calculadora.html' }, navigator: {}, document: {
    createElement: () => ({}), head: { appendChild: script => scripts.push(script) }
  }, ...overrides };
  if (overrides.fbq !== false) win.fbq = (...args) => calls.push(args);
  else delete win.fbq;
  return { win, calls, scripts };
}
test('production calculator measures a page and explicit stages, never Lead or personal form data', () => {
  const { win, calls } = fixture();
  const api = create(win);
  api.track('ContactInitiated', { logical_mode: 'VALOR', channel: 'whatsapp', email: 'private@example.com', zip: '33060', amount: 50000 });
  api.track('Lead', { phone: 'private' });
  api.track('CalculationCompleted', { logical_mode: 'CARRO', name: 'private' });
  assert.deepEqual(calls, [
    ['set', 'autoConfig', false, '2308379543262592'], ['init', '2308379543262592'],
    ['trackSingle', '2308379543262592', 'PageView'],
    ['trackSingleCustom', '2308379543262592', 'ContactInitiated', { logical_mode: 'VALOR', channel: 'whatsapp' }],
    ['trackSingleCustom', '2308379543262592', 'CalculationCompleted', { logical_mode: 'CARRO' }]
  ]);
});
test('previews, other pages and browser opt-outs send no Meta events or script requests', () => {
  for (const overrides of [
    { location: { hostname: 'preview.vercel.app', pathname: '/msc-calculadora.html' } },
    { location: { hostname: 'mycarscout.net', pathname: '/painel' } },
    { navigator: { globalPrivacyControl: true } }, { navigator: { doNotTrack: '1' } }
  ]) {
    const { win, calls, scripts } = fixture(overrides);
    create(win).track('ContactInitiated', { logical_mode: 'CARRO' });
    assert.equal(calls.length, 0); assert.equal(scripts.length, 0);
  }
});
test('the advertised root URL records calculator completion on both production domains', () => {
  for (const hostname of ['mycarscout.net', 'www.mycarscout.net']) {
    const { win, calls } = fixture({ location: { hostname, pathname: '/' } });
    const api = create(win);
    api.track('CalculationCompleted', { logical_mode: 'VALOR' });
    assert.equal(api.allowed, true);
    assert.deepEqual(calls.at(-1), ['trackSingleCustom', '2308379543262592', 'CalculationCompleted', { logical_mode: 'VALOR' }]);
    const optedOut = fixture({ location: { hostname, pathname: '/' }, navigator: { globalPrivacyControl: true } });
    assert.equal(create(optedOut.win).allowed, false);
    assert.equal(optedOut.calls.length, 0);
  }
});
test('async SDK queues events without waiting, and SDK failures cannot interrupt contact', () => {
  const { win, scripts } = fixture({ fbq: false });
  create(win).track('ContactInitiated', { channel: 'sms', logical_mode: 'CARRO' });
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].async, true);
  assert.equal(win.fbq.queue.length, 4);
  const broken = fixture(); broken.win.fbq = () => { throw Error('blocked'); };
  assert.doesNotThrow(() => create(broken.win).track('ContactInitiated', {}));
});
test('common analytics path still works independently when Meta or Vercel is blocked', () => {
  const html = fs.readFileSync(require('node:path').join(__dirname, '../msc-calculadora.html'), 'utf8');
  const body = html.slice(html.indexOf('function metricaVercel('), html.indexOf('\nfunction faixaLance('));
  const meta = [], vercel = [];
  const context = { window: { va: (...args) => vercel.push(args), MCSCalcMeta: { track: (...args) => meta.push(args) } } };
  vm.createContext(context); vm.runInContext(body, context);
  context.metricaVercel('contato_iniciado', { canal: 'sms', modo: 'CARRO', nome: 'private' });
  context.metricaVercel('simulacao_concluida', {});
  context.metricaVercel('busca_pronta', {});
  assert.deepEqual(meta.map(args => args[0]), ['ContactInitiated', 'CalculationCompleted', 'CalculationCompleted']);
  assert.equal(JSON.stringify(meta).includes('private'), false);
  context.window.MCSCalcMeta.track = () => { throw Error('blocked'); };
  assert.doesNotThrow(() => context.metricaVercel('contato_iniciado', { canal: 'whatsapp', modo: 'VALOR' }));
  assert.equal(vercel.length, 4);
  delete context.window.MCSCalcMeta;
  assert.doesNotThrow(() => context.metricaVercel('busca_pronta', {}));
  assert.match(html, /calc-meta-events\.js[^>]+defer/);
});

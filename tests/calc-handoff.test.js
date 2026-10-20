'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const handoff = require('../calc-handoff');
const attribution = require('../calc-attribution');
function page(url, store = new Map()) {
  const win = { location: { href: url }, sessionStorage: {
    getItem: key => store.get(key) || null,
    setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key)
  }, history: { state: { existing: true }, replaceState(state, _, next) { assert.deepEqual(state, { existing: true }); win.location.href = new URL(next, win.location.href).href; } } };
  return win;
}
test('DM association survives the homepage iframe and reload, without exposing the contact ID in analytics attribution', () => {
  const store = new Map();
  const root = page('https://mycarscout.net/?utm_source=instagram&utm_medium=dm&mcs_contact=1906104634#calculadora-widget', store);
  assert.deepEqual(handoff.capture(root), { contact_id: '1906104634', source: 'manychat' });
  assert.equal(root.location.href, 'https://mycarscout.net/?utm_source=instagram&utm_medium=dm#calculadora-widget');
  const frame = page('https://mycarscout.net/msc-calculadora.html', store);
  assert.deepEqual(handoff.capture(frame), { contact_id: '1906104634', source: 'manychat' });
  frame.self = frame; frame.top = {}; frame.document = { referrer: root.location.href };
  assert.deepEqual(attribution.capture(frame), { utm_source: 'instagram', utm_medium: 'dm' });
  assert.deepEqual(handoff.capture(page('https://mycarscout.net/', store)), { contact_id: '1906104634', source: 'manychat' });
  assert.equal(handoff.capture(page('https://mycarscout.net/?utm_source=meta', store)), null);
  assert.equal(handoff.capture(page('https://mycarscout.net/', store)), null);
  handoff.capture(page('https://mycarscout.net/?mcs_contact=1906104634', store));
  assert.equal(handoff.capture(page('https://mycarscout.net/?utm_source=instagram&utm_campaign=other', store)), null);
});
test('invalid templates and a new contact cannot inherit the previous contact; blocked storage does not stop the page', () => {
  const store = new Map();
  handoff.capture(page('https://mycarscout.net/?mcs_contact=1906104634', store));
  assert.deepEqual(handoff.capture(page('https://mycarscout.net/?mcs_contact=1552674989', store)), { contact_id: '1552674989', source: 'manychat' });
  for (const value of ['', '{{contact.id}}', '-12345', '12345x', '1'.repeat(21)]) {
    const win = page('https://mycarscout.net/?mcs_contact=' + encodeURIComponent(value), store);
    assert.equal(handoff.capture(win), null);
    assert.ok(!win.location.href.includes('mcs_contact'));
  }
  const blocked = page('https://mycarscout.net/?mcs_contact=1906104634');
  blocked.sessionStorage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); }, removeItem() { throw Error('blocked'); } };
  assert.deepEqual(handoff.capture(blocked), { contact_id: '1906104634', source: 'manychat' });
});
test('both request writers preserve the DM association beside Ref, not in the customer message or Meta events', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../msc-calculadora.html'), 'utf8');
  const sent = [], data = { marca: 'Porsche', modelo: 'Taycan', lance: 30000, pgto: 'cash', ref: 'CMPXQ' };
  const ctx = { window: { location: { hostname: 'mycarscout.net' }, MCSCalcMeta: { allowed: true } }, location: { hostname: 'mycarscout.net' },
    LOG_URL: 'https://example.invalid/log', SUPABASE_KEY: 'test', LANG: 'en', FIND_SID: 'test-find',
    HANDOFF_CALC: { contact_id: '1906104634', source: 'manychat' }, ATRIBUICAO_CALC: { utm_source: 'instagram' },
    ultimoEnvio: '', lerForm: () => data, calcular: () => ({ total: 32000, deposito: 3000 }), formOk: () => true,
    sessaoId: () => 'test-calc', origemCalculo: () => 'instagram / dm', registrarCliqueContato() {},
    fetch: async (_, init) => { sent.push(JSON.parse(init.body).dados); }, Date, JSON, Math };
  vm.createContext(ctx);
  vm.runInContext(html.slice(html.indexOf('function registrar(evento){'), html.indexOf('\nvar tmrLog')), ctx);
  ctx.registrar('whatsapp'); ctx.registrarBusca(data, 'sms');
  assert.equal(sent.length, 2);
  for (const record of sent) {
    assert.equal(record.ref, 'CMPXQ'); assert.equal(record.manychat.contact_id, '1906104634');
    assert.equal(record.primeira_vez, null, 'removed question stays unknown instead of inventing experience');
    assert.equal(record.atribuicao.contact_id, undefined);
  }
  assert.doesNotMatch(html.slice(html.indexOf('function linkWhatsApp(d,'), html.indexOf('function linkSms(d,')), /HANDOFF_CALC|mcs_contact|manychat/);
  for (const file of ['index.html', 'msc-calculadora.html']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(text.indexOf('/calc-handoff.js?') < text.indexOf('/_vercel/insights/script.js'));
  }
});

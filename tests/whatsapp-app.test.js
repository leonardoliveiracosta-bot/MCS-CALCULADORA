'use strict';
// No celular, os links wa.me do painel abrem o aplicativo do WhatsApp (whatsapp://), não o WhatsApp Web.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wa = require('../painel/whatsapp-app');

test('wa.me vira whatsapp:// com o mesmo número e o mesmo texto', () => {
  const text = 'Hi Ana, 2018–2020 Camry & up to $12,000?\nLet me know';
  const href = 'https://wa.me/13055550123?text=' + encodeURIComponent(text);
  const app = wa.appUrl(href);
  assert.equal(app, 'whatsapp://send?phone=13055550123&text=' + encodeURIComponent(text));
  assert.equal(new URL(app.replace('whatsapp://send', 'https://x.test/send')).searchParams.get('text'), text);
  assert.equal(wa.appUrl('https://wa.me/13055550123'), 'whatsapp://send?phone=13055550123');
  assert.equal(wa.appUrl('https://example.com/13055550123'), null);
  assert.equal(wa.appUrl('tel:+13055550123'), null);
  assert.equal(wa.appUrl('https://wa.me/'), null);
});

test('só no celular: iPhone, iPad e Android sim; computador não', () => {
  assert.equal(wa.isPhone({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), true);
  assert.equal(wa.isPhone({ userAgent: 'Mozilla/5.0 (Linux; Android 14)' }), true);
  assert.equal(wa.isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 }), true);
  assert.equal(wa.isPhone({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 }), false);
  assert.equal(wa.isPhone({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }), false);
});

test('o painel carrega o desvio antes das sugestões', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'painel', 'index.html'), 'utf8');
  assert.ok(html.indexOf('/painel/whatsapp-app.js') > 0 && html.indexOf('/painel/whatsapp-app.js') < html.indexOf('/painel/sugestoes.js'));
});

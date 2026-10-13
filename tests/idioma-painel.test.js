'use strict';

// Idioma do painel: o dicionário gerado bate com a fonte, os modelos guardam os mesmos campos {n}, e em português
// (o padrão) o script não baixa dicionário nem mexe na página; só põe o seletor.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(root, 'scripts/panel-i18n.json'), 'utf8'));
const holes = (text) => (String(text).match(/\{\d+\}/g) || []).sort().join(',');

test('modelos traduzidos têm exatamente os mesmos campos que o original', () => {
  for (const [pt, en, es] of source.tpl) {
    if (en) assert.equal(holes(en), holes(pt), pt);
    if (es) assert.equal(holes(es), holes(pt), pt);
  }
  assert.ok(Object.keys(source.lit).length > 1000);
});

test('os arquivos i18n-en.js e i18n-es.js são os gerados pela fonte', () => {
  const before = ['en', 'es'].map((lang) => fs.readFileSync(path.join(root, `painel/i18n-${lang}.js`), 'utf8'));
  require('../scripts/build-panel-i18n.js').build(0, 'en');
  require('../scripts/build-panel-i18n.js').build(1, 'es');
  const after = ['en', 'es'].map((lang) => fs.readFileSync(path.join(root, `painel/i18n-${lang}.js`), 'utf8'));
  assert.deepEqual(after, before, 'rode node scripts/build-panel-i18n.js');
});

test('português (padrão): nenhum dicionário, nenhum observador, textContent nativo', () => {
  const written = [];
  const listeners = {};
  const context = {
    localStorage: { getItem: () => null },
    location: {},
    MutationObserver: class { constructor() { throw new Error('observer em PT'); } },
    Node: { prototype: {} },
    document: { readyState: 'loading', write: (html) => written.push(html), addEventListener: (name, fn) => { listeners[name] = fn; }, documentElement: {} },
    window: {}
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'painel/i18n.js'), 'utf8'), context);
  assert.deepEqual(written, []);
  assert.equal(context.MCSI18N.lang, 'pt');
  assert.equal(context.MCSI18N.start, undefined);
  assert.deepEqual(Object.keys(context.Node.prototype), []);
  assert.equal(typeof listeners.DOMContentLoaded, 'function');
});

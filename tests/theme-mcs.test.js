'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('tema MCS é carregado depois do CSS legado', () => {
  const html = read('painel/index.html');
  const legacy = html.indexOf('href="/painel/painel.css"');
  const theme = html.indexOf('href="/painel/tema-mcs.css"');
  assert.ok(legacy >= 0);
  assert.ok(theme > legacy);
});

test('Instrument Sans é local, licenciada e possui os três pesos', () => {
  const css = read('painel/tema-mcs.css');
  for (const weight of [400, 500, 600]) {
    const file = `painel/fonts/InstrumentSans-${weight}.woff2`;
    assert.ok(css.includes(`/painel/fonts/InstrumentSans-${weight}.woff2`));
    assert.ok(fs.statSync(path.join(root, file)).size > 1000);
    assert.match(css, new RegExp(`font-weight:\\s*${weight}`));
  }
  assert.ok(fs.statSync(path.join(root, 'painel/fonts/OFL.txt')).size > 0);
  assert.doesNotMatch(css, /https?:\/\//);
});

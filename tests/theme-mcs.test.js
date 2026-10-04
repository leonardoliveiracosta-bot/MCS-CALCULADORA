'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('tema MCS é carregado depois do CSS legado', () => {
  const html = read('painel/index.html');
  // d37dbb6: os CSS ganharam versão para o cache (?v=...); a ordem continua a mesma.
  const at = (file) => { const hit = new RegExp(`href="/painel/${file}(?:\\?v=[\\w-]+)?"`).exec(html); return hit ? hit.index : -1; };
  const legacy = at('painel\\.css');
  const theme = at('tema-mcs\\.css');
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

test('cabeçalho usa o logo de letras escuras do tema claro único e a escala do mockup', () => {
  const html = read('painel/index.html');
  const css = read('painel/tema-mcs.css');
  // Tema claro único: o logo com letras escuras (#0B0D10) sobre o fundo branco.
  assert.match(html, /<picture class="panel-logo">\s*<img src="\/painel\/mcs-logo-claro\.svg" alt="My Car Scout">\s*<\/picture>/);
  assert.match(read('painel/mcs-logo-claro.svg'), /fill="#0B0D10"/);
  assert.match(html, /<meta name="theme-color" content="#FFFFFF">/);
  assert.equal((html.match(/name="theme-color"/g) || []).length, 1);
  for (const file of ['painel/index.html', 'painel/tema-mcs.css', 'painel/painel.css', 'painel/identidade.css']) assert.doesNotMatch(read(file), /prefers-color-scheme/, file);
  assert.match(css, /\.today-heading h2,[\s\S]*?font-size:\s*40px/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.today-heading h2,[\s\S]*?font-size:\s*32px/);
  assert.match(css, /\.entry-tools\s*{[\s\S]*?grid-template-columns:\s*2fr 1fr 1fr/);
});

test('relógio da Flórida combina data pt-BR com hora en-US de 12 horas', () => {
  const js = read('painel/painel.js');
  assert.match(js, /new Intl\.DateTimeFormat\('pt-BR',[\s\S]*?weekday:\s*'long'/);
  assert.match(js, /new Intl\.DateTimeFormat\('en-US',[\s\S]*?hour12:\s*true/);
  assert.match(js, /\$\{date\} · \$\{time\} \(Flórida\)/);
});

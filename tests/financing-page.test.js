'use strict';

// /financing: página separada com o cabeçalho e o rodapé da home e o botão para o formulário de crédito da loja (DealerCenter),
// para mandar o link ao cliente que pede opções de financiamento. A home e as outras rotas não mudam.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const between = (text, start, end) => { const a = text.indexOf(start); assert.ok(a >= 0, start); return text.slice(a, text.indexOf(end, a) + end.length); };

const home = read('index.html');
const page = read('financing/index.html');
const FORM = 'https://dwssecuredforms.dealercenter.net/CreditApplication/index/16883052?themecolor=070707&amp;formtype=l&amp;frameId=dws_frame_0&amp;standalone=true&amp;ls=Other';

test('o botão abre o formulário de crédito da loja, com o endereço exato, em aba nova', () => {
  // A DealerCenter recusa abrir dentro de outro site ("This page cannot be embedded"), então não há iframe.
  assert.ok(!page.includes('<iframe'));
  assert.ok(page.includes(`<a class="fin-cta" href="${FORM}" target="_blank" rel="noopener"`));
  assert.match(page, /<meta name="robots" content="noindex, nofollow">/);
});

test('cabeçalho e rodapé iguais aos da home; o menu leva para as seções da home', () => {
  const header = (html) => between(html, '<header class="top">', '</header>').replace('<a href="/" aria-label="My Car Scout home"><img src="/mcs-logo.svg" alt="My Car Scout"></a>', '<img src="mcs-logo.svg" alt="My Car Scout">');
  assert.equal(header(page), header(home));
  assert.equal(between(page, '<footer>', '</footer>'), between(home, '<footer>', '</footer>'));
  const menu = between(page, '<div class="sheet" id="sheet-menu"', '</div>\n  </div>');
  assert.ok(!/href="#/.test(menu));
  assert.match(menu, /href="\/#financiamento"/);
  // O mesmo estilo da home, mais o da seção do formulário.
  assert.ok(page.includes(between(home, '  :root{', '--radius:12px;')));
});

test('rota: /financing abre a página; a home e o resto do site seguem a regra de sempre', () => {
  const vercel = JSON.parse(read('vercel.json'));
  const rules = vercel.rewrites;
  const at = (source) => rules.findIndex((rule) => rule.source === source);
  assert.equal(rules[at('/financing')].destination, '/financing/index.html');
  assert.equal(rules[at('/financing/')].destination, '/financing/index.html');
  assert.deepEqual(rules.at(-1), { source: '/(.*)', destination: '/msc-calculadora.html' });
  assert.ok(at('/financing') < rules.length - 1);
  // Nenhuma regra de cabeçalho bloqueia o iframe nesta página (só /t, /o e /v negam ser emoldurados, e isso é de fora para dentro).
  assert.ok(!vercel.headers.some((rule) => /financing|^\/\(\.\*\)$/.test(rule.source) && rule.headers.some((h) => /frame-src|child-src/.test(h.value))));
});

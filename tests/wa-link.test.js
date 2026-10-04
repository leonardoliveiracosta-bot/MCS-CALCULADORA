'use strict';

// Links de envio do WhatsApp (painel/wa-link.js): WhatsApp Web na mesma aba "mcs-whatsapp" no
// computador (inclusive Chromebook), wa.me no celular, partes 2 e 3 copiadas sem navegar.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const wa = require('../painel/wa-link');

const AGENTS = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
};
const TEXT = 'Olá, João! Ação & reação #1\nSegunda linha: 100% 🚗✨ ?=+';
const server = 'https://wa.me/13055550123?text=' + encodeURIComponent(TEXT);

// A fake browser window: records window.open calls and keeps named tabs like Chrome does.
function fakeWindow(agent) {
  const tabs = new Map(), opened = [], clipboard = [];
  const win = {
    navigator: { userAgent: agent, clipboard: { writeText: async (value) => { clipboard.push(value); } } },
    location: { href: 'https://mycarscout.net/painel' },
    open(url, target, features) {
      opened.push({ url, target, features });
      if (features && /noopener/.test(features)) return null;
      const tab = tabs.get(target) || { closed: false, focused: 0, url: null, focus() { this.focused += 1; } };
      tab.url = url; tabs.set(target, tab);
      return tab;
    }
  };
  return { win, tabs, opened, clipboard };
}

test('computador (Windows, Mac e Chromebook): WhatsApp Web direto, texto codificado certo', () => {
  for (const agent of [AGENTS.windows, AGENTS.mac, AGENTS.chromebook]) {
    assert.equal(wa.isPhone({ userAgent: agent }), false, agent);
    const link = wa.linkFor(server, { userAgent: agent });
    assert.ok(link.startsWith('https://web.whatsapp.com/send?phone=13055550123&text='), link);
    const url = new URL(link);
    assert.equal(url.searchParams.get('phone'), '13055550123');
    assert.equal(url.searchParams.get('text'), TEXT, 'acentos, quebra de linha, &, #, % e emoji intactos');
    assert.doesNotMatch(link, /[\n #]|&(?!text=)/, 'nada solto no link');
  }
});

test('celular (Android, iPhone, iPad): continua wa.me', () => {
  for (const agent of [AGENTS.android, AGENTS.iphone, AGENTS.ipad]) {
    assert.equal(wa.isPhone({ userAgent: agent }), true, agent);
    assert.equal(wa.linkFor(server, { userAgent: agent }), server);
  }
});

test('links do servidor (wa.me com e sem texto, api.whatsapp.com) são convertidos; outros não', () => {
  assert.equal(wa.webUrl('https://wa.me/+1 (305) 555-0123'), 'https://web.whatsapp.com/send?phone=13055550123');
  assert.equal(wa.webUrl('https://api.whatsapp.com/send?phone=13055550123&text=Oi%20%26%20tchau'), 'https://web.whatsapp.com/send?phone=13055550123&text=Oi%20%26%20tchau');
  assert.equal(wa.webUrl('https://example.com/13055550123'), null);
  assert.equal(wa.webUrl('https://wa.me/'), null);
});

test('parte 1 abre na aba "mcs-whatsapp" sem noopener; o segundo clique reusa a mesma aba', () => {
  wa.reset();
  const { win, opened, tabs } = fakeWindow(AGENTS.chromebook);
  const first = wa.open(server, win);
  const second = wa.open(server, win);
  assert.deepEqual(opened.map((call) => [call.target, call.features]), [['mcs-whatsapp', undefined], ['mcs-whatsapp', undefined]]);
  assert.ok(opened.every((call) => call.url.startsWith('https://web.whatsapp.com/send?phone=')));
  assert.equal(first, second, 'a mesma aba');
  assert.equal(tabs.size, 1);
  assert.equal(wa.tab, first, 'referência guardada');
});

test('partes 2 e 3 copiam e não navegam; com a aba fechada, a parte abre o link', async () => {
  wa.reset();
  const { win, opened, clipboard } = fakeWindow(AGENTS.windows);
  const parts = ['Parte um', 'Parte dois & mais', 'Parte três 🚗'];
  const href = (text) => 'https://wa.me/13055550123?text=' + encodeURIComponent(text);
  const one = await wa.sendPart({ href: href(parts[0]), text: parts[0], index: 1, total: 3 }, win);
  assert.equal(one.opened, true);
  assert.equal(opened.length, 1);
  const tab = wa.tab, urlAfterOne = tab.url;
  const two = await wa.sendPart({ href: href(parts[1]), text: parts[1], index: 2, total: 3 }, win);
  const three = await wa.sendPart({ href: href(parts[2]), text: parts[2], index: 3, total: 3 }, win);
  assert.equal(opened.length, 1, 'nenhuma navegação nas partes 2 e 3');
  assert.equal(tab.url, urlAfterOne, 'a aba não recarrega');
  assert.deepEqual(clipboard, [parts[1], parts[2]]);
  assert.equal(tab.focused, 3, 'tenta trazer a aba para frente');
  assert.equal(two.message, 'Parte 2 copiada: vá para a aba do WhatsApp, cole (Ctrl+V) e envie');
  assert.equal(three.message, 'Parte 3 copiada: vá para a aba do WhatsApp, cole (Ctrl+V) e envie');
  // The operator closed the tab: the part opens with the WhatsApp Web link.
  tab.closed = true;
  const again = await wa.sendPart({ href: href(parts[1]), text: parts[1], index: 2, total: 3 }, win);
  assert.equal(again.opened, true);
  assert.equal(opened.length, 2);
  assert.equal(new URL(opened[1].url).searchParams.get('text'), parts[1]);
  // No tab at all yet (reference null): opens too.
  wa.reset();
  await wa.sendPart({ href: href(parts[2]), text: parts[2], index: 3, total: 3 }, win);
  assert.equal(opened.length, 3);
});

test('celular: a parte abre o wa.me na própria página (o app), sem aba nomeada', async () => {
  wa.reset();
  const { win, opened } = fakeWindow(AGENTS.android);
  await wa.sendPart({ href: server, text: TEXT, index: 2, total: 3 }, win);
  assert.equal(opened.length, 0);
  assert.equal(win.location.href, server);
});

test('todos os envios do painel passam pela função única; nenhum wa.me em aba nova', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'painel', file), 'utf8');
  const html = read('index.html');
  assert.ok(html.indexOf('/painel/wa-link.js') > 0 && html.indexOf('/painel/wa-link.js') < html.indexOf('/painel/whatsapp-envio.js'), 'carregado antes dos botões');
  assert.match(read('lead.js'), /MCSWaLink\.open\(href\)/);
  assert.match(read('whatsapp-envio.js'), /MCSWaLink\.isPhone/);
  for (const file of ['painel.js', 'sugestoes.js', 'lead.js', 'whatsapp-envio.js', 'atendimento.js', 'grupos.js']) {
    assert.doesNotMatch(read(file), /window\.open\([^)]*wa\.me/, file);
  }
});

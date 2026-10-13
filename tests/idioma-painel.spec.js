'use strict';

// Idioma do painel (PT/EN/ES), no navegador real, com /api/** simulado (nada é gravado ou enviado):
//  * Português (padrão): nada é traduzido e o dicionário nem é baixado; só aparece o seletor PT/EN/ES no topo.
//  * Inglês/espanhol: abas, botões, títulos e textos desenhados depois (TODOS) aparecem traduzidos; o que o
//    código lê do texto continua em português (ações iguais); mensagens de cliente ficam como estão.
//  * Voltar para PT recarrega o painel original.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/idioma-painel.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const TODAY = { items: [{ ref: 'AAAA2', key: 'AAAA2', pending: true, awaitingReply: true, contactName: 'Cliente Hoje', simulations: [] }], meta: { dataUpdatedAt: new Date().toISOString() } };
const RECORDS = { items: [], page: 1, pageSize: 50, total: 0, hasMore: false, counts: { periodLeads: 0, allLeads: 0, shownLeads: 0, nonLeads: 0, situations: {}, sections: {} }, meta: {} };

async function open(page, lang) {
  await page.addInitScript((value) => {
    if (value && !sessionStorage.getItem('idioma-teste')) { localStorage.setItem('mcs_panel_lang', value); sessionStorage.setItem('idioma-teste', '1'); }
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
  }, lang || null);
  const files = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    files.push(url.pathname);
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') return json(TODAY);
    if (url.pathname === '/api/panel/records') return json(RECORDS);
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible();
  return files;
}
const tab = (page, view) => page.locator(`nav .tab[data-view="${view}"]`);

test('português é o padrão: nada traduzido, dicionário não baixado, só o seletor no topo', async ({ page }) => {
  const files = await open(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
  await expect(tab(page, 'today')).toContainText('TODOS');
  await expect(tab(page, 'searches')).toContainText('ENVIAR OPÇÕES');
  await expect(page.locator('#logout')).toHaveText('Sair');
  await expect(page.locator('#global-search-input')).toHaveAttribute('placeholder', 'Nome, telefone ou Ref');
  await expect(page.locator('.topbar-actions .mcs-lang')).toHaveValue('pt');
  expect(files.some((file) => /i18n-(en|es)\.js/.test(file))).toBe(false);
  // The code reads the same text it always did.
  expect(await page.evaluate(() => document.getElementById('logout').textContent)).toBe('Sair');
});

test('inglês: tela traduzida, o código continua lendo o original, mensagem do cliente intacta', async ({ page }) => {
  const files = await open(page, 'en');
  expect(files.some((file) => file.endsWith('/painel/i18n-en.js'))).toBe(true);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(tab(page, 'today')).toContainText('ALL');
  await expect(tab(page, 'searches')).toContainText('SEND OPTIONS');
  await expect(page.locator('#logout')).toHaveText('Sign out');
  await expect(page.locator('.settings-link')).toHaveText('Settings and connection');
  await expect(page.locator('#global-search-input')).not.toHaveAttribute('placeholder', 'Nome, telefone ou Ref');
  await expect(page.locator('.topbar-actions .mcs-lang')).toHaveValue('en');
  // What the program reads is still Portuguese, so comparisons and restored labels behave as before.
  expect(await page.evaluate(() => document.getElementById('logout').textContent)).toBe('Sair');
  expect(await page.evaluate(() => document.querySelector('.settings-link').textContent)).toBe('Configurações e conexão');
  // Drawn later by the program: translated too.
  const later = await page.evaluate(async () => {
    const box = document.createElement('div');
    box.innerHTML = '<button class="quiet">Copiar mensagem</button><p class="message-body">Copiar mensagem</p><textarea>Copiar mensagem</textarea><span class="when">terça-feira, 13 de outubro · Copiar mensagem</span>';
    document.body.appendChild(box);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { button: box.querySelector('button').innerText, client: box.querySelector('.message-body').innerText, typed: box.querySelector('textarea').value, read: box.querySelector('button').textContent, when: box.querySelector('.when').innerText };
  });
  expect(later).toEqual({ button: 'Copy message', client: 'Copiar mensagem', typed: 'Copiar mensagem', read: 'Copiar mensagem', when: 'Tuesday, October 13 · Copy message' });
  // Back to Portuguese: the original panel.
  await page.locator('.topbar-actions .mcs-lang').selectOption('pt');
  await expect(page.locator('#logout')).toHaveText('Sair');
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR');
});

test('espanhol: abas e botões em espanhol', async ({ page }) => {
  await open(page, 'es');
  await expect(page.locator('html')).toHaveAttribute('lang', 'es');
  await expect(tab(page, 'searches')).toContainText('ENVIAR OPCIONES');
  await expect(tab(page, 'requests')).toContainText('BUSCAR AUTOS');
  await expect(page.locator('#logout')).toHaveText('Salir');
});

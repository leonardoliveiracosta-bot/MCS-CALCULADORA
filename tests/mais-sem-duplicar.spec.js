'use strict';

// O bloco "Mais" do TODOS não repete a lista de cima: quem já tem caso no TODOS não ganha cartão no "Mais". Ficam os
// clientes que não estão no TODOS, as ferramentas (planilha, leitura geral, retomar conversas) e a planilha inteira.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/mais-sem-duplicar.spec.js
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { clientsPage } = require('../api/panel/records');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const DAY = 86400000;
const iso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const id = (n) => `7f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const group = { key: 'NAO_ATENDIDO', label: 'Não atendidos', origin: { key: 'MENSAGEM:WHATSAPP', label: 'Veio por mensagem · Via WhatsApp', financing: false }, unattended: { reasonText: 'Mensagem do cliente sem resposta', waitedText: '—', missing: 'Resposta', next: 'Responder o cliente' }, hasCalculator: false, calcMode: null };
const latest = { direction: 'CUSTOMER', occurred_at_utc: iso(5), body_text: 'Oi', is_automatic: false };
const journey = (n, name) => ({ kind: 'JOURNEY', id: id(n), name, contact: { display_name: name }, phones: [{ phone_e164: '+1305555040' + n, is_primary: true }], next_action_text: null, next_action_at: null, sortAt: latest.occurred_at_utc, lastCustomerAt: latest.occurred_at_utc, latestMessage: latest, awaitingReply: true, group });
// TODOS has Ana and Bia.
const TODAY = [journey(1, 'Ana No Todos'), journey(2, 'Bia No Todos')];
const client = (n, name, situation, extra = {}) => ({ id: id(n), name, contact: { display_name: name }, phones: [], stage: 'RESPONDIDO', status: 'ATIVO', checklist: [], origins: ['WHATSAPP'], calculatorTypes: [], lastActivityAt: new Date(Date.now() - 2 * DAY).toISOString(), situation, ...extra });
// "Mais" (server list): Ana and Bia again, plus Caio and Duda, who are not in TODOS.
const LISTED = [client(1, 'Ana No Todos', 'NO_RESPONSE'), client(2, 'Bia No Todos', 'NO_RESPONSE'), client(3, 'Caio Concluido', 'CLOSED'), client(4, 'Duda Parada Com Cliente', 'CUSTOMER_PENDING')];

async function open(page, { today = TODAY, listed = LISTED } = {}) {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') return json({ meta: { dataUpdatedAt: new Date().toISOString() }, items: today });
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') !== 'manheim') return json({ ...clientsPage(listed, Object.fromEntries(url.searchParams)), pending: {}, meta: {} });
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#today-list .case-card').first()).toBeVisible({ timeout: 30000 });
  await page.locator('#today-more > summary').click();
  return errors;
}
const cardNames = (page) => page.locator('#clients-list .client-card').evaluateAll((cards) => cards.map((card) => card.textContent));

test('"Mais" não repete quem já está no TODOS; os outros clientes, as ferramentas e a planilha inteira continuam', async ({ page }) => {
  const errors = await open(page);
  // TODOS (common path) unchanged: the two cases are listed above.
  await expect(page.locator('#today-list .case-card')).toHaveCount(2);
  await expect(page.locator('#clients-list .client-card')).toHaveCount(2, { timeout: 30000 });
  const shown = (await cardNames(page)).join(' | ');
  expect(shown).toContain('Caio Concluido');
  expect(shown).toContain('Duda Parada Com Cliente');
  expect(shown).not.toContain('Ana No Todos');
  expect(shown).not.toContain('Bia No Todos');
  await expect(page.locator('#clients-todos-note')).toHaveText('2 cliente(s) desta lista já estão no TODOS acima e não se repetem aqui');
  // Section counts are the cards on screen, never the duplicated ones.
  const counts = await page.locator('#clients-list .contact-group-count').allTextContents();
  expect(counts.map(Number).reduce((sum, value) => sum + value, 0)).toBe(2);
  // The tools that only exist here stay.
  await expect(page.locator('#clients-download')).toBeVisible();
  await expect(page.locator('#clients-followup')).toBeVisible();
  // The spreadsheet stays whole (it never depended on the screen).
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#clients-download').click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  for (const name of ['Ana No Todos', 'Bia No Todos', 'Caio Concluido', 'Duda Parada Com Cliente']) expect(csv).toContain(name);
  expect(errors).toEqual([]);
});

test('todos os clientes do filtro já estão no TODOS: o "Mais" diz isso em vez de repetir os cartões', async ({ page }) => {
  const errors = await open(page, { listed: LISTED.slice(0, 2) });
  await expect(page.locator('#clients-list')).toContainText('Todos os clientes deste filtro já estão no TODOS acima', { timeout: 30000 });
  await expect(page.locator('#clients-list .client-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});

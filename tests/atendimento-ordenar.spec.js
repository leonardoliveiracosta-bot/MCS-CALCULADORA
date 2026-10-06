'use strict';

// ATENDIMENTO · Ordenar: com outra ordem que não "Pronto para ligar", a tela mantém a ordem do servidor
// (antes os grupos Não atendidos/Atendidos e o tipo de busca refaziam a ordem e "Mais recentes" não mudava nada).
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/atendimento-ordenar.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `7f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const group = (key, extra = {}) => ({ key, label: key === 'NAO_ATENDIDO' ? 'Não atendidos' : 'Atendidos', origin: { key: 'MENSAGEM:WHATSAPP', label: 'Veio por mensagem · Via WhatsApp', financing: false }, unattended: null, hasCalculator: false, calcMode: null, ...extra });
const journey = (n, name, hours, extra) => ({ kind: 'JOURNEY', id: id(n), name, contact: { display_name: name }, phones: [{ phone_e164: '+1305555020' + n, is_primary: true }], next_action_text: null, next_action_at: null, sortAt: iso(hours), lastCustomerAt: iso(hours), ...extra });
// Antiga: não atendida há 30 h. Recente: atendida, última mensagem há 1 h.
const OLD = journey(1, 'Antiga Espera', 30, { group: group('NAO_ATENDIDO', { unattended: { reasonText: 'Mensagem do cliente sem resposta', waitedText: '30 h', missing: 'Resposta', next: 'Responder o cliente' } }) });
const NEW = journey(2, 'Recente Conversa', 1, { group: group('ATENDIDO') });

test('Ordenar · Mais recentes muda a ordem dos cartões', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    // The server already orders by the chosen sort (panel-sort); the screen must keep it.
    if (url.pathname === '/api/panel/today') return json({ meta: { dataUpdatedAt: new Date().toISOString() }, items: url.searchParams.get('sort') === 'recent' ? [NEW, OLD] : [OLD, NEW] });
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('#today-list .case-card');
  await expect(cards).toHaveCount(2, { timeout: 30000 });
  await expect(cards.nth(0)).toContainText('Antiga Espera');
  await page.selectOption('#today-sort', 'recent');
  await expect(cards.nth(0)).toContainText('Recente Conversa', { timeout: 15000 });
  await expect(cards.nth(1)).toContainText('Antiga Espera');
  await page.selectOption('#today-sort', 'oldest');
  await page.selectOption('#today-sort', 'recent');
  await expect(cards.nth(0)).toContainText('Recente Conversa', { timeout: 15000 });
  expect(errors).toEqual([]);
});

'use strict';

// A aba TODOS deixou de existir: o painel tem quatro abas e o conteúdo dela fica no bloco recolhido
// "Mais" de ATENDER AGORA (lista com filtros, planilha, relatório, retomar conversas e pendências gerais).
// O atalho "Sem resposta há mais de 24 h" do resumo semanal abre ATENDER AGORA com o filtro novo de > 24 h.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/todos-removida.spec.js
const fs = require('node:fs');
const { test, expect } = require('@playwright/test');
const { clientsPage } = require('../api/panel/records');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const DAY = 86400000;
const iso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const id = (n) => `7e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const group = { key: 'NAO_ATENDIDO', label: 'Não atendidos', origin: { key: 'MENSAGEM:WHATSAPP', label: 'Veio por mensagem · Via WhatsApp', financing: false }, unattended: { reasonText: 'Mensagem do cliente sem resposta', waitedText: '—', missing: 'Resposta', next: 'Responder o cliente' }, hasCalculator: false, calcMode: null };
const message = (hours, direction, extra = {}) => ({ direction, occurred_at_utc: iso(hours), body_text: 'Oi', is_automatic: false, ...extra });
const journey = (n, name, latest) => ({ kind: 'JOURNEY', id: id(n), name, contact: { display_name: name }, phones: [{ phone_e164: '+1305555030' + n, is_primary: true }], next_action_text: null, next_action_at: null, sortAt: latest.occurred_at_utc, lastCustomerAt: latest.occurred_at_utc, latestMessage: latest, awaitingReply: latest.direction === 'CUSTOMER', group });
const TODAY = [
  journey(1, 'Ana Atrasada', message(30, 'CUSTOMER')),
  journey(2, 'Bia Recente', message(2, 'CUSTOMER')),
  journey(3, 'Caio Respondido', message(40, 'MCS')),
  journey(4, 'Duda Automática', message(50, 'CUSTOMER', { is_automatic: true }))
];
const client = (n, name, days) => ({ id: id(100 + n), name, contact: { display_name: name }, phones: [], stage: 'RESPONDIDO', status: 'ATIVO', checklist: [], origins: ['WHATSAPP'], calculatorTypes: [], lastActivityAt: new Date(Date.now() - days * DAY).toISOString(), situation: 'IN_PROGRESS' });
const LISTED = [client(1, 'Eva Cliente', 3), client(2, 'Fred Cliente', 12)];

async function open(page) {
  const calls = [];
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  page.on('console', (entry) => { if (entry.type() === 'error' && !/Failed to load resource/.test(entry.text())) errors.push(entry.text()); });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') return json({ meta: { dataUpdatedAt: new Date().toISOString() }, items: TODAY });
    if (url.pathname === '/api/panel/weekly') return json({ generatedAt: new Date().toISOString(), leads: {}, unanswered24h: { current: 1, previous: 0, trend: 'up' } });
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') !== 'manheim') return json({ ...clientsPage(LISTED, Object.fromEntries(url.searchParams)), pending: { counts: { NO_RESPONSE: 1 } }, meta: {} });
    if (url.pathname === '/api/panel/report') return json({ view: 'records', summary: {}, text: 'FICHAS: teste' });
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#today-list .case-card').first()).toBeVisible({ timeout: 30000 });
  return { calls, errors };
}
const directoryCalls = (calls) => calls.filter((call) => call.path === '/api/panel/records' && call.params.view !== 'manheim');

test('seis abas (com V1 e V2), sem TODOS; a lista de clientes só carrega ao abrir "Mais" e todas as funções funcionam lá', async ({ page }) => {
  const { calls, errors } = await open(page);
  await expect(page.locator('.tab[data-view]')).toHaveText([/^TODOS/, /^V1/, /^V2/, /BUSCAR CARROS/, /ENVIAR OPÇÕES/, /IMPORTAÇÕES/]);
  await expect(page.locator('[data-view="clients"]')).toHaveCount(0);
  // Closed: no directory request at all (the old tab badge and its boot priming are gone).
  const more = page.locator('#today-more');
  await expect(more).not.toHaveAttribute('open', '');
  await page.waitForTimeout(1500);
  expect(directoryCalls(calls)).toEqual([]);
  // Open: list, filters, counters, pendências gerais and retomar conversas.
  await more.locator('> summary').click();
  await expect(page.locator('#clients-list .client-card')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('#clients-general-card')).toBeVisible();
  await expect(page.locator('#clients-stats')).toBeVisible();
  const followup = page.locator('#clients-followup');
  await expect(followup).toBeVisible();
  await followup.locator('> summary').click();
  await expect(followup).toHaveAttribute('open', '');
  // Filters still drive the same server query.
  await page.locator('#clients-activity').selectOption('all');
  await expect.poll(() => calls.some((call) => call.path === '/api/panel/records' && call.params.period === 'all')).toBe(true);
  // Spreadsheet: same universe as the list (same /api/panel/records rules).
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#clients-download').click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  expect(csv).toContain('Eva Cliente');
  expect(csv).toContain('Fred Cliente');
  // Report of the list keeps following the list period.
  // A ficha opened from the list comes back to the open block.
  await page.locator('#clients-list .client-card').first().click();
  await expect(page).toHaveURL(/#ficha\//);
  await page.goBack();
  await expect(page.locator('#today-more')).toHaveAttribute('open', '');
  await expect(page.locator('#clients-list .client-card')).toHaveCount(2, { timeout: 30000 });
  // Old #todos / #clientes links open ATENDER AGORA.
  await page.goto(base + '/painel/#clientes', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#page-title')).toHaveText('TODOS', { timeout: 30000 });
  expect(errors).toEqual([]);
});

test('"Sem resposta há mais de 24 h" do resumo semanal abre ATENDER AGORA com o filtro de > 24 h', async ({ page }) => {
  const { errors } = await open(page);
  const weekly = page.locator('#weekly-summary');
  await weekly.locator('> summary').click();
  await page.locator('#weekly-summary-content .weekly-metric', { hasText: 'Sem resposta há mais de 24 h' }).locator('button').click();
  await expect(page.locator('#page-title')).toHaveText('TODOS');
  // Only the client whose last real message is theirs and older than 24 h (not the recent one, not one
  // answered by the MCS, not an automatic message).
  await expect(page.locator('#today-list .case-card')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('#today-list .case-card')).toContainText('Ana Atrasada');
  await expect(page.locator('[data-today-stat="late24"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-today-stat="late24"] strong')).toHaveText('1');
  await expect(page.locator('.today-stat-clear')).toContainText('Sem resposta há mais de 24 h');
  // Clearing the filter shows every case of the bucket again.
  await page.locator('.today-stat-clear').click();
  await expect(page.locator('#today-list .case-card')).toHaveCount(4);
  expect(errors).toEqual([]);
});

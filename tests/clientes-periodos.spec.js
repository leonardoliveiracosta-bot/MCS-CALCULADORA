'use strict';

// CLIENTES por período no navegador, com /api/** simulado e dados fictícios: abre em 30 dias,
// períodos cumulativos, contador da aba, contadores de situação, planilha e relatório acompanham
// o período, e os demais filtros continuam funcionando junto. Desktop e 390 px.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/clientes-periodos.spec.js
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
const SHOTS = process.env.VISUAL_SHOTS || '';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const DAY = 86400000;
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();
const uuid = (n) => `6b000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const client = (n, name, days, extra = {}) => ({ id: uuid(n), name, contact: { display_name: name }, phones: [], stage: 'RESPONDIDO', status: 'ATIVO', checklist: [], origins: ['WHATSAPP'], calculatorTypes: ['SEM_CALCULADORA'], lastActivityAt: days === null ? null : ago(days), isLead: true, ...extra });
const ITEMS = [
  client(1, 'Ana 10 dias', 10, { origins: ['CALCULADORA'], calculatorTypes: ['SIMULACAO'] }),
  client(2, 'Bia 31 dias', 31),
  client(3, 'Caio 120 dias', 120, { origins: ['CALCULADORA'], calculatorTypes: ['BUSCA'] }),
  client(4, 'Duda 200 dias', 200),
  client(5, 'Edu 500 dias', 500),
  client(6, 'Fábio sem atividade', null),
  client(7, 'Gil não lead', 5, { isLead: false })
];
const PENDING = { items: [
  { journeyId: uuid(1), situation: 'NO_RESPONSE' }, { journeyId: uuid(2), situation: 'MCS_PENDING' },
  { journeyId: uuid(3), situation: 'NO_RESPONSE' }, { journeyId: uuid(5), situation: 'CLOSED' }
], counts: { NO_RESPONSE: 99, MCS_PENDING: 99, CUSTOMER_PENDING: 99, IN_PROGRESS: 99, CLOSED: 99 } };

async function open(page, width) {
  const calls = [];
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
    // An old session saved "Tudo": CLIENTES must still open in 30 days.
    localStorage.setItem('mcs_clients-activity', 'all');
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/records') return json({ items: ITEMS, meta: {} });
    if (url.pathname === '/api/panel/pendencias') return json(PENDING);
    if (url.pathname === '/api/panel/report') return json({ view: 'records', summary: {}, text: 'FICHAS: teste' });
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="clients"]').click();
  await expect(page.locator('#clients-list .client-card').first()).toBeVisible({ timeout: 30000 });
  return calls;
}

const names = (page) => page.locator('#clients-list .client-card .identity-name').allTextContents();
const stat = (page, label) => page.locator('#clients-stats .pending-stat', { hasText: label }).locator('strong');

for (const width of [1280, 390]) {
  test(`${width}px · abre em 30 dias, períodos cumulativos, contador da aba e contadores de situação`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    await open(page, width);
    await expect(page.locator('#clients-activity')).toHaveValue('30');
    const expectations = [
      ['30', ['Ana 10 dias', 'Gil não lead'], 1, 'Período: atividade real nos últimos 30 dias · 1 de 6 clientes'],
      ['90', ['Ana 10 dias', 'Bia 31 dias', 'Gil não lead'], 2, 'Período: atividade real nos últimos 90 dias · 2 de 6 clientes'],
      ['6m', ['Ana 10 dias', 'Bia 31 dias', 'Caio 120 dias', 'Gil não lead'], 3, 'Período: atividade real nos últimos 6 meses · 3 de 6 clientes'],
      ['12m', ['Ana 10 dias', 'Bia 31 dias', 'Caio 120 dias', 'Duda 200 dias', 'Gil não lead'], 4, 'Período: atividade real no último ano · 4 de 6 clientes'],
      ['all', ['Ana 10 dias', 'Bia 31 dias', 'Caio 120 dias', 'Duda 200 dias', 'Edu 500 dias', 'Fábio sem atividade', 'Gil não lead'], 6, 'Período: tudo, sem corte por data · 6 clientes']
    ];
    for (const [period, expected, badge, note] of expectations) {
      await page.locator('#clients-activity').selectOption(period);
      await expect.poll(async () => (await names(page)).sort()).toEqual([...expected].sort());
      // Badge = leads inside the period (the "não é lead" card stays reachable, outside the count).
      await expect(page.locator('[data-count="clients"]')).toHaveText(String(badge));
      await expect(page.locator('#clients-period-note')).toHaveText(note);
    }
    // Situation counters follow the period, not the server totals (99).
    await page.locator('#clients-activity').selectOption('90');
    await expect(stat(page, 'Sem resposta')).toHaveText('1');
    await expect(stat(page, 'Parado com você')).toHaveText('1');
    await expect(stat(page, 'Concluída')).toHaveText('0');
    await page.locator('#clients-activity').selectOption('all');
    await expect(stat(page, 'Sem resposta')).toHaveText('2');
    await expect(stat(page, 'Concluída')).toHaveText('1');
    await page.locator('#clients-activity').selectOption('30');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `clientes-periodo-${width}.png`), fullPage: width !== 390 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test('período junto com os outros filtros, planilha e relatório acompanham o período', async ({ page }) => {
  const calls = await open(page, 1280);
  // Other filters work together with the period.
  await page.locator('#clients-activity').selectOption('6m');
  await page.locator('#clients-type').selectOption('BUSCA');
  await expect.poll(() => names(page)).toEqual(['Caio 120 dias']);
  await page.locator('#clients-activity').selectOption('90');
  await expect(page.locator('#clients-list .client-card')).toHaveCount(0);
  await page.locator('#clients-type').selectOption('all');
  // Spreadsheet: the same people as the list.
  await page.locator('#clients-activity').selectOption('90');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#clients-download').click()]);
  const csv = fs.readFileSync(await download.path(), 'utf8');
  expect(csv).toContain('Ana 10 dias');
  expect(csv).toContain('Bia 31 dias');
  expect(csv).not.toContain('Caio 120 dias');
  expect(csv).not.toContain('Edu 500 dias');
  expect(csv).not.toContain('Gil não lead');
  // Report: opened from CLIENTES, it follows the CLIENTES period (last real activity), not a date range.
  await page.locator('#clients-panel [data-report="records"]').click();
  await expect(page.locator('#report-period-field')).toBeHidden();
  await expect(page.locator('#report-origin-note')).toHaveText('Período de CLIENTES: atividade real nos últimos 90 dias');
  await page.locator('#report-generate').click();
  await expect.poll(() => calls.filter((call) => call.path === '/api/panel/report' && call.params.origin === 'clients' && call.params.view === 'records' && call.params.activity === '90' && !call.params.period
    && Math.abs(Date.parse(call.params.since) - (Date.now() - 90 * DAY)) < 120000).length).toBe(1);
  await page.locator('#report-dialog button[value="cancel"]').click();
  await page.locator('#clients-activity').selectOption('all');
  await page.locator('#clients-panel [data-report="records"]').click();
  await expect(page.locator('#report-origin-note')).toHaveText('Período de CLIENTES: tudo, sem corte por data');
  await page.locator('#report-generate').click();
  await expect.poll(() => calls.filter((call) => call.path === '/api/panel/report' && call.params.origin === 'clients' && call.params.activity === 'all' && !call.params.since).length).toBe(1);
});

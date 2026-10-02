'use strict';

// Lote 4 no navegador (PEDIDOS fundido em ENTRADA e CLIENTES), com /api/** simulado. Pedidos da
// calculadora sem mensagem não são listados: a seção "Pediram contato, sem conversa" saiu da ENTRADA.
// Run: PANEL_VISUAL_LOCAL=1 npx playwright test tests/lote4.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const iso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

async function session(page) {
  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
  });
}

async function mockApi(page, overrides = {}) {
  const calls = [];
  await page.route('**/supabase-simulado/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    calls.push({ path: url.pathname, search: url.search, params: Object.fromEntries(url.searchParams), body });
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    for (const [pattern, handler] of Object.entries(overrides)) if (url.pathname === pattern) return handler({ url, body, json, route });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/actions') return json({ ok: true });
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  return calls;
}

test('Lote 4: seis abas; ENTRADA carrega sem a seção de pedidos sem conversa', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const calls = await mockApi(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-view]')).toHaveText([/HOJE/, /ENTRADA/, /CLIENTES/, /PESQUISAS/, /OPÇÕES/, /IMPORTAÇÕES/], { timeout: 30000 });
  await page.locator('[data-view="entry"]').click();
  await expect(page.locator('#entry-panel')).toBeVisible();
  await expect(page.locator('#page-title')).toHaveText('ENTRADA');
  await expect(page.locator('#entry-add-title')).toBeVisible();
  await expect(page.locator('[data-count="entry"]')).toHaveText('0');
  // A calculator order with no message is never listed: the section and its hooks are gone.
  await expect(page.locator('#entry-orders, #entry-simulated, [data-entry-orders-period], .entry-orders, .entry-simulated')).toHaveCount(0);
  await expect(page.locator('#entry-panel')).not.toContainText('Pediram contato, sem conversa');
  await expect(page.locator('#entry-panel')).not.toContainText('Só simularam');
  // ENTRADA still loads its queue.
  await expect.poll(() => calls.some((call) => call.path === '/api/panel/entry')).toBe(true);
  expect(calls.some((call) => call.path === '/api/panel/orders' && call.params.scope === 'unlinked')).toBe(false);
  expect(errors).toEqual([]);
});

test('Lote 4: CLIENTES filtra por Origem, Tipo e Período', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const origin = (group, sub, label) => ({ group, sub, key: group + ':' + sub, label, financing: false });
  const client = (id, name, origins, calculatorTypes, hours, groupOrigin) => ({ id, name, contact: { display_name: name }, phones: [], stage: 'RESPONDIDO', status: 'ATIVO', checklist: [], origins, calculatorTypes, lastActivityAt: iso(hours), isLead: true,
    group: { key: 'ATENDIDO', label: 'Atendidos', origin: groupOrigin, unattended: null, hasCalculator: groupOrigin.group === 'CALCULADORA' } });
  // The real server filter (clientsPage) over the fictitious list.
  const { clientsPage } = require('../api/panel/records');
  const listed = [
    client('54000000-0000-4000-8000-000000000011', 'Bruno Calc', ['CALCULADORA', 'WHATSAPP'], ['SIMULACAO'], 2, origin('CALCULADORA', 'WHATSAPP', 'Veio pela calculadora · Via WhatsApp')),
    client('54000000-0000-4000-8000-000000000012', 'Carla Busca', ['CALCULADORA'], ['BUSCA'], 24 * 20, origin('CALCULADORA', 'WHATSAPP', 'Veio pela calculadora · Via WhatsApp')),
    client('54000000-0000-4000-8000-000000000013', 'Davi SMS', ['SMS'], ['SEM_CALCULADORA'], 24 * 60, origin('MENSAGEM', 'SMS', 'Veio por mensagem · Via SMS'))
  ];
  await mockApi(page, {
    '/api/panel/records': ({ json, url }) => json({ ...clientsPage(listed, Object.fromEntries(new URL(url).searchParams)), pending: {}, meta: {} }),
    '/api/panel/pendencias': ({ json }) => json({ items: [], counts: {} })
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="clients"]').click();
  const list = page.locator('#clients-list');
  // CLIENTES opens in 30 days: Davi (60 days) waits for a longer period.
  await expect(list.locator('.client-card')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('#clients-activity')).toHaveValue('30');
  await page.locator('#clients-activity').selectOption('all');
  await expect(list.locator('.client-card')).toHaveCount(3);
  await expect(list.locator('.client-card', { hasText: 'Bruno Calc' }).locator('.origin-chip')).toContainText('Veio pela calculadora · Via WhatsApp');
  await page.locator('#clients-origin').selectOption('MENSAGEM:SMS');
  await expect(list.locator('.client-card')).toHaveCount(1);
  await expect(list).toContainText('Davi SMS');
  await page.locator('#clients-origin').selectOption('all');
  await page.locator('#clients-type').selectOption('BUSCA');
  await expect(list.locator('.client-card')).toHaveCount(1);
  await expect(list).toContainText('Carla Busca');
  await page.locator('#clients-type').selectOption('all');
  await page.locator('#clients-activity').selectOption('30');
  await expect(list.locator('.client-card')).toHaveCount(2);
  await expect(list).not.toContainText('Davi SMS');
  await page.locator('#clients-activity').selectOption('90');
  await expect(list.locator('.client-card')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('Lote 4: link antigo #pedidos abre ENTRADA e #pedido/REF abre o pedido', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const calls = await mockApi(page, {
    '/api/panel/lead': ({ json }) => json({ ref: 'ABC23', hasCalculatorRef: true, order: { ref: 'ABC23' }, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [], zip: '', timezone: 'America/New_York', goodHour: true, payment: 'cash', plate: 'transf', florida: true, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [], record: null })
  });
  await page.goto(base + '/painel/#pedidos', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#entry-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#page-title')).toHaveText('ENTRADA');
  await page.goto(base + '/painel/#pedido/ABC23', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => calls.some((call) => call.path === '/api/panel/lead' && call.params.ref === 'ABC23')).toBe(true);
  expect(errors).toEqual([]);
});

test('Lote 4: no celular (360 px) a ENTRADA cabe na tela, sem a seção de pedidos', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 360, height: 780 });
  await session(page);
  await mockApi(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="entry"]').click();
  await expect(page.locator('#entry-panel')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#entry-orders')).toHaveCount(0);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
  const box = await page.locator('#entry-panel').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(errors).toEqual([]);
});

'use strict';

// Lote 4 no navegador (PEDIDOS fundido em ENTRADA e CLIENTES), com /api/** simulado.
// Run: PANEL_VISUAL_LOCAL=1 npx playwright test tests/lote4.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const JOURNEY = '54000000-0000-4000-8000-000000000001';
const iso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

async function session(page) {
  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
  });
}

function order(ref, extra = {}) {
  return { key: 'ref:' + ref, kind: 'CALCULATOR', ref, logicalMode: 'VALOR', logicalModes: ['VALOR'], simulationCount: 1, occurredAt: iso(2), vehicleText: 'BMW X5', budgetCents: 3000000, contactChannel: 'SMS_CLICK', enteredContact: true, pending: true, phones: [], ...extra };
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
    if (url.pathname === '/api/panel/orders' && url.searchParams.get('scope') === 'unlinked') {
      const group = url.searchParams.get('group');
      const items = group === 'simulated' ? [order('SIM22', { enteredContact: false, contactChannel: null })] : [order('PED23'), order('PED24', { logicalMode: 'CARRO', logicalModes: ['CARRO'] })];
      return json({ items, counts: { contacted: 2, simulated: 1 }, linkTargets: [{ journeyId: JOURNEY, contactId: JOURNEY, label: 'Ana · Ref ABC23 — BMW X5' }], page: { total: items.length, hasMore: false }, meta: {} });
    }
    if (url.pathname === '/api/panel/actions') return json({ ok: true });
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  return calls;
}

test('Lote 4: quatro abas; ENTRADA mostra os pedidos sem conversa recolhidos, com contador próprio', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const calls = await mockApi(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('[data-view]')).toHaveText([/HOJE/, /ENTRADA/, /CLIENTES/, /BUSCAS/], { timeout: 30000 });
  await page.locator('[data-view="entry"]').click();
  const section = page.locator('#entry-orders');
  await expect(page.locator('#entry-orders-count')).toHaveText('2');
  await expect(section).not.toHaveAttribute('open', '');
  // D2: the section never adds to the ENTRADA badge.
  await expect(page.locator('[data-count="entry"]')).toHaveText('0');
  await section.locator('summary').first().click();
  await expect(section.locator('#entry-orders-list .item-card')).toHaveCount(2);
  await expect(section.locator('#entry-orders-list')).toContainText('PED23');
  await expect(page.locator('#entry-simulated-count')).toHaveText('(1)');
  expect(calls.some((call) => call.params.group === 'simulated')).toBe(false);
  await page.locator('#entry-simulated > summary').click();
  await expect(page.locator('#entry-simulated-list')).toContainText('SIM22');
  await section.locator('[data-entry-orders-period="7"]').click();
  await expect.poll(() => calls.filter((call) => call.params.scope === 'unlinked' && call.params.period === '7').length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('Lote 4: cartão do pedido na ENTRADA mantém Ligar a um lead e Tratado', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const calls = await mockApi(page);
  await page.goto(base + '/painel/#entrada', { waitUntil: 'domcontentloaded' });
  await page.locator('#entry-orders > summary').click();
  const card = page.locator('#entry-orders-list .item-card', { hasText: 'PED23' });
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.locator('select').selectOption({ label: 'Ana · Ref ABC23 — BMW X5' });
  await card.getByRole('button', { name: 'Ligar a um lead' }).click();
  await expect.poll(() => calls.find((call) => call.body?.action === 'link_request')?.body).toMatchObject({ action: 'link_request', journeyId: JOURNEY, calcRef: 'PED23' });
  const other = page.locator('#entry-orders-list .item-card', { hasText: 'PED24' });
  await other.getByRole('button', { name: 'Tratado' }).click();
  await expect.poll(() => calls.find((call) => call.body?.action === 'set_disposition')?.body).toMatchObject({ itemKind: 'REF', itemKey: 'PED24', status: 'TREATED' });
  expect(errors).toEqual([]);
});

test('Lote 4: tocar no cartão ou em "Abrir pedido" abre o pedido; ação mantém os cartões já carregados', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const many = Array.from({ length: 25 }, (_, index) => order('P' + String.fromCharCode(65 + index) + 'A2'));
  const calls = await mockApi(page, {
    '/api/panel/orders': ({ url, json }) => {
      const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
      const items = many.slice(offset, offset + limit);
      return json({ items, counts: { contacted: many.length, simulated: 0 }, linkTargets: [], page: { total: many.length, hasMore: offset + items.length < many.length }, meta: {} });
    },
    '/api/panel/lead': ({ json }) => json({ ref: 'PAA2', order: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [], zip: '', timezone: 'America/New_York', calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [], record: null })
  });
  await page.goto(base + '/painel/#entrada', { waitUntil: 'domcontentloaded' });
  await page.locator('#entry-orders > summary').click();
  const list = page.locator('#entry-orders-list');
  await expect(list.locator('.item-card')).toHaveCount(20, { timeout: 30000 });
  await page.locator('#entry-orders-more').click();
  await expect(list.locator('.item-card')).toHaveCount(25);
  await list.locator('.item-card', { hasText: 'PWA2' }).getByRole('button', { name: 'Tratado' }).click();
  await expect.poll(() => calls.filter((call) => call.body?.action === 'set_disposition').length).toBe(1);
  await expect.poll(() => calls.filter((call) => call.params.scope === 'unlinked' && call.params.limit === '25').length).toBeGreaterThan(0);
  await expect(list.locator('.item-card')).toHaveCount(25);
  await list.locator('.item-card h3').first().click();
  await expect(page.locator('#detail-panel')).toBeVisible();
  await expect.poll(() => calls.some((call) => call.path === '/api/panel/lead' && call.params.ref === 'PAA2')).toBe(true);
  await page.goto(base + '/painel/#entrada', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#entry-panel')).toBeVisible();
  if (!(await page.locator('#entry-orders').evaluate((node) => node.open))) await page.locator('#entry-orders > summary').click();
  await list.locator('.item-card').nth(1).getByRole('button', { name: 'Abrir pedido' }).click();
  await expect.poll(() => calls.some((call) => call.path === '/api/panel/lead' && call.params.ref === 'PBA2')).toBe(true);
  expect(errors).toEqual([]);
});

test('Lote 4: CLIENTES filtra por Origem, Tipo e Período', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const client = (id, name, origins, calculatorTypes, hours) => ({ id, name, contact: { display_name: name }, phones: [], stage: 'RESPONDIDO', status: 'ATIVO', checklist: [], origins, calculatorTypes, lastActivityAt: iso(hours), isLead: true });
  await mockApi(page, {
    '/api/panel/records': ({ json }) => json({ items: [
      client('54000000-0000-4000-8000-000000000011', 'Bruno Calc', ['CALCULADORA', 'WHATSAPP'], ['SIMULACAO'], 2),
      client('54000000-0000-4000-8000-000000000012', 'Carla Busca', ['CALCULADORA'], ['BUSCA'], 24 * 20),
      client('54000000-0000-4000-8000-000000000013', 'Davi SMS', ['SMS'], ['SEM_CALCULADORA'], 24 * 60)
    ], meta: {} }),
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
  await expect(list.locator('.client-card', { hasText: 'Bruno Calc' })).toContainText('Calculadora · Simulação');
  await page.locator('#clients-origin').selectOption('SMS');
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

test('Lote 4: no celular (360 px) a seção de pedidos cabe na tela', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 360, height: 780 });
  await session(page);
  await mockApi(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="entry"]').click();
  await page.locator('#entry-orders > summary').click();
  await expect(page.locator('#entry-orders-list .item-card').first()).toBeVisible({ timeout: 30000 });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(360);
  const box = await page.locator('#entry-orders').boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(errors).toEqual([]);
});

'use strict';

// Lote 1 da auditoria no navegador, com /api/** simulado (nenhuma chamada real, nada enviado).
// Run: PANEL_VISUAL_LOCAL=1 npx playwright test tests/lote1.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const JOURNEY = '51000000-0000-4000-8000-000000000001';

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
    calls.push({ path: url.pathname, search: url.search, body });
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    for (const [pattern, handler] of Object.entries(overrides)) if (url.pathname === pattern) return handler({ url, body, json, route });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  return calls;
}

test('C5: contador com erro 500 não desloga; mostra "—" e aviso', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  await mockApi(page, { '/api/panel/searches': ({ json }) => json({ error: 'PANEL_ACTION_FAILED' }, 500) });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#boot-warning')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#login-view')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('mcs_panel_session'))).not.toBeNull();
  await expect(page.locator('[data-count="searches"]').first()).toHaveText('—');
  expect(errors).toEqual([]);
});

function leadData(lastCustomerAt) {
  return {
    ref: 'ABC23', hasCalculatorRef: false, order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [],
    zip: '', state: null, city: null, timezone: 'America/New_York', goodHour: true, payment: 'cash', plate: 'transf', florida: true,
    maxBidCents: null, totalCeilingCents: null, bid: null, costs: null, score: null, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [],
    record: { id: JOURNEY, status: 'ATIVO', stage: 'RESPONDIDO', enabled: true, contact: { display_name: 'Cliente Teste' }, phones: [], attachments: [], returns: [],
      conversation: [{ id: 'm1', chat_id: 'c1', channel: 'WHATSAPP', direction: 'CUSTOMER', body_text: 'Oi, ainda tem o carro?', occurred_at_utc: lastCustomerAt }] }
  };
}

for (const scenario of [{ name: 'aparece com mensagem do cliente nas últimas 24 h', hoursAgo: 2, open: true }, { name: 'não aparece fora da janela de 24 h', hoursAgo: 30, open: false }]) {
  test(`A20: "Responder pelo painel" ${scenario.name}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    await session(page);
    const lastAt = new Date(Date.now() - scenario.hoursAgo * 3600000).toISOString();
    const calls = await mockApi(page, {
      '/api/panel/lead': ({ json }) => json(leadData(lastAt)),
      '/api/panel/reply': ({ body, json }) => {
        if (body.action === 'window') return json(scenario.open ? { allowed: true, openUntil: new Date(Date.parse(lastAt) + 86400000).toISOString(), lastCustomerAt: lastAt } : { allowed: false });
        return json({ error: 'NOT_EXPECTED_IN_TEST' }, 400);
      }
    });
    await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lead-conversation')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => calls.some((call) => call.path === '/api/panel/reply' && call.body?.action === 'window')).toBe(true);
    if (scenario.open) {
      await expect(page.locator('#lead-conversation .reply-composer')).toBeVisible();
      await expect(page.locator('#lead-conversation .reply-composer h4')).toHaveText('Responder pelo painel');
      await expect(page.locator('#lead-conversation .reply-composer button', { hasText: 'Enviar' })).toBeDisabled();
    } else {
      await expect(page.locator('#lead-conversation [data-reply-closed="true"]')).toBeVisible();
      await expect(page.locator('#lead-conversation .reply-composer')).toHaveCount(0);
    }
    expect(calls.filter((call) => call.path === '/api/panel/reply' && call.body?.action === 'send')).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

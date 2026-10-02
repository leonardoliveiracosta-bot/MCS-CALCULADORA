'use strict';

// Lote 3 da auditoria no navegador, com /api/** simulado (nenhuma chamada real, nada enviado).
// Run: PANEL_VISUAL_LOCAL=1 npx playwright test tests/lote3.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const JOURNEY = '53000000-0000-4000-8000-000000000001';
const READ = '53000000-0000-4000-8000-000000000002';

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

function leadData(record) {
  return {
    ref: 'ABC23', hasCalculatorRef: false, order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [],
    zip: '', state: null, city: null, timezone: 'America/New_York', goodHour: true, payment: 'cash', paymentKnown: null, deadlineKnown: null, zipKnown: false, plate: 'transf', florida: true,
    maxBidCents: null, totalCeilingCents: null, bid: null, costs: null, score: null, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [],
    record: { id: JOURNEY, stage: 'RESPONDIDO', status: 'ATIVO', enabled: true, contact: { display_name: 'Cliente Teste' }, phones: [], attachments: [], returns: [], conversation: [], units: [], ...record }
  };
}

test('Lote 3: print de SMS que só bate pelo nome espera na ENTRADA e vira lead novo por escolha', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const calls = await mockApi(page, {
    '/api/panel/entry': ({ json }) => json({ chats: [], reviews: [], contacts: [], journeys: [], chatAliases: [], senderAliases: [], printReviews: [
      { id: READ, filename: 'print.png', name: 'Ana Souza', phone: '+13055550000', ref: null, message: 'I want a RAV4', translation: '', candidate: { journeyId: JOURNEY, name: 'Ana Souza', ref: 'ABC23' } }
    ] }),
    '/api/panel/sms-print': ({ json }) => json({ journeyId: JOURNEY, contactId: JOURNEY }, 201)
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="imports"]').click();
  const card = page.locator('#imports-review-queue .queue-item', { hasText: 'Print de SMS · Ana Souza' });
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(card).toContainText('O nome bate com Ana Souza · Ref ABC23, mas o telefone não');
  // A print is not a contact: it is counted in IMPORTAÇÕES, never in ATENDIMENTO.
  await expect(page.locator('[data-count="imports"]')).toHaveText('1');
  await expect(page.locator('[data-count="today"]')).toHaveText('0');
  await card.getByRole('button', { name: 'Criar lead novo' }).click();
  await expect.poll(() => calls.find((call) => call.path === '/api/panel/sms-print')?.body).toMatchObject({ action: 'confirm', auto: true, newLead: true, readId: READ, phone: '+13055550000' });
  expect(errors).toEqual([]);
});

test('Lote 3: "Não chegou SMS" pergunta antes de descartar e grava o motivo Outro', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const calls = await mockApi(page, {
    '/api/panel/today': ({ json }) => json({ items: [{ kind: 'JOURNEY', id: JOURNEY, journeyId: JOURNEY, name: 'Caio', contact: { display_name: 'Caio' }, phones: [], contactChannel: 'SMS_CLICK', smsPrintConfirmed: false, todayReasons: [], awaitingReply: true }], meta: {} }),
    '/api/panel/actions': ({ json }) => json({ status: 'DISCARDED', discardReason: 'OTHER' })
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  // The rarer actions of an ATENDIMENTO card are under "⋯" on the same card.
  await page.locator('#today-list .case-more > summary').first().click({ timeout: 30000 });
  const absent = page.getByRole('button', { name: 'Não chegou SMS · descartar' });
  await expect(absent.first()).toBeVisible({ timeout: 30000 });
  await absent.first().click();
  await expect(page.getByText('Isso descarta o lead com o motivo "Outro"')).toBeVisible();
  await page.getByRole('button', { name: 'Cancelar' }).click();
  expect(calls.some((call) => call.body?.action === 'set_disposition')).toBe(false);
  await absent.first().click();
  await page.getByRole('button', { name: 'Descartar lead' }).click();
  await expect.poll(() => calls.find((call) => call.body?.action === 'set_disposition')?.body).toMatchObject({ status: 'DISCARDED', reason: 'OTHER' });
  expect(errors).toEqual([]);
});

test('Lote 3: vitrine "Tratado" com falha volta o card e mostra o erro', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  await mockApi(page, {
    '/api/panel/vitrine-requests': ({ json, body }) => body ? json({ error: 'VITRINE_REQUEST_FAILED' }, 500) : json({ requests: [{ id: READ, kind: 'VIEW', name: 'Bia', phone: '+13055551111', referenceCode: 'ABC23', car: '2021 BMW X5', journeyId: JOURNEY }], signals: [] })
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  const card = page.locator('.vitrine-request-card', { hasText: 'Bia' });
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.getByRole('button', { name: 'Pedido atendido' }).click();
  await expect(card).toContainText('Não consegui marcar como atendido, tente de novo');
  await expect(card).toBeVisible();
  expect(errors).toEqual([]);
});

test('Lote 3: busca global fecha no botão e some ao trocar de aba', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  await mockApi(page, { '/api/panel/search': ({ json }) => json({ items: [{ kind: 'JOURNEY', name: 'Sem Ficha', matchedBy: 'nome', phone: '+13055552222' }] }) });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('#global-search-input').fill('Sem Ficha');
  await page.locator('#global-search button[type="submit"]').click();
  const results = page.locator('#search-results');
  await expect(results).toBeVisible({ timeout: 30000 });
  await expect(results.locator('.search-hit')).toBeDisabled();
  await expect(results).toContainText('sem ficha aberta');
  await results.getByRole('button', { name: 'Fechar busca' }).click();
  await expect(results).toBeHidden();
  await page.locator('#global-search button[type="submit"]').click();
  await expect(results).toBeHidden();
  await page.locator('#global-search-input').fill('Sem Ficha');
  await page.locator('#global-search button[type="submit"]').click();
  await expect(results).toBeVisible();
  await page.locator('[data-view="clients"]').click();
  await expect(results).toBeHidden();
  expect(errors).toEqual([]);
});

test('Lote 3: no celular (360 px) o menu ⋯ da mensagem fica dentro da tela', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 360, height: 780 });
  await session(page);
  await mockApi(page, { '/api/panel/lead': ({ json }) => json(leadData({ conversation: [{ id: READ, chat_id: JOURNEY, channel: 'WHATSAPP', direction: 'CUSTOMER', body_text: 'Quero uma X5 2021', occurred_at_utc: new Date().toISOString() }] })) });
  await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
  const summary = page.locator('.message-menu > summary').first();
  await expect(summary).toBeVisible({ timeout: 30000 });
  await summary.click();
  const panel = page.locator('.message-menu-panel').first();
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(errors).toEqual([]);
});

test('Lote 3: print sem telefone pede o número antes de salvar', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const calls = await mockApi(page, {
    '/api/panel/entry': ({ json }) => json({ chats: [], reviews: [], contacts: [], journeys: [], chatAliases: [], senderAliases: [], printReviews: [
      { id: READ, filename: 'print.png', name: 'Maria Silva', phone: null, ref: null, message: 'Hi, any Tacoma?', translation: '', candidate: { journeyId: JOURNEY, name: 'Maria Silva', ref: null } }
    ] }),
    '/api/panel/sms-print': ({ json }) => json({ journeyId: JOURNEY, contactId: JOURNEY }, 201)
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="imports"]').click();
  const card = page.locator('#imports-review-queue .queue-item', { hasText: 'Print de SMS · Maria Silva' });
  await expect(card).toBeVisible({ timeout: 30000 });
  await card.getByRole('button', { name: 'Guardar em Maria Silva' }).click();
  await expect(card).toContainText('Digite o telefone do cliente antes de salvar');
  expect(calls.some((call) => call.path === '/api/panel/sms-print')).toBe(false);
  await card.getByLabel('Telefone do cliente (o print não mostra)').fill('+13055553333');
  await card.getByRole('button', { name: 'Guardar em Maria Silva' }).click();
  await expect.poll(() => calls.find((call) => call.path === '/api/panel/sms-print')?.body).toMatchObject({ action: 'confirm', targetJourneyId: JOURNEY, keepSource: true, phone: '+13055553333' });
  expect(errors).toEqual([]);
});

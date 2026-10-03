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


function leadData(record) {
  return {
    ref: 'ABC23', hasCalculatorRef: false, order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [],
    zip: '', state: null, city: null, timezone: 'America/New_York', goodHour: true, payment: 'cash', paymentKnown: null, deadlineKnown: null, zipKnown: false, plate: 'transf', florida: true,
    maxBidCents: null, totalCeilingCents: null, bid: null, costs: null, score: null, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [],
    record: { id: JOURNEY, stage: 'RESPONDIDO', contact: { display_name: 'Cliente Teste' }, phones: [], attachments: [], returns: [], conversation: [], units: [], ...record }
  };
}

test('Lote 2: HOJE mostra retorno vencido e conta só quem aguarda resposta', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  await mockApi(page, { '/api/panel/today': ({ json }) => json({ items: [
    { kind: 'JOURNEY', id: JOURNEY, journeyId: JOURNEY, name: 'Ana', contact: { display_name: 'Ana' }, phones: [], todayReasons: [{ kind: 'NEXT_ACTION', label: 'RETORNO VENCIDO', detail: 'Ligar', urgency: 'red' }], awaitingReply: false },
    { kind: 'JOURNEY', id: uuidLike(2), journeyId: uuidLike(2), name: 'Bia', contact: { display_name: 'Bia' }, phones: [], todayReasons: [], awaitingReply: true }
  ], meta: {} }) });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#today-list .today-card')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('#today-list .today-card').first()).toContainText('Retorno vencido');
  await expect(page.locator('#today-stats')).toContainText('1Aguardando sua resposta');
  await expect(page.locator('#today-stats')).toContainText('2Casos neste filtro');
  // Both depend on you (overdue return, client waiting): the badge counts the same cases.
  await expect(page.locator('[data-count="today"]')).toHaveText('2');
  expect(errors).toEqual([]);
});

for (const scenario of [{ name: 'encerrada mostra "Reabrir ficha"', record: { status: 'ENCERRADO', enabled: false }, label: 'Reabrir ficha' }, { name: 'ativa só desliga com motivo', record: { status: 'ATIVO', enabled: true }, label: 'Desligar' }]) {
  test(`Lote 2: ficha ${scenario.name}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    await session(page);
    await mockApi(page, { '/api/panel/lead': ({ json }) => json(leadData(scenario.record)) });
    await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
    const action = page.locator('button', { hasText: scenario.label });
    await expect(action).toBeVisible({ timeout: 30000 });
    await expect(page.getByText('Pagamento não informado')).toBeVisible();
    await expect(page.getByText('Prazo não informado')).toBeVisible();
    if (scenario.label === 'Desligar') {
      await expect(action).toBeDisabled();
      await page.locator('select', { has: page.locator('option', { hasText: 'Desligar com motivo' }) }).selectOption('GAVE_UP');
      await expect(action).toBeEnabled();
    }
    expect(errors).toEqual([]);
  });
}

test('Ficha sem Ref: "Confirmar" da leitura da IA fica ativo e grava pela jornada', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  const reading = { id: uuidLike(9), chat_id: uuidLike(8), summary_json: {}, message_count: 1, items: [{ id: uuidLike(7), type: 'payment', value: 'fin', evidence: 'Vou financiar', manual_review: false }] };
  const calls = await mockApi(page, {
    '/api/panel/lead': ({ json }) => json({ ...leadData({ status: 'ATIVO', enabled: true }), ref: '', ai: { reading, suggestion: null } }),
    '/api/panel/ai-conversations': ({ json }) => json({ noteId: uuidLike(6), journeyId: JOURNEY, confirmed: 1 }, 201)
  });
  await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
  const review = page.locator('.ai-conversation-review');
  await expect(review).toContainText('Ficha sem Ref da calculadora', { timeout: 30000 });
  await expect(review).not.toContainText('Ligue ao pedido para confirmar');
  const confirm = review.locator('button', { hasText: 'Confirmar' });
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect.poll(() => calls.find((call) => call.path === '/api/panel/ai-conversations')?.body).toMatchObject({ action: 'confirm', journeyId: JOURNEY, readingId: reading.id, itemIds: [uuidLike(7)] });
  expect(errors).toEqual([]);
});

function uuidLike(n) { return `51000000-0000-4000-8000-${String(n).padStart(12, '0')}`; }

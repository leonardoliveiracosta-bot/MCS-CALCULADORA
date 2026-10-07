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
  await expect(page.locator('#today-list .attend-row')).toHaveCount(2, { timeout: 30000 });
  await expect(page.locator('#today-list .attend-row').first().locator('.attend-wait')).toContainText('Retorno vencido');
  await expect(page.locator('#today-stats')).toContainText('0sem resposta há +24 h');
  await expect(page.locator('#today-stats')).toContainText('0opções enviadas');
  // The badge counts the cases of the list (overdue return, client waiting).
  await expect(page.locator('[data-count="today"]')).toHaveText('2');
  expect(errors).toEqual([]);
});

// Ficha enxuta: os blocos 4, 7, 9, 11 e 12 saíram (nada que não exista em outra aba ou que nunca foi usado). Ficam os
// anexos logo abaixo da Conversa e o link da página do cliente num botão pequeno do cabeçalho.
test('Ficha enxuta: sem os blocos 4, 7, 9, 11 e 12; anexos abaixo da Conversa; link do cliente no cabeçalho', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await session(page);
  const attachments = [{ id: uuidLike(9), kind: 'IMAGE', original_filename: 'print-sms.png', created_at: new Date().toISOString() }];
  const lead = { ...leadData({ attachments }), track: { step: 1, public_code: 'abc123xyz' } };
  await mockApi(page, { '/api/panel/lead': ({ json }) => json(lead), '/api/panel/attachments': ({ json }) => json({ url: base + '/painel/mcs-logo-claro.svg' }) });
  await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
  const detail = page.locator('#record-detail');
  await expect(detail.locator('.lead-quick')).toBeVisible({ timeout: 30000 });
  // The removed blocks are gone (and their controls).
  const labels = await detail.locator('.lead-label').allTextContents();
  for (const gone of ['4 — O QUE ELE QUER', '7 — PERGUNTAR NA LIGAÇÃO', '9 — CONTEXTO RÁPIDO', '11 — PÁGINA DO CLIENTE', '12 — DADOS E HISTÓRICO']) expect(labels).not.toContain(gone);
  for (const control of ['Confirmar teto total', 'Marcar OK', 'Ganhou', 'Salvar etapa', 'Adicionar retorno', 'Baixar PDF']) await expect(detail.getByRole('button', { name: control, exact: true })).toHaveCount(0);
  await expect(detail).not.toContainText('Linha do tempo');
  // What stays: 1, 2, 6, 5, 10, and ANEXOS right after the conversation.
  for (const kept of ['1 — CABEÇALHO DA LIGAÇÃO', '2 — CONVERSA', '6 — NÚMEROS PRONTOS', '5 — OPÇÕES NO LOTE', '10 — O QUE A IA NÃO VIU', 'ANEXOS']) expect(labels).toContain(kept);
  const order = await detail.evaluate((root) => [...root.querySelectorAll('.lead-card > .lead-label')].map((label) => label.textContent));
  expect(order.indexOf('ANEXOS')).toBe(order.indexOf('2 — CONVERSA') + 1);
  await expect(detail.locator('#lead-attachments .lead-attachment')).toContainText('print-sms.png');
  await expect(detail.locator('#lead-attachments')).toContainText('Anexar print');
  // The client's page link: a small button in the header, next to Excluir / Não é lead.
  const copy = detail.locator('.lead-head-actions').getByRole('button', { name: 'Copiar link do cliente' });
  await copy.click();
  await expect(copy).toHaveText('Link copiado');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(base + '/t/abc123xyz');
  expect(errors).toEqual([]);
});

// Fim da página: desligar com motivo e, no mesmo lugar, religar (desligada) ou reabrir (encerrada).
for (const scenario of [{ name: 'encerrada mostra "Reabrir ficha"', record: { status: 'ENCERRADO', enabled: false }, label: 'Reabrir ficha' }, { name: 'desligada mostra "Ligar lead" e o motivo', record: { status: 'ATIVO', enabled: false, offReason: 'GAVE_UP' }, label: 'Ligar lead' }, { name: 'ativa só desliga com motivo', record: { status: 'ATIVO', enabled: true }, label: 'Desligar' }]) {
  test(`Lote 2: ficha ${scenario.name}, no fim da página`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    await session(page);
    const calls = await mockApi(page, { '/api/panel/lead': ({ json, body }) => json(body ? { saved: true } : leadData(scenario.record)) });
    await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
    const action = page.locator('#record-detail .lead-power').getByRole('button', { name: scenario.label, exact: true });
    await expect(action).toBeVisible({ timeout: 30000 });
    // The last card of the ficha.
    expect(await page.locator('#record-detail').evaluate((root) => { const cards = root.querySelectorAll('.lead-card'); return cards[cards.length - 1].classList.contains('lead-power'); })).toBe(true);
    await expect(page.getByText('Pagamento não informado')).toBeVisible();
    if (scenario.label === 'Desligar') {
      await expect(action).toBeDisabled();
      await page.locator('.lead-power select').selectOption('GAVE_UP');
      await expect(action).toBeEnabled();
    } else {
      if (scenario.record.offReason) await expect(page.locator('.lead-power')).toContainText('Motivo: Desistiu');
      await action.click();
      await expect.poll(() => calls.filter((call) => call.path === '/api/panel/lead' && call.body && call.body.action === 'manual').map((call) => call.body.payload.enabled)).toEqual([true]);
    }
    expect(errors).toEqual([]);
  });
}

test('Ficha sem página do cliente: nenhum botão de link no cabeçalho', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  await mockApi(page, { '/api/panel/lead': ({ json }) => json(leadData({})) });
  await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#record-detail .lead-quick')).toBeVisible({ timeout: 30000 });
  await expect(page.getByRole('button', { name: 'Copiar link do cliente' })).toHaveCount(0);
  await expect(page.getByText('Pagamento não informado')).toBeVisible();
  expect(errors).toEqual([]);
});

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

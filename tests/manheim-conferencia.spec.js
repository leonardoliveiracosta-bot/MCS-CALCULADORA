'use strict';

// MANHEIM_MATCH_AUDIT no navegador, com /api/** simulado e dados fictícios, na tela "Opções do cliente"
// de ENVIAR OPÇÕES: selo por demanda, divergência com o carro, V1 bloqueada só na demanda pendente ou
// reprovada, tentar de novo, aprovação manual com motivo e autorização acima do limite. Desligada, nada aparece.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-conferencia.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { asSummary, optionsPage, openAllOptions } = require('./fixtures/buscas-simulado');
const { openOptionsScreen, backToQueue } = require('./abrir-ficha-opcoes');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
const SHOTS = process.env.VISUAL_SHOTS || '';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const JOURNEY = '66000000-0000-4000-8000-000000000001';
const x5 = (vin, extra) => ({ year: 2022, make: 'BMW', model: 'X5', trim: 'xDrive40i', miles: 70000, mmrCents: 4500000, vin, locationDisplay: 'Orlando, FL', ...extra });
const match = (id, mode, kind, vin, target) => ({ id, ...target, logical_mode: mode, demandKey: target.journey_id ? `journey:${target.journey_id}:${mode}` : `ref:${target.calc_ref}:${mode}`, match_kind: kind, match_reason: null, row_fingerprint: 'vin:' + vin, vehicle_json: { parsed: x5(vin) } });
const CARRO_MATCH = '67000000-0000-4000-8000-000000000002';

function manheimData(audit) {
  const journey = { id: JOURNEY, reference_code: 'DCCC4', status: 'ATIVO', stage: 'NOVO', enabled: true, contact: { display_name: 'Cliente Dois Modos' }, phones: [], created_at: '2026-09-28T00:00:00Z' };
  const order = { ref: 'VAAA2', key: 'ref:VAAA2', contactName: 'Pedido Só Valor', vehicleText: 'BMW X5', budgetCents: 5000000, simulations: [], logicalModes: ['VALOR'] };
  const matches = [
    match('67000000-0000-4000-8000-000000000001', 'VALOR', 'POR_VALOR', 'VINAAAAAA111111', { journey_id: JOURNEY }),
    match(CARRO_MATCH, 'CARRO', 'BATE', 'VINBBBBBB222222', { journey_id: JOURNEY }),
    match('67000000-0000-4000-8000-000000000003', 'VALOR', 'POR_VALOR', 'VINCCCCCC333333', { calc_ref: 'VAAA2' })
  ];
  const demands = [
    { key: `journey:${JOURNEY}:VALOR`, mode: 'VALOR', targetType: 'JOURNEY', journeyId: JOURNEY, ref: 'DCCC4', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 5000000, issues: [] },
    { key: `journey:${JOURNEY}:CARRO`, mode: 'CARRO', targetType: 'JOURNEY', journeyId: JOURNEY, ref: 'DCCC4', wishes: [{ make: 'BMW', model: 'X5', yearMin: 2020, yearMax: 2025, minMiles: 50000, maxMiles: 90000 }], bidCents: null, issues: [] },
    { key: 'ref:VAAA2:VALOR', mode: 'VALOR', targetType: 'ORDER', journeyId: null, ref: 'VAAA2', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 5000000, issues: [] }
  ];
  const counts = { VALOR: { demands: 2, people: 2, served: 2, matches: 2, review: 0 }, CARRO: { demands: 1, people: 1, served: 1, matches: 1, review: 0 }, total: { people: 2, served: 2, matches: 3, review: 0 } };
  return { items: [journey], orders: [order], demands, matches, targets: [], review: [], counts, meta: {}, undoAvailable: true, uploads: [],
    upload: { id: '68000000-0000-4000-8000-0000000000a1', vehicle_count: 9998, matched_vehicle_count: 3, uploaded_at: '2026-09-29T10:00:00Z', current_lead_count: 2 }, audit };
}
const ON = {
  state: 'LIGADA', limitUsd: 50, estimateUsd: 0, run: { status: 'ABERTO', estimateUsd: 0.01, spentUsd: 0.004, limitUsd: 50 },
  byDemand: {
    [`journey:${JOURNEY}:VALOR`]: { status: 'CONFERIDO', label: 'Conferido', divergences: [], canApprove: false, canRetry: false },
    [`journey:${JOURNEY}:CARRO`]: { status: 'REVISAR', label: 'Revisar', divergences: [{ code: 'MILES_OUT_OF_RANGE', option: 'm1', matchId: CARRO_MATCH, text: 'Milhagem acima do limite', source: 'OPENAI' }], canApprove: true, canRetry: false },
    'ref:VAAA2:VALOR': { status: 'PENDENTE', label: 'Conferência pendente', divergences: [], errorCode: 'OPENAI_TIMEOUT', canApprove: true, canRetry: true }
  }
};

async function open(page, width, audit) {
  const posts = [];
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') === 'manheim') return json(asSummary(manheimData(audit)));
    if (url.pathname === '/api/panel/manheim-options' && route.request().method() === 'POST') {
      if (body && body.action === 'select') return json({ status: 'SELECTED', matchId: body.matchId, selectedCount: 1, finalCents: 4725000, manualPct: null, manual: false });
      return json({ status: 'AVAILABLE', matchId: body && body.matchId, selectedCount: 0 });
    }
    if (url.pathname === '/api/panel/manheim-options') return json(optionsPage(manheimData(audit), url));
    if (url.pathname === '/api/panel/manheim-audit') { posts.push(body); return json({ processed: 1 }); }
    if (url.pathname === '/api/panel/vitrines') { posts.push({ vitrine: body }); return json({ error: 'MANHEIM_AUDIT_PENDING' }, 409); }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], requests: [], review: [], countsByMode: {}, meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  // ENVIAR OPÇÕES is a queue: the selo, the cars and the V1 live in the client's options screen.
  await expect(page.locator('#options-queue .options-queue-card').first()).toBeVisible({ timeout: 30000 });
  return posts;
}
// Opens the client's options screen (from the queue) on the request of one mode; its Lane/Run tab (the
// first with cars) loads by itself.
const optionsOf = (page, name, mode) => openOptionsScreen(page, { name, mode });
// The other request of the same person: one request at a time on the screen, chosen by its chip.
async function requestOf(page, mode) {
  const screen = page.locator('#options-client');
  if ((await screen.getAttribute('data-mode')) !== mode) await screen.locator('.oc-demands .oc-tab', { hasText: mode === 'VALOR' ? 'Por valor' : 'Por carro' }).click();
  await expect(screen).toHaveAttribute('data-mode', mode);
  return screen;
}
const seal = (section) => section.locator('.oc-audit .audit-block');
const footer = (page) => page.locator('#options-client .oc-act');
const generate = (page) => footer(page).getByRole('button', { name: 'Gerar V1 e abrir no WhatsApp' });
const v1Status = (page) => footer(page).locator('.ficha-v1-status');
async function selectFirst(section) {
  await expect(section.locator('.oc-bar .oc-tab.on')).toHaveAttribute('data-group', 'LANE');
  // Tapping the line opens the car with its own buttons.
  const item = section.locator('.oc-list .oc-item').first();
  await item.locator('.oc-car').click();
  const row = item.locator('.oc-detail .offer-row');
  await row.locator('[data-offer-action="select"]:visible').click();
  await expect(row).toHaveAttribute('data-status', 'SELECTED');
}

for (const width of [1366, 390]) {
  test(`${width}px · selo por demanda, divergência com o carro e V1 bloqueada só na demanda pendente`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    await open(page, width, ON);
    // One screen per person: the VALOR and the CARRO demand of the same client (one chip each), each with its own selo.
    const valor = await optionsOf(page, 'Cliente Dois Modos', 'VALOR');
    await expect(seal(valor).locator('.badge')).toHaveText('Conferido');
    const carro = await requestOf(page, 'CARRO');
    await expect(seal(carro).locator('.badge')).toHaveText('Revisar');
    await expect(seal(carro).locator('.audit-divergence')).toHaveText('2022 BMW X5 · VIN final 222222: Milhagem acima do limite');
    // The options stay visible while the demand waits; one V1 button at the foot of the screen.
    await expect(carro.locator('.oc-list .oc-row')).toHaveCount(1);
    await expect(footer(page).getByRole('button', { name: 'Gerar V1 e abrir no WhatsApp' })).toBeVisible();
    if (SHOTS) await carro.screenshot({ path: path.join(SHOTS, `buscas-conferencia-${width}.png`) });
    // The Ref-only order has its own screen (PEDIDO) with its own selo.
    await backToQueue(page);
    const order = await optionsOf(page, 'Pedido Só Valor', 'VALOR');
    await expect(seal(order).locator('.badge')).toHaveText('Conferência pendente');
    await expect(order).toContainText('Tempo esgotado antes de terminar a conferência · Clique em "Conferir de novo" ou aprove com motivo');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

test('tentar de novo, aprovação manual com motivo e autorização acima do limite', async ({ page }) => {
  const waiting = { ...ON, run: { status: 'AGUARDANDO_AUTORIZACAO', estimateUsd: 2.4, spentUsd: 0, limitUsd: 2 } };
  const posts = await open(page, 1366, waiting);
  await expect(page.locator('#manheim-audit-note')).toContainText('Conferência estimada em US$ 2.40, parada por um limite antigo deste lote (não existe mais limite por lote). Nada foi cobrado');
  await page.locator('#manheim-audit-note').getByRole('button', { name: 'Continuar conferência' }).click();
  await expect.poll(() => posts.filter((item) => item && item.action === 'authorize').length).toBe(1);
  const order = await optionsOf(page, 'Pedido Só Valor', 'VALOR');
  await order.getByRole('button', { name: 'Conferir de novo' }).click();
  await expect.poll(() => posts.filter((item) => item && item.action === 'retry' && item.key === 'ref:VAAA2:VALOR').length).toBe(1);
  await backToQueue(page);
  const carro = await optionsOf(page, 'Cliente Dois Modos', 'CARRO');
  await carro.getByRole('button', { name: 'Aprovar com motivo' }).click();
  await expect(carro).toContainText('Escreva o motivo, com pelo menos 5 letras');
  await carro.getByLabel('Motivo da aprovação manual').fill('Conferi a milhagem no leilão');
  await carro.getByRole('button', { name: 'Aprovar com motivo' }).click();
  await expect.poll(() => posts.filter((item) => item && item.action === 'approve').map((item) => [item.key, item.reason])).toEqual([[`journey:${JOURNEY}:CARRO`, 'Conferi a milhagem no leilão']]);
});

test('desligada: nenhum selo, nenhum bloqueio, V1 como antes', async ({ page }) => {
  await open(page, 1366, { state: 'DESLIGADA', byDemand: {} });
  await expect(page.locator('#manheim-audit-note')).toBeHidden();
  const carro = await optionsOf(page, 'Cliente Dois Modos', 'CARRO');
  await expect(page.locator('#options-client .audit-block')).toHaveCount(0);
  // The V1 button waits only for a selected car (as in every screen); the check never holds it.
  await selectFirst(carro);
  await expect(generate(page)).toBeEnabled();
});

test('Gerar V1 nas Opções do cliente numa demanda ainda não conferida: confere agora e tenta de novo; pendente fica bloqueada com o motivo e as saídas', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const audit = { ...ON, byDemand: {
    ...ON.byDemand,
    [`journey:${JOURNEY}:CARRO`]: { status: 'SEM_SELECAO', label: 'Conferência começa ao selecionar carros', divergences: [], canApprove: false, canRetry: false },
    [`journey:${JOURNEY}:VALOR`]: { status: 'PENDENTE', label: 'Conferência pendente', divergences: [], errorCode: 'AUDIT_DEADLINE', attempts: 4, canApprove: true, canRetry: true }
  } };
  const posts = await open(page, 1366, audit);
  // The server answers "pending" until this demand's reading ran, then creates the link.
  let checked = false;
  await page.route('**/api/panel/manheim-audit', (route) => { posts.push(JSON.parse(route.request().postData() || 'null')); checked = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ processed: 1, approved: 1 }) }); });
  await page.route('**/api/panel/vitrines', (route) => route.fulfill({ status: checked ? 201 : 409, contentType: 'application/json', body: JSON.stringify(checked ? { token: 'tok-ficticio', link: '/v/tok-ficticio' } : { error: 'MANHEIM_AUDIT_PENDING' }) }));
  const carro = await optionsOf(page, 'Cliente Dois Modos', 'CARRO');
  await expect(seal(carro).locator('.badge')).toHaveText('Conferência começa ao selecionar carros');
  await selectFirst(carro);
  await generate(page).click();
  // The V1 is created after the check of this demand (no phone in the test: the link is shown).
  await expect(v1Status(page)).toContainText('V1 criada');
  expect(posts.filter((item) => item && item.action === 'check')).toEqual([{ action: 'check', key: `journey:${JOURNEY}:CARRO` }]);
  // The pending one (the other chip of the same person): reason on screen, "Conferir de novo" and "Aprovar com motivo".
  const valor = await requestOf(page, 'VALOR');
  await expect(seal(valor)).toContainText('Tempo esgotado antes de terminar a conferência (4 tentativas) · Clique em "Conferir de novo" ou aprove com motivo');
  await expect(valor.getByRole('button', { name: 'Conferir de novo' })).toBeVisible();
  await expect(valor.getByRole('button', { name: 'Aprovar com motivo' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('V1 bloqueada pela conferência: o motivo e os botões aparecem no card na hora, sem atualizar a página', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const audit = { ...ON, byDemand: { ...ON.byDemand, [`journey:${JOURNEY}:CARRO`]: { status: 'CONFERINDO', label: 'Conferindo', divergences: [], canApprove: false, canRetry: false } } };
  await open(page, 1366, audit);
  let loads = 0;
  page.on('request', (request) => { if (request.url().includes('/api/panel/records')) loads += 1; });
  const pending = { status: 'PENDENTE', label: 'Conferência pendente', divergences: [], errorCode: 'AUDIT_DEADLINE', attempts: 1, failures: 1, carCount: 2, canApprove: false, canRetry: true };
  await page.route('**/api/panel/manheim-audit', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ processed: 1, pending: 1, entry: pending }) }));
  await page.route('**/api/panel/vitrines', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'MANHEIM_AUDIT_PENDING' }) }));
  const carro = await optionsOf(page, 'Cliente Dois Modos', 'CARRO');
  await selectFirst(carro);
  await generate(page).click();
  await expect(v1Status(page)).toContainText('V1 bloqueada: Tempo esgotado antes de terminar a conferência (1 tentativa) · Clique em "Conferir de novo"');
  await expect(v1Status(page)).not.toContainText('Atualize a página');
  await expect(seal(carro).locator('.badge')).toHaveText('Conferência pendente');
  // The verbose "Conferência sobre N carros" line became selo + ação (comando 3); the reason line stays.
  await expect(carro.getByRole('button', { name: 'Conferir de novo' })).toBeVisible();
  await expect(carro.getByRole('button', { name: 'Aprovar com motivo' })).toHaveCount(0);
  // Second failure: "Aprovar com motivo" appears, still without reloading the page.
  await page.unroute('**/api/panel/manheim-audit');
  await page.route('**/api/panel/manheim-audit', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ processed: 1, pending: 1, entry: { ...pending, attempts: 2, failures: 2, canApprove: true } }) }));
  await carro.getByRole('button', { name: 'Conferir de novo' }).click();
  await expect(carro.getByRole('button', { name: 'Aprovar com motivo' })).toBeVisible();
  await expect(seal(carro)).toContainText('(2 tentativas) · Clique em "Conferir de novo" ou aprove com motivo');
  expect(loads).toBe(0);
  expect(errors).toEqual([]);
});

test('seleção trocada depois de conferida: o selo volta a Conferindo e Gerar V1 confere os carros novos e cria a V1', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const posts = await open(page, 1366, ON);
  let checked = false;
  const created = [];
  await page.route('**/api/panel/manheim-audit', (route) => { posts.push(JSON.parse(route.request().postData() || 'null')); checked = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ processed: 1, approved: 1, entry: { status: 'CONFERIDO', label: 'Conferido', divergences: [], carCount: 1 } }) }); });
  await page.route('**/api/panel/vitrines', (route) => { const body = JSON.parse(route.request().postData() || '{}'); if (!checked) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'MANHEIM_AUDIT_PENDING' }) }); created.push(body.matchIds); return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ token: 'tok-novo', link: '/v/tok-novo' }) }); });
  const valor = await optionsOf(page, 'Cliente Dois Modos', 'VALOR');
  await expect(seal(valor).locator('.badge')).toHaveText('Conferido');
  // The operator changes the selection: the old check no longer counts.
  await selectFirst(valor);
  await expect(seal(valor).locator('.badge')).toHaveText('Conferindo');
  await generate(page).click();
  await expect(v1Status(page)).toContainText('V1 criada');
  expect(posts.filter((item) => item && item.action === 'check').length).toBe(1);
  expect(created.length).toBe(1);
  expect(errors).toEqual([]);
});

test('AUD-001 #101: resposta de "Conferir de novo" que chega depois do bloco ser redesenhado ainda atualiza o cartão', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const pending = { status: 'PENDENTE', label: 'Conferência pendente', divergences: [], errorCode: 'AUDIT_DEADLINE', attempts: 1, failures: 1, carCount: 2, canApprove: false, canRetry: true };
  const audit = { ...ON, byDemand: { ...ON.byDemand, [`journey:${JOURNEY}:CARRO`]: pending } };
  await open(page, 1366, audit);
  let release;
  const gate = new Promise((done) => { release = done; });
  await page.route('**/api/panel/manheim-audit', async (route) => { await gate; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ processed: 1, approved: 1, entry: { status: 'CONFERIDO', label: 'Conferido', divergences: [], carCount: 2 } }) }); });
  const carro = await optionsOf(page, 'Cliente Dois Modos', 'CARRO');
  await expect(carro.getByRole('button', { name: 'Conferir de novo' })).toBeVisible();
  await carro.getByRole('button', { name: 'Conferir de novo' }).click();
  // While the check is running, the options load and the audit block is drawn again.
  await carro.evaluate((node) => node.dispatchEvent(new CustomEvent('options-loaded')));
  release();
  await expect(seal(carro).locator('.badge')).toHaveText('Conferido');
  expect(errors).toEqual([]);
});

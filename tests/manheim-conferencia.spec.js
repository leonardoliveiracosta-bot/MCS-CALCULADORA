'use strict';

// MANHEIM_MATCH_AUDIT no navegador, com /api/** simulado e dados fictícios: selo por demanda,
// divergência com o carro, V1 bloqueada só na demanda pendente ou reprovada, tentar de novo,
// aprovação manual com motivo e autorização acima do limite. Desligada, nada aparece.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-conferencia.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');

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
  state: 'LIGADA', limitUsd: 2, estimateUsd: 0, run: { status: 'ABERTO', estimateUsd: 0.01, spentUsd: 0.004 },
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
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') === 'manheim') return json(manheimData(audit));
    if (url.pathname === '/api/panel/manheim-audit') { posts.push(body); return json({ processed: 1 }); }
    if (url.pathname === '/api/panel/vitrines') { posts.push({ vitrine: body }); return json({ error: 'MANHEIM_AUDIT_PENDING' }, 409); }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], requests: [], review: [], countsByMode: {}, meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  await expect(page.locator('#buscas-valor .manheim-lead').first()).toBeVisible({ timeout: 30000 });
  return posts;
}
const card = (page, side, text) => page.locator(`#buscas-${side} .manheim-lead`, { hasText: text });

for (const width of [1366, 390]) {
  test(`${width}px · selo por demanda, divergência com o carro e V1 bloqueada só na demanda pendente`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    await open(page, width, ON);
    const valor = card(page, 'valor', 'Cliente Dois Modos'), carro = card(page, 'carro', 'Cliente Dois Modos'), order = card(page, 'valor', 'Pedido Só Valor');
    await expect(valor.locator('.audit-block .badge')).toHaveText('Conferido');
    await expect(valor.getByRole('button', { name: 'Gerar link V1' })).toBeEnabled();
    await expect(carro.locator('.audit-block .badge')).toHaveText('Revisar');
    await expect(carro.locator('.audit-divergence')).toHaveText('2022 BMW X5 · VIN final 222222: Milhagem acima do limite');
    await expect(carro.getByRole('button', { name: 'Gerar link V1' })).toBeDisabled();
    await expect(carro).toContainText('V1 e V2 desta demanda ficam liberadas depois da conferência');
    // The options stay visible while the demand waits.
    await expect(carro.locator('.manheim-row')).toHaveCount(1);
    await expect(order.locator('.audit-block .badge')).toHaveText('Conferência pendente');
    await expect(order).toContainText('A IA não respondeu. As opções continuam visíveis, sem aprovação automática');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (SHOTS) await carro.screenshot({ path: path.join(SHOTS, `buscas-conferencia-${width}.png`) });
    expect(errors).toEqual([]);
  });
}

test('tentar de novo, aprovação manual com motivo e autorização acima do limite', async ({ page }) => {
  const waiting = { ...ON, run: { status: 'AGUARDANDO_AUTORIZACAO', estimateUsd: 2.4, spentUsd: 0 } };
  const posts = await open(page, 1366, waiting);
  await expect(page.locator('#manheim-audit-note')).toContainText('Conferência estimada em US$ 2.40, acima do limite de US$ 2.00 por importação. Nada foi cobrado');
  await page.locator('#manheim-audit-note').getByRole('button', { name: 'Autorizar conferência' }).click();
  await expect.poll(() => posts.filter((item) => item && item.action === 'authorize').length).toBe(1);
  const order = card(page, 'valor', 'Pedido Só Valor');
  await order.getByRole('button', { name: 'Tentar de novo' }).click();
  await expect.poll(() => posts.filter((item) => item && item.action === 'retry' && item.key === 'ref:VAAA2:VALOR').length).toBe(1);
  const carro = card(page, 'carro', 'Cliente Dois Modos');
  await carro.getByRole('button', { name: 'Aprovar com motivo' }).click();
  await expect(carro).toContainText('Escreva o motivo, com pelo menos 5 letras');
  await carro.getByLabel('Motivo da aprovação manual').fill('Conferi a milhagem no leilão');
  await carro.getByRole('button', { name: 'Aprovar com motivo' }).click();
  await expect.poll(() => posts.filter((item) => item && item.action === 'approve').map((item) => [item.key, item.reason])).toEqual([[`journey:${JOURNEY}:CARRO`, 'Conferi a milhagem no leilão']]);
});

test('desligada: nenhum selo, nenhum bloqueio, V1 como antes', async ({ page }) => {
  await open(page, 1366, { state: 'DESLIGADA', byDemand: {} });
  await expect(page.locator('.audit-block')).toHaveCount(0);
  await expect(page.locator('#manheim-audit-note')).toBeHidden();
  await expect(card(page, 'carro', 'Cliente Dois Modos').getByRole('button', { name: 'Gerar link V1' })).toBeEnabled();
});

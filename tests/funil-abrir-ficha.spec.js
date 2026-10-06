'use strict';

// Abas V1 e V2: "Abrir ficha" abre a ficha em todo cartão: V1 tocada e V2 expirada.
// Cartão sem pedido ligado diz por quê, em vez de um botão morto.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/funil-abrir-ficha.spec.js
const { test, expect } = require('@playwright/test');
const { fichaLead } = require('./abrir-ficha-opcoes');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `7e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const person = (n, extra = {}) => ({ vitrineId: id(100 + n), name: 'Cliente ' + n, phone: '+1305555010' + n, referenceCode: 'REF' + n + 'A', journeyId: id(n), ...extra });
const FUNNEL = {
  v1: {
    tapped: [person(1, { vitrineCarId: id(201), car: '2022 Jeep Wrangler', vin: 'VIN1', sentAt: ago(5), tapAt: ago(4), ago: 'há 4 h' }), person(4, { journeyId: null, journeyMissing: 'SEM_PEDIDO', vitrineCarId: id(204), car: '2021 Ford F-150', vin: 'VIN4', sentAt: ago(5), tapAt: ago(4), ago: 'há 4 h' })],
    waiting: [],
    expired: [person(2, { cars: ['2020 Honda CR-V'], vins: ['VIN2'], sentAt: ago(80), expiredAt: ago(8) })]
  },
  v2: { bid: [], waiting: [], expired: [person(3, { car: '2019 Toyota Camry', vin: 'VIN3', sentAt: ago(90), expiredAt: ago(10) })] },
  counts: { v1Action: 2, v2Action: 0 }
};

async function openPanel(page, opened) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/vitrine-funnel') return json(FUNNEL);
    if (url.pathname === '/api/panel/lead' && url.searchParams.get('id')) { opened.push(url.searchParams.get('id')); return json(fichaLead(url)); }
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {} });
  });
}
async function openFrom(page, view, card, opened, journeyId) {
  await card.getByRole('button', { name: 'Abrir ficha' }).click();
  await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => opened.includes(journeyId)).toBe(true);
  await page.goBack();
  await expect(page.locator(`#${view}-list`)).toBeVisible({ timeout: 30000 });
}

test('Abrir ficha abre a ficha no cartão da V1 tocada e na V2 expirada', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const opened = [];
  await openPanel(page, opened);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="v1"]').click();
  const v1 = page.locator('#v1-list');
  const active = v1.locator('.vitrine-request-card', { hasText: 'Cliente 1' });
  await expect(active).toBeVisible({ timeout: 30000 });
  await openFrom(page, 'v1', active, opened, id(1));
  // A aba V1 lista só "Tocou · falta a V2": a V1 expirada não aparece mais na lista.
  await expect(v1.locator('details > summary', { hasText: 'Expiradas' })).toHaveCount(0);
  // V1 sem pedido para ligar: o cartão diz por quê, sem botão morto.
  const orphan = v1.locator('.vitrine-request-card', { hasText: 'Cliente 4' });
  await expect(orphan.getByRole('button', { name: 'Abrir ficha' })).toHaveCount(0);
  await expect(orphan.locator('.funnel-no-ficha')).toHaveText('Sem ficha ligada · nenhum pedido deste cliente com a Ref REF4A');
  // Expirada da V2.
  await page.locator('[data-view="v2"]').click();
  const v2 = page.locator('#v2-list');
  await v2.locator('details > summary', { hasText: 'Expiradas' }).click();
  await openFrom(page, 'v2', v2.locator('.vitrine-request-card', { hasText: 'Cliente 3' }), opened, id(3));
  expect(errors).toEqual([]);
});

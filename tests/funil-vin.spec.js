'use strict';

// Aba V1: cada carro tocado mostra o seu VIN numa linha própria, com "Copiar". Dois carros do
// mesmo ano e modelo (ex.: dois 2025 Grand Cherokee Summit) deixam de parecer o mesmo cartão.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/funil-vin.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `7d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const tapped = (n, vin) => ({ vitrineId: id(1), vitrineCarId: id(10 + n), requestId: id(20 + n), name: '_damian', phone: '+19143730498', referenceCode: '2STJQ', journeyId: id(2), refState: 'COM_REF', car: '2025 Jeep Grand Cherokee Summit', vin, sentAt: ago(14), tapAt: ago(13), ago: 'há 13 h', sentAgo: 'há 14 h', budgetCents: 6000000 });
const FUNNEL = {
  v1: { tapped: [tapped(1, '1C4RJHEG2S8768446'), tapped(2, '1C4RJHEG6S8768742')], waiting: [{ vitrineId: id(3), name: 'Param Virani', phone: '+12018562425', referenceCode: 'EXDPY', journeyId: id(4), cars: ['2026 Volvo XC90', '2025 Volvo XC90'], vins: ['YV4H60PF0T1487031', null], sentAt: ago(14), ago: 'há 14 h' }], expired: [] },
  v2: { bid: [], waiting: [], expired: [] },
  counts: { v1Action: 2, v2Action: 0 }
};

test('aba V1: cada carro mostra o seu VIN e o botão Copiar copia o VIN certo', async ({ page, context }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/vitrine-funnel') return json(FUNNEL);
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="v1"]').click();
  const vins = page.locator('.funnel-vin');
  await expect(vins.first()).toBeVisible({ timeout: 30000 });
  // Two tapped cards of the same model, each with its own VIN; the waiting V1 lists both cars.
  await expect(vins).toHaveText([/VIN 1C4RJHEG2S8768446/, /VIN 1C4RJHEG6S8768742/, /VIN YV4H60PF0T1487031/, /VIN não informado/]);
  await vins.nth(1).getByRole('button', { name: 'Copiar' }).click();
  await expect(vins.nth(1).getByRole('button')).toHaveText('Copiado');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('1C4RJHEG6S8768742');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

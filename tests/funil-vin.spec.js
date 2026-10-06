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
// Como a API manda: cada carro tocado leva também a lista inteira da V1 (vitrineCars).
const DAMIAN_CARS = [{ vitrineCarId: id(11), car: '2025 Jeep Grand Cherokee Summit', vin: '1C4RJHEG2S8768446', tapAt: ago(13) }, { vitrineCarId: id(12), car: '2025 Jeep Grand Cherokee Summit', vin: '1C4RJHEG6S8768742', tapAt: ago(13) }];
const tapped = (n, vin) => ({ vitrineId: id(1), vitrineCarId: id(10 + n), requestId: id(20 + n), name: '_damian', phone: '+19143730498', referenceCode: '2STJQ', journeyId: id(2), refState: 'COM_REF', car: '2025 Jeep Grand Cherokee Summit', vin, vitrineCars: DAMIAN_CARS, sentAt: ago(14), tapAt: ago(13), ago: 'há 13 h', sentAgo: 'há 14 h', budgetCents: 6000000 });
// O mesmo VIN reenviado numa V1 anterior do mesmo cliente.
const tappedOld = { ...tapped(2, '1C4RJHEG6S8768742'), vitrineId: id(5), vitrineCarId: id(50), requestId: id(51), vitrineCars: [{ vitrineCarId: id(50), car: '2025 Jeep Grand Cherokee Summit', vin: '1C4RJHEG6S8768742', tapAt: ago(40) }], sentAt: ago(48), tapAt: ago(40) };
// Param tocou um dos dois Volvo; o outro (sem VIN) fica "não tocou" na tela da V1 dele.
const PARAM = { vitrineId: id(3), vitrineCarId: id(30), requestId: id(32), name: 'Param Virani', phone: '+12018562425', referenceCode: 'EXDPY', journeyId: id(4), refState: 'COM_REF', car: '2026 Volvo XC90', vin: 'YV4H60PF0T1487031', vitrineCars: [{ vitrineCarId: id(30), car: '2026 Volvo XC90', vin: 'YV4H60PF0T1487031', tapAt: ago(12) }, { vitrineCarId: id(31), car: '2025 Volvo XC90', vin: null, tapAt: null }], sentAt: ago(14), tapAt: ago(12), ago: 'há 12 h' };
const FUNNEL = {
  v1: { tapped: [tapped(1, '1C4RJHEG2S8768446'), tapped(2, '1C4RJHEG6S8768742'), tappedOld, PARAM], waiting: [], expired: [] },
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
  // 1. Um cartão por cliente: os dois carros tocados do _damian (mesma Ref) viram um cartão só.
  const cards = page.locator('#v1-list .v1-client-card');
  await expect(cards).toHaveCount(2, { timeout: 30000 });
  const damian = cards.filter({ hasText: '_damian' });
  await expect(damian).toHaveCount(1);
  // 2. O cartão mostra o primeiro VIN; a parte do VIN abre todos os carros/VIN enviados, cada um com Copiar.
  await expect(damian.locator('.funnel-vin')).toContainText('1C4RJHEG');
  await damian.locator('.v1-vins > summary').click();
  const items = damian.locator('.v1-vin-list .funnel-vin-item');
  await expect(items).toHaveCount(2);
  await expect(items).toHaveText([/1C4RJHEG\w+/, /1C4RJHEG\w+/]);
  await items.nth(1).getByRole('button', { name: 'Copiar' }).click();
  await expect(items.nth(1).getByRole('button')).toHaveText('Copiado');
  expect(['1C4RJHEG2S8768446', '1C4RJHEG6S8768742']).toContain(await page.evaluate(() => navigator.clipboard.readText()));
  // O outro cliente lista os dois carros da V1; o sem VIN aparece como "não informado".
  const param = cards.filter({ hasText: 'Param Virani' });
  await param.locator('.v1-vins > summary').click();
  await expect(param.locator('.v1-vin-list .funnel-vin-item')).toHaveText([/YV4H60PF0T1487031/, /não informado/]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  // 4. Montar V2 abre vazio; digitar o VIN reconhece o carro da V1 deste cliente e abre a montagem dele.
  await damian.getByRole('button', { name: 'Montar V2' }).click();
  const picker = damian.locator('.v2-picker');
  await expect(picker.locator('input')).toHaveValue('');
  // Colar o VIN completo abre a montagem mesmo com o carro repetido na lista e o VIN reenviado noutra V1.
  await picker.locator('input').fill('1C4RJHEG6S8768742');
  await expect(damian.locator('.v2-builder:not(.v2-picker) h4')).toHaveText('2025 Jeep Grand Cherokee Summit');
  await expect(damian.locator('.v2-builder .funnel-vin')).toContainText('1C4RJHEG6S8768742');
  // 3. Tocar no cartão abre a tela da V1 do cliente (não a ficha), com Voltar.
  await param.locator('.case-face-title').click();
  await expect(page.locator('#v1-list .v1-client-head')).toContainText('Param Virani');
  await expect(page.locator('#v1-list .v1-sent-card')).toHaveCount(1);
  await expect(page.locator('#v1-list .v1-sent-card')).toContainText('não tocou');
  await expect(page.locator('#detail-panel')).toBeHidden();
  // A tela da V1 do cliente também monta a V2 pelo VIN.
  const sent = page.locator('#v1-list .v1-sent-card');
  await sent.getByRole('button', { name: 'Montar V2' }).click();
  await sent.locator('.v2-picker input').fill('YV4H60PF0T1487031');
  await expect(sent.locator('.v2-builder:not(.v2-picker) h4')).toHaveText('2026 Volvo XC90');
  await page.getByRole('button', { name: '← Voltar' }).click();
  await expect(cards).toHaveCount(2);
  // A ficha só abre pelo botão "Abrir ficha".
  await cards.filter({ hasText: 'Param Virani' }).getByRole('button', { name: 'Abrir ficha' }).click();
  await expect(page.locator('#detail-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

'use strict';

// Página do cliente /o/<código>: os carros do pedido, com o valor de referência da V1, nunca o MMR, o Buy Now, o nome do
// leilão ou o VIN inteiro. Só os últimos 6 caracteres identificam cada carro. Contagem no título, 5 linhas compactas, o resto atrás de um botão.
// /api/** simulado. Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/link-opcoes-cliente.spec.js
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH,...(process.env.PANEL_CHROMIUM_SINGLE_PROCESS==='1'?{args:['--single-process','--no-zygote']}:{}) } });
const CODE = 'k'.repeat(43);
const page404 = fs.readFileSync(path.join(__dirname, '..', 'o', 'index.html'), 'utf8');
const VIEW = { closed: false, checkedAt: '2026-10-07T12:00:00Z', cars: [
  { year: 2024, make: 'Porsche', model: 'Taycan', trim: 'Base', miles: 11568, vinLast6: '004352', state: 'Hawaii', colors: { exterior: 'Black', interior: 'Red' }, sale: { kind: 'AUCTION', at: '2026-10-07T19:30:00Z' }, estimatedMarketReference: 105000 },
  { year: 2024, make: 'Porsche', model: 'Taycan', trim: 'GTS', miles: 11625, vinLast6: 'SA4714', state: 'California', sale: { kind: 'AUCTION', at: '2026-10-08T16:30:00Z' }, estimatedMarketReference: 26880 },
  { year: 2023, make: 'Porsche', model: 'Taycan', trim: '4S', miles: 18200, vinLast6: '123456', state: 'Texas', sale: { kind: 'AVAILABLE_UNTIL', at: '2026-10-09T06:59:59Z' } }
] };

async function open(page, view, width = 1280) {
  // The countdown reads this device's clock: fixed here, 3 hours before the first auction.
  await page.clock.setFixedTime(new Date('2026-10-07T16:30:00Z'));
  await page.setViewportSize({ width, height: 900 });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (url.pathname === '/o/' + CODE) return route.fulfill({ status: 200, contentType: 'text/html', body: page404 });
    if (url.pathname === '/api/option-link') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(view) });
    return route.continue();
  });
  await page.goto(base + '/o/' + CODE, { waitUntil: 'domcontentloaded' });
}

// Eight cars: the first five appear as compact rows; three sit behind one button in the same format.
const many = { closed: false, checkedAt: '2026-10-07T12:00:00Z', cars: [
  ...VIEW.cars,
  { year: 2025, make: 'Porsche', model: 'Taycan', trim: 'Turbo', miles: 3200, vinLast6: '000789', state: 'Florida', colors: { exterior: 'White' }, sale: { kind: 'AUCTION', at: '2026-10-10T15:00:00Z' }, estimatedMarketReference: 140000 },
  { year: 2022, make: 'Porsche', model: 'Taycan', trim: '4S', miles: 30100, state: 'Georgia', sale: { kind: 'AUCTION', at: '2026-10-11T15:00:00Z' }, estimatedMarketReference: 61000 },
  { year: 2022, make: 'Porsche', model: 'Taycan', trim: 'Base', miles: 41000, vinLast6: '009012', state: 'Texas', sale: { kind: 'AUCTION', at: '2026-10-12T15:00:00Z' }, estimatedMarketReference: 52000 },
  { year: 2023, make: 'Porsche', model: 'Taycan', trim: 'GTS', miles: 22000, vinLast6: '345678', state: 'Ohio', sale: { kind: 'SALE', at: '2026-10-13T15:00:00Z' }, estimatedMarketReference: 74000 },
  { year: 2021, make: 'Porsche', model: 'Taycan', trim: '4S', miles: 39000, state: 'Nevada', sale: { kind: 'AUCTION', at: '2026-10-14T15:00:00Z' }, estimatedMarketReference: 58000 }
] };

for (const width of [1280, 390]) {
  test(`${width} px · cinco linhas compactas, demais atrás de um botão, sem MMR, Buy Now, leilão ou VIN inteiro`, async ({ page }) => {
    await open(page, many, width);
    const root = page.locator('#options');
    await expect(root.locator('h1')).toHaveText('8 cars match your search');
    await expect(root.locator('.lead span')).toHaveText(['From auctions open only to dealers', 'Before any dealer markup']);
    await expect(root.locator('article.car')).toHaveCount(0);
    const first = root.locator('.first-options li');
    await expect(first).toHaveCount(5);
    await expect(first.first()).toHaveText('2024 Porsche Taycan Base · 11,568 mi · Hawaii · VIN 004352$105,000');
    await expect(first.nth(1)).toContainText('VIN SA4714');
    await expect(first.nth(2)).toContainText('VIN 123456');
    await expect(first.nth(3)).toContainText('VIN 000789');
    await expect(first.nth(2).locator('b')).toHaveCount(0);
    // The other three: one line each, only after the button.
    const rows = root.locator('.other-options li');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toBeHidden();
    await root.locator('.more button').click();
    await expect(rows.first()).toBeVisible();
    await expect(rows).toHaveText(['2022 Porsche Taycan Base · 41,000 mi · Texas · VIN 009012$52,000', '2023 Porsche Taycan GTS · 22,000 mi · Ohio · VIN 345678$74,000', '2021 Porsche Taycan 4S · 39,000 mi · Nevada · VIN not listed$58,000']);
    await expect(root.locator('.more button')).toHaveText('Show fewer');
    await expect(root.locator('.more button')).toHaveAttribute('aria-expanded','true');
    await root.locator('.more button').click();await expect(rows.first()).toBeHidden();await expect(first.first()).toBeVisible();
    await expect(root.locator('.more button')).toHaveText('See the other 3');
    await expect(root.locator('.know .term b')).toHaveText(['Trim', 'Available until', 'Reference price']);
    // One sentence per line and no final period or dash anywhere in the copy.
    for (const line of await root.locator('.lead span, .know .term span, .closing p, .closing .after span').allInnerTexts()) expect(line).not.toMatch(/\.$|\u2014|\u2013/);
    await expect(root.locator('.closing p')).toHaveText('Your specialist will go over these with you before any bid');
    await expect(root.locator('.closing .after span')).toHaveText(['You’ll receive the photos, the history report', 'and the full auction listing of each car']);
    const text = await root.innerText();
    for (const forbidden of ['Manheim', 'Riverside', 'Buy Now', 'MMR', '98,000', 'WP0A', '1HGCM82633A']) expect(text).not.toContain(forbidden);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    if (process.env.PANEL_SHOTS_DIR) await page.screenshot({ path: require('node:path').join(process.env.PANEL_SHOTS_DIR, `opcoes-cliente-${width}.png`), fullPage: true });
  });
}

test('até 5 carros: todos aparecem em linhas compactas, sem botão', async ({ page }) => {
  await open(page, VIEW, 390);
  const root = page.locator('#options');
  await expect(root.locator('h1')).toHaveText('3 cars match your search');
  await expect(root.locator('.lead span')).toHaveText(['From auctions open only to dealers', 'Before any dealer markup']);
  await expect(root.locator('.first-options li')).toHaveCount(3);
  await expect(root.locator('article.car')).toHaveCount(0);
  await expect(root.locator('.more')).toHaveCount(0);
  await expect(root.locator('.first-options li').nth(1)).toContainText('VIN SA4714');
});

test('busca encerrada e sem carros: a página diz isso, sem lista', async ({ page }) => {
  await open(page, { closed: true, cars: [] });
  await expect(page.locator('#options h1')).toHaveText('This search is closed');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await open(page, { closed: false, cars: [], checkedAt: '2026-10-07T12:00:00Z' });
  await expect(page.locator('#options h1')).toHaveText('No cars match your search right now');
  await expect(page.locator('#options article.car')).toHaveCount(0);
});

test('lista com marcas diferentes (busca por valor): cada carro mostra a própria marca', async ({ page }) => {
  const mixed = { ...VIEW, cars: [VIEW.cars[0], { ...VIEW.cars[1], make: 'BMW', model: 'i7', trim: 'xDrive60' }] };
  await open(page, mixed);
  await expect(page.locator('#options h1')).toHaveText('2 cars match your search');
  await expect(page.locator('#options .first-options li').nth(0)).toContainText('Porsche');
  await expect(page.locator('#options .first-options li').nth(1)).toContainText('BMW');
});

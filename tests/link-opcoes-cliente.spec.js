'use strict';

// Página do cliente /o/<código>: os carros do pedido, sem preço, sem nome do leilão, VIN sem os 6 últimos.
// /api/** simulado. Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/link-opcoes-cliente.spec.js
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const CODE = 'k'.repeat(43);
const page404 = fs.readFileSync(path.join(__dirname, '..', 'o', 'index.html'), 'utf8');
const VIEW = { closed: false, checkedAt: '2026-10-07T12:00:00Z', cars: [
  { year: 2024, make: 'Porsche', model: 'Taycan', trim: 'Base', miles: 11568, vin: 'WP0AA2Y15RS••••••', state: 'Hawaii', sale: { kind: 'AUCTION', at: '2026-10-07T19:30:00Z' } },
  { year: 2024, make: 'Porsche', model: 'Taycan', trim: 'GTS', miles: 11625, vin: 'WP0AD2Y13RS••••••', state: 'California', sale: { kind: 'AUCTION', at: '2026-10-08T16:30:00Z' } },
  { year: 2023, make: 'Porsche', model: 'Taycan', trim: '4S', miles: 18200, vin: 'WP0AB2Y11PS••••••', state: 'Texas', sale: { kind: 'AVAILABLE_UNTIL', at: '2026-10-09T06:59:59Z' } }
] };

async function open(page, view, width = 1280) {
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

for (const width of [1280, 390]) {
  test(`${width} px · os carros do pedido para o cliente, sem preço nem nome do leilão`, async ({ page }) => {
    await open(page, VIEW, width);
    const root = page.locator('#options');
    await expect(root.locator('h1')).toHaveText('3 cars match your search');
    await expect(root.locator('article.car')).toHaveCount(3);
    const first = root.locator('article.car').first();
    await expect(first).toContainText('2024 Porsche Taycan Base');
    await expect(first).toContainText('11,568 mi · Hawaii');
    await expect(first).toContainText('VIN WP0AA2Y15RS••••••');
    await expect(first).toContainText('Auction · Wed, Oct 7, 3:30 PM (Florida time)');
    await expect(root.locator('article.car').nth(2)).toContainText('Available until Fri, Oct 9, 2:59 AM (Florida time)');
    const text = await root.innerText();
    for (const forbidden of ['$', 'Manheim', 'Riverside', 'Buy Now', 'MMR', 'price']) expect(text).not.toContain(forbidden);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  });
}

test('busca encerrada e sem carros: a página diz isso, sem lista', async ({ page }) => {
  await open(page, { closed: true, cars: [] });
  await expect(page.locator('#options h1')).toHaveText('This search is closed');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await open(page, { closed: false, cars: [], checkedAt: '2026-10-07T12:00:00Z' });
  await expect(page.locator('#options h1')).toHaveText('No cars match your search right now');
  await expect(page.locator('#options article.car')).toHaveCount(0);
});

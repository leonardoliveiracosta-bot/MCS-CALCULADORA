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
  { year: 2024, make: 'Porsche', model: 'Taycan', trim: 'Base', miles: 11568, vin: 'WP0AA2Y15RS••••••', state: 'Hawaii', colors: { exterior: 'Black', interior: 'Red' }, sale: { kind: 'AUCTION', at: '2026-10-07T19:30:00Z' } },
  { year: 2024, make: 'Porsche', model: 'Taycan', trim: 'GTS', miles: 11625, vin: 'WP0AD2Y13RS••••••', state: 'California', sale: { kind: 'AUCTION', at: '2026-10-08T16:30:00Z' } },
  { year: 2023, make: 'Porsche', model: 'Taycan', trim: '4S', miles: 18200, vin: 'WP0AB2Y11PS••••••', state: 'Texas', sale: { kind: 'AVAILABLE_UNTIL', at: '2026-10-09T06:59:59Z' } }
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

for (const width of [1280, 390]) {
  test(`${width} px · o carro como protagonista, cores, contagem até o leilão e o que se destaca, sem preço nem nome do leilão`, async ({ page }) => {
    await open(page, VIEW, width);
    const root = page.locator('#options');
    await expect(root.locator('h1')).toHaveText('3 options for your search');
    await expect(root.locator('.next')).toHaveText('Next auction in 3h 00m 00s');
    // One clear card per option, numbered; the make is not repeated (the client chose it), only what differs.
    await expect(root.locator('article.car')).toHaveCount(3);
    await expect(root.locator('.car-option')).toHaveText(['Option 1 of 3', 'Option 2 of 3', 'Option 3 of 3']);
    const first = root.locator('article.car').first();
    await expect(first.locator('.car-title')).toHaveText('2024 Taycan Base');
    await expect(first.locator('.fact')).toHaveText(['Miles11,568', 'LocationHawaii', 'ExteriorBlack', 'InteriorRed']);
    const [one, two] = await Promise.all([first.boundingBox(), root.locator('article.car').nth(1).boundingBox()]);
    expect(two.y - (one.y + one.height)).toBeGreaterThanOrEqual(12);
    // Countdown and day of the sale, in Florida time.
    await expect(first.locator('.sale-text')).toContainText('Auction · Wed, Oct 7');
    await expect(first.locator('.sale-text')).toContainText('3:30 PM Florida time');
    await expect(first.locator('.countdown')).toHaveText('in 3h 00m 00s');
    // The seconds run: one second later the countdown shows it.
    await page.clock.setFixedTime(new Date('2026-10-07T16:30:07Z'));
    await expect(first.locator('.countdown')).toHaveText('in 2h 59m 53s', { timeout: 5000 });
    await expect(root.locator('article.car').nth(2).locator('.sale-text')).toContainText('Available until Fri, Oct 9');
    await expect(root.locator('article.car').nth(2).locator('.countdown')).toHaveText('ends in 1d 14h 29m 52s');
    // Why it stands out: only from the data (lowest miles, first to auction, newest), never a tie.
    await expect(first.locator('.why')).toHaveText('★ Lowest miles of the 3 · First to go to auction');
    await expect(root.locator('article.car').nth(2).locator('.why')).toHaveCount(0);
    // VIN: the first 11 characters and the last 6 blurred (placeholder characters, never the real ones).
    await expect(first.locator('.vin')).toContainText('VIN WP0AA2Y15RS');
    await expect(first.locator('.vin .vin-hidden')).toHaveCount(1);
    expect(await first.locator('.vin .vin-hidden').evaluate((node) => getComputedStyle(node).filter)).toContain('blur');
    await expect(first.locator('.vin')).not.toContainText('•');
    // A car without colors shows no color lines.
    await expect(root.locator('article.car').nth(1).locator('.fact')).toHaveText(['Miles11,625', 'LocationCalifornia']);
    await expect(root.locator('.outro')).toContainText('Tell us which option you like.');
    const text = await root.innerText();
    for (const forbidden of ['$', 'Manheim', 'Riverside', 'Buy Now', 'MMR', 'price']) expect(text).not.toContain(forbidden);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    if (process.env.PANEL_SHOTS_DIR) await page.screenshot({ path: require('node:path').join(process.env.PANEL_SHOTS_DIR, `opcoes-cliente-${width}.png`), fullPage: true });
  });
}

test('busca encerrada e sem carros: a página diz isso, sem lista', async ({ page }) => {
  await open(page, { closed: true, cars: [] });
  await expect(page.locator('#options h1')).toHaveText('This search is closed');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await open(page, { closed: false, cars: [], checkedAt: '2026-10-07T12:00:00Z' });
  await expect(page.locator('#options h1')).toHaveText('No cars match your search right now');
  await expect(page.locator('#options article.car')).toHaveCount(0);
  await expect(page.locator('#options .next')).toHaveCount(0);
});

test('lista com marcas diferentes (busca por valor): a marca aparece no título de cada opção', async ({ page }) => {
  const mixed = { ...VIEW, cars: [VIEW.cars[0], { ...VIEW.cars[1], make: 'BMW', model: 'i7', trim: 'xDrive60' }] };
  await open(page, mixed);
  await expect(page.locator('#options h1')).toHaveText('2 options for your search');
  await expect(page.locator('#options .car-title')).toHaveText(['2024 Porsche Taycan Base', '2024 BMW i7 xDrive60']);
});

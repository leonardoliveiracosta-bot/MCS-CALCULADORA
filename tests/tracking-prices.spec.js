'use strict';
const { test, expect } = require('@playwright/test');
const base = 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

test('tracking shows the same adjusted amount in the card and ready message without adding a step', async ({ page }) => {
  const posts = [], links = [], errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const data = { ref: 'AB234', firstName: 'Fictitious', step: 2, updatedAt: '2026-10-10T00:00:00Z', whatsAppNumber: '13055550100',
    cars: [{ id: 'car-1', year: 2021, make: 'Tesla', model: 'Model S', trim: 'Plaid', miles: 18206,
      vehicle: { state: 'Tennessee', startsAt: '2099-10-14T14:00:00Z', cleanTitle: true, odometerOk: true, averageAuctionValue: 55500, estimatedMarketReference: 56890 } },
      { id: 'car-2', year: 2022, make: 'Tesla', model: 'Model S', miles: 38957, vehicle: { estimatedMarketReference: null } }] };
  await page.route('**/api/tracking?**', async (route) => {
    if (route.request().method() === 'POST') { posts.push(route.request().postDataJSON()); return route.fulfill({ json: { accepted: true } }); }
    await route.fulfill({ json: data });
  });
  await page.route('https://wa.me/**', async (route) => { links.push(route.request().url()); await route.fulfill({ body: '<p>Mock WhatsApp</p>', contentType: 'text/html' }); });
  await page.goto(base + '/t/index.html');
  await expect(page.locator('.car')).toHaveCount(2);
  const car = page.locator('.car').first();
  await expect(car).toContainText('2021 Tesla Model S Plaid');
  await expect(car).toContainText('18,206 mi');
  await expect(car).toContainText('~ $56,890');
  await expect(car).toContainText('A reference, not a fixed price');
  await expect(car).not.toContainText('$55,500');
  await expect(page.locator('.car').nth(1).locator('.average')).toHaveCount(0);
  await car.getByRole('button', { name: 'Show me this car', exact: true }).click();
  await expect.poll(() => links.length).toBe(1);
  expect(new URL(links[0]).searchParams.get('text')).toBe("Hey, I'd like to see the 2021 Tesla Model S Plaid (Ref AB234)\nEstimated market reference: ~ $56,890");
  expect(posts).toEqual([{ unitId: 'car-1', response: 'WANT' }]);
  expect(errors).toEqual([]);
});

test('tracking without a price keeps its existing message and does not show zero', async ({ page }) => {
  let link;
  await page.route('**/api/tracking?**', (route) => route.fulfill({ json: { ref: 'AB234', step: 2, updatedAt: '2026-10-10T00:00:00Z', whatsAppNumber: '13055550100',
    cars: [{ id: 'car-1', year: 2021, make: 'Tesla', model: 'Model S', response: 'WANT', vehicle: { estimatedMarketReference: null } }] } }));
  await page.route('https://wa.me/**', async (route) => { link = route.request().url(); await route.fulfill({ body: 'Mock WhatsApp' }); });
  await page.goto(base + '/t/index.html');
  await expect(page.locator('.car')).not.toContainText('$0');
  await expect(page.locator('.average')).toHaveCount(0);
  await page.getByRole('button', { name: 'Show me this car', exact: true }).click();
  await expect.poll(() => link).toBeTruthy();
  expect(new URL(link).searchParams.get('text')).toBe("Hey, I'd like to see the 2021 Tesla Model S (Ref AB234)");
});

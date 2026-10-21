'use strict';
const { test, expect } = require('@playwright/test');
const base = 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions:{executablePath:process.env.CHROMIUM_PATH} });

async function isolate(page, stats = { days:30, scenarios:4520 }) {
  const writes = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() !== 'GET') writes.push(request.url());
    if (url.pathname === '/api/calc-stats' && url.searchParams.get('metric') === 'scenarios') {
      return route.fulfill({ status:stats === null ? 503 : 200, json:stats || {error:'STATS_UNAVAILABLE'} });
    }
    if (!request.url().startsWith(base) || url.pathname.startsWith('/api/') || request.method() !== 'GET') return route.abort();
    return route.continue();
  });
  return { writes, errors };
}

for (const width of [320,390,430,1440]) test('30-day event counter and aligned xenon headlights at '+width+'px', async ({ page }) => {
  await page.setViewportSize({width,height:900});
  const observed = await isolate(page);
  await page.goto(base+'/');
  const proof = page.locator('#home-purchase-proof');
  await expect(proof).toBeVisible();
  await expect(proof.locator('strong')).toHaveText('4,520');
  await expect(proof).toContainText('PURCHASE SCENARIOS EXPLORED');
  await expect(proof).toContainText('LAST 30 DAYS');
  await expect(page.locator('.home-purchase-proof')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => page.locator('.hero-glow').first().evaluate(el=>parseFloat(el.style.width)||0)).toBeGreaterThan(0);
  // The light's centre must match the real headlight inside the cropped photo, including desktop zoom.
  const geometry = await page.locator('#hero-bg').evaluate(img => {
    const image = img.getBoundingClientRect(), style = getComputedStyle(img);
    const zoom = image.width / img.clientWidth;
    const scale = Math.max(img.clientWidth/img.naturalWidth,img.clientHeight/img.naturalHeight);
    const position = style.objectPosition.split(' ').map(parseFloat);
    const x = image.left + ((img.clientWidth-img.naturalWidth*scale)*position[0]/100 + .350*img.naturalWidth*scale)*zoom;
    const y = image.top + ((img.clientHeight-img.naturalHeight*scale)*position[1]/100 + .615*img.naturalHeight*scale)*zoom;
    const light = document.querySelector('.hero-glow').getBoundingClientRect();
    return {x,y,lightX:light.left+light.width/2,lightY:light.top+light.height/2,display:getComputedStyle(document.querySelector('.hero-glow')).display,background:getComputedStyle(document.querySelector('.hero-glow')).backgroundImage};
  });
  expect(Math.abs(geometry.x-geometry.lightX)).toBeLessThan(2);
  expect(Math.abs(geometry.y-geometry.lightY)).toBeLessThan(2);
  expect(geometry.display).not.toBe('none');
  expect(geometry.background).toContain('255, 255, 255');
  expect(geometry.background).toContain('190, 224, 255');
  await page.evaluate(()=>scrollTo(0,90));
  await expect.poll(()=>page.locator('.hero-glow').first().evaluate(el=>Number(getComputedStyle(el).opacity))).toBeGreaterThan(.25);
  if (width === 390 && process.env.HOME_SHOTS) await page.locator('.hero').screenshot({path:process.env.HOME_SHOTS+'/home-xenon-mobile.png'});
  // Each existing choice still opens its own form immediately, with no duplicated entry screen.
  for (const [path,id] of [['calculate','path-a'],['find','path-b'],['finance','path-finance']]) {
    await page.locator('[data-home-start="'+path+'"]').click();
    await expect(page.frameLocator('iframe.calc-frame').locator('#'+id)).toBeVisible();
    await expect(page.frameLocator('iframe.calc-frame').locator('#path-entry')).toBeHidden();
  }
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('counter failure stays hidden without blocking the choices; reduced motion is respected', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  const observed = await isolate(page, null);
  await page.goto(base+'/');
  await expect(page.locator('#home-purchase-proof')).toBeHidden();
  await expect(page.locator('.hero-glow').first()).toBeHidden();
  await page.locator('[data-home-start="find"]').click();
  await expect(page.frameLocator('iframe.calc-frame').locator('#path-b')).toBeVisible();
  expect(observed.writes).toEqual([]); expect(observed.errors).toEqual([]);
});

test('counter label and period follow the existing site language', async ({ page }) => {
  await isolate(page); await page.goto(base+'/');
  await page.locator('#btn-lang').click(); await page.locator('#sheet-lang [data-set-lang="pt"]').click();
  await expect(page.locator('#home-purchase-proof')).toContainText('CENÁRIOS DE COMPRA EXPLORADOS');
  await expect(page.locator('#home-purchase-proof')).toContainText('ÚLTIMOS 30 DIAS');
  await expect(page.locator('#home-purchase-proof strong')).toHaveText('4,520');
});

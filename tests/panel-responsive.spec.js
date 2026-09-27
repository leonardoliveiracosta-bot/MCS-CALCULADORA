const { test, expect } = require('@playwright/test');

const preview = process.env.PANEL_PREVIEW_URL;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

if (!preview) throw new Error('PANEL_PREVIEW_URL é obrigatório');
const previewUrl = new URL(preview);
if (previewUrl.hostname === 'www.mycarscout.net' || previewUrl.hostname === 'mycarscout.net') {
  throw new Error('O teste visual nunca pode rodar em produção');
}

const target = new URL('/painel', previewUrl);
if (bypass) {
  target.searchParams.set('x-vercel-protection-bypass', bypass);
  target.searchParams.set('x-vercel-set-bypass-cookie', 'true');
}

for (const width of [360, 390, 430]) {
  for (const colorScheme of ['light', 'dark']) {
    for (const view of ['today', 'entry']) {
      test(`${view} sem rolagem horizontal em ${width}px / ${colorScheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
        await page.evaluate((activeView) => {
          document.querySelector('#login-view')?.classList.add('hidden');
          document.querySelector('#password-view')?.classList.add('hidden');
          document.querySelector('#app-view')?.classList.remove('hidden');
          for (const name of ['today', 'entry', 'pending', 'orders', 'qualification', 'searches', 'manheim', 'records']) {
            document.querySelector(`#${name}-panel`)?.classList.toggle('hidden', name !== activeView);
          }
        }, view);
        await page.evaluate(() => document.fonts?.ready);
        const dimensions = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth
        }));
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
      });
    }
  }
}

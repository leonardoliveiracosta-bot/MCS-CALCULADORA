'use strict';

// Avisos de mensagens novas com sessão expirada: depois de um 401 o painel renova a sessão uma vez;
// se não der, para de consultar (nenhuma chamada com o token vencido) e avisa; volta sozinho no novo login.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/notificacoes-sessao.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

async function setup(page, { refreshWorks }) {
  const log = { notifications: [], refresh: 0 };
  await page.clock.install();
  await page.addInitScript(() => {
    Document.prototype.hasFocus = () => true;
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-vencido', refreshToken: 'refresh-1', accessExpiresAt: Date.now() + 3600000 }));
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (!url.href.startsWith(base)) return route.abort();
    if (url.pathname === '/supabase-simulado/auth/v1/token') {
      log.refresh++;
      return refreshWorks ? json({ access_token: 'token-novo', refresh_token: 'refresh-2', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (url.pathname === '/api/panel/notifications') {
      const token = (route.request().headers().authorization || '').replace('Bearer ', '');
      log.notifications.push(token);
      return token === 'token-novo' ? json({ items: [], cursor: new Date().toISOString() }) : json({ error: 'UNAUTHORIZED' }, 401);
    }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.MCSPanelAuth && typeof window.MCSPanelAuth.refresh === 'function');
  return log;
}

test('401 sem renovação: uma tentativa, para de consultar, avisa e volta no novo login', async ({ page }) => {
  const log = await setup(page, { refreshWorks: false });
  await page.clock.runFor(21000);
  await expect.poll(() => log.notifications.length).toBe(1);
  await expect(page.locator('#notification-status')).toContainText('Sessão expirada');
  expect(log.refresh).toBe(1);
  await page.clock.runFor(5 * 60 * 1000);
  expect(log.notifications.length, 'nenhuma consulta com sessão expirada em 5 minutos').toBe(1);
  expect(log.refresh).toBe(1);
  await page.evaluate(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-novo', refreshToken: 'refresh-3', accessExpiresAt: Date.now() + 3600000 })));
  await page.clock.runFor(21000);
  await expect.poll(() => log.notifications.filter((token) => token === 'token-novo').length).toBeGreaterThan(0);
  await expect(page.locator('#notification-status')).not.toContainText('Sessão expirada');
});

test('401 com renovação: renova uma vez, repete a consulta e segue avisando', async ({ page }) => {
  const log = await setup(page, { refreshWorks: true });
  await page.clock.runFor(21000);
  await expect.poll(() => log.notifications.join(',')).toBe('token-vencido,token-novo');
  expect(log.refresh).toBe(1);
  await page.clock.runFor(60000);
  expect(log.notifications.slice(2).every((token) => token === 'token-novo')).toBe(true);
  expect(log.notifications.length).toBeGreaterThanOrEqual(4);
  expect(log.refresh).toBe(1);
  await expect(page.locator('#notification-status')).not.toContainText('Sessão expirada');
});

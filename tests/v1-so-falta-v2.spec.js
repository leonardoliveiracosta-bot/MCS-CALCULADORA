'use strict';

// Aba V1: a lista mostra só "Tocou · falta a V2". Aguardando o toque, Expiradas e "Link gerado ·
// envio não confirmado" não aparecem mais. Cada cartão tem "Excluir": um clique tira o cliente da
// lista, sem confirmação, e Desfazer traz de volta.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/v1-so-falta-v2.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `7f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const tapped = { vitrineId: id(1), vitrineCarId: id(2), requestId: id(3), name: 'Bia', phone: '+13055551111', referenceCode: 'ABC23', journeyId: id(4), refState: 'COM_REF', car: '2021 BMW X5', vin: 'WBAJU0C50MCF00001', vitrineCars: [{ vitrineCarId: id(2), car: '2021 BMW X5', vin: 'WBAJU0C50MCF00001', tapAt: ago(1) }], sentAt: ago(2), tapAt: ago(1), ago: 'há 1 h' };
const other = (n, extra) => ({ vitrineId: id(10 + n), name: 'Outro ' + n, phone: '+1305555020' + n, referenceCode: 'OUT' + n, journeyId: id(20 + n), cars: ['2020 Honda CR-V'], vins: ['VIN' + n], sentAt: ago(30), ago: 'há 1 dia', ...extra });

test('aba V1: só "Tocou · falta a V2", e Excluir tira o cliente com um clique', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const dialogs = []; page.on('dialog', (dialog) => { dialogs.push(dialog.message()); dialog.dismiss(); });
  const calls = [];
  let treated = false;
  await page.setViewportSize({ width: 390, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/vitrine-funnel') return json({
      v1: { tapped: treated ? [] : [tapped], waiting: [other(1)], expired: [other(2, { expiredAt: ago(5) })], unsent: [other(3, { createdAt: ago(3) })] },
      v2: { bid: [], waiting: [], expired: [] },
      counts: { v1Action: treated ? 0 : 1, v2Action: 0 }
    });
    if (url.pathname === '/api/panel/vitrine-requests' && route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}'); calls.push(body);
      if (body.action === 'treat') treated = true;
      if (body.action === 'undo') treated = false;
      return json({ ok: true });
    }
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="v1"]').click();
  const list = page.locator('#v1-list');
  const card = list.locator('.v1-client-card', { hasText: 'Bia' });
  await expect(card).toHaveCount(1, { timeout: 30000 });
  // Só a seção "Tocou · falta a V2"; as outras V1 não viram cartão na lista.
  await expect(list.locator('.request-group > h3')).toHaveText(['Tocou · falta a V2 (1)']);
  await expect(list.locator('.v1-client-card')).toHaveCount(1);
  await expect(list).not.toContainText('Aguardando o toque');
  await expect(list).not.toContainText('Nenhuma V1 aguardando');
  await expect(list).not.toContainText('envio não confirmado');
  await expect(list).not.toContainText('Expiradas');
  await expect(list).not.toContainText('Outro');
  // Caminho comum: o cartão continua com Abrir ficha e Montar V2, e Excluir é um clique só, sem confirmação.
  await expect(card.getByRole('button', { name: 'Abrir ficha' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Montar V2' })).toBeVisible();
  await card.getByRole('button', { name: 'Excluir' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Cliente excluído da lista')).toBeVisible();
  expect(calls).toEqual([{ action: 'treat', requestId: id(3) }]);
  await expect(list.locator('.request-group > h3')).toHaveText(['Tocou · falta a V2 (0)']);
  // Desfazer traz o cliente de volta.
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(list.locator('.v1-client-card', { hasText: 'Bia' })).toHaveCount(1);
  expect(calls).toEqual([{ action: 'treat', requestId: id(3) }, { action: 'undo', requestId: id(3) }]);
  expect(dialogs).toEqual([]);
  expect(errors).toEqual([]);
});

'use strict';

// ATENDIMENTO · telefone igual, nome diferente: o cartão mostra os dois nomes e o "Confirmar vínculo" traz os dois
// lados (simulação por SMS × ficha do WhatsApp); o tempo do cartão diz o canal. /api/** simulado, nada é gravado.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/vinculo-nome.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const JOURNEY = '7a000000-0000-4000-8000-000000000010', MESSAGE = '7a000000-0000-4000-8000-000000000020';
const iso = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const ITEM = { kind: 'JOURNEY', id: JOURNEY, name: '+18723640049', contact: { display_name: '+18723640049' }, phones: [{ phone_e164: '+18723640049', is_primary: true }], reference_code: 'CWZWK',
  awaitingReply: true, lastCustomerAt: iso(8 * 1440), sortAt: iso(18), cardFacts: { modes: ['VALOR'], perMode: { VALOR: { vehicleText: 'Chevrolet Corvette', budgetCents: 7200000 } } },
  group: { key: 'NAO_ATENDIDO', label: 'Não atendidos', origin: { key: 'MENSAGEM:WHATSAPP', label: 'Veio por mensagem · Via WhatsApp', financing: false }, hasCalculator: true, calcMode: 'VALOR',
    unattended: { reason: 'NO_RESPONSE', reasonText: 'Mensagem do cliente sem resposta', waitedText: '8 dias', timeLabel: 'WhatsApp há 8 dias · sem resposta', missing: 'Resposta', next: 'Responder o cliente' } } };
const LINK = { key: `namelink:${MESSAGE}:${JOURNEY}`, state: 'JUNTO', messageId: MESSAGE, journeyId: JOURNEY, ref: 'CWZWK', phone: '+18723640049',
  simulation: { name: 'Dante', channel: 'SMS', at: iso(18) }, ficha: { names: [], channel: 'WHATSAPP', lastAt: '2026-09-25T23:55:56Z' } };

test('cartão com dois nomes e Confirmar vínculo lado a lado', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const posts = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (route.request().method() === 'POST') { posts.push({ path: url.pathname, body: JSON.parse(route.request().postData() || '{}') }); return json({ decision: 'CONFIRMED' }); }
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') return json({ meta: { dataUpdatedAt: new Date().toISOString() }, items: [ITEM] });
    if (url.pathname === '/api/panel/entry') return json({ chats: [], reviews: [], contacts: [], journeys: [], printReviews: [], failedPrints: [], calcQueue: [], nameLinks: [LINK] });
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], suggestions: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  const card = page.locator(`#today-list .case-card[data-journey-id="${JOURNEY}"]`);
  await expect(card).toHaveCount(1, { timeout: 30000 });
  // Espera em lista: o tempo e, embaixo, o canal com o que ele mede (o mesmo "WhatsApp há 8 dias · sem resposta").
  await expect(card.locator('.attend-wait .attend-l1')).toHaveText('8 dias');
  await expect(card.locator('.attend-wait .attend-l2')).toContainText('WhatsApp · sem resposta');
  await expect(card.locator('.attend-dot-old')).toHaveCount(1);
  await expect(card.locator('.case-name-conflict')).toContainText('Dante (simulação por SMS há 18 min) ≠ Sem nome na ficha (WhatsApp, última mensagem 25/09 · Ref CWZWK)');
  await card.locator('.case-more summary').click();
  const row = card.locator('.name-link');
  await expect(row.locator('.name-link-simulation')).toContainText('Dante');
  await expect(row.locator('.name-link-simulation')).toContainText('simulação por SMS há 18 min');
  await expect(row.locator('.name-link-ficha')).toContainText('WhatsApp, última mensagem 25/09');
  await expect(row).toContainText('nada foi desfeito');
  await row.getByRole('button', { name: 'Não é a mesma pessoa' }).click();
  await expect(row.getByRole('button', { name: /Separar: Dante/ })).toBeVisible();
  await row.getByRole('button', { name: 'É a mesma pessoa · confirmar vínculo' }).click();
  await expect.poll(() => posts.find((post) => post.path === '/api/panel/calc-route')?.body).toEqual({ action: 'name_confirm', messageId: MESSAGE, journeyId: JOURNEY });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

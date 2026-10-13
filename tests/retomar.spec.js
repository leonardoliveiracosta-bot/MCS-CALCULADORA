'use strict';

// Página /retomar: as 3 partes, uma por vez, no WhatsApp Web, no QR code e no SMS; a parte salva no servidor; voltar uma
// parte; horário do cliente (8:00 a 20:00); celular salva antes de sair para o WhatsApp; sem login, manda entrar pelo painel.
// /api/** simulado. Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/retomar.spec.js
const { test, expect } = require('@playwright/test');
const messages = require('../retomar/mensagens');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const id = (n) => `6e300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const WA = id(1), SMS = id(2), HAWAII = id(3);
const item = (journeyId, extra) => ({ journeyId, name: 'Cliente', ref: null, phone: '+13055550101', channel: 'WHATSAPP', language: 'en', languageDetected: true, days: 18, lastCustomerAt: '2026-09-25T15:00:00Z', lastMessage: 'Hi, I want a car', car: null, options: null, optionsKnown: true, progress: null, ...extra });
const LIST = { minDays: 15, generatedAt: '2026-10-13T15:00:00Z', today: { started: 0, completed: 0 }, excluded: {}, optionsAvailable: true, items: [
  item(WA, { name: 'Carlos Souza', ref: 'AB2CD', options: { key: 'journey:' + WA + ':CARRO', count: 12 }, car: 'BMW X5', lastCustomerAt: '2026-09-25T15:00:00Z' }),
  item(SMS, { name: 'Ana Lima', phone: '+17865550102', channel: 'SMS', language: 'pt', days: 20, lastCustomerAt: '2026-09-23T15:00:00Z' }),
  item(HAWAII, { name: 'Kai', phone: '+18085550103', days: 16, lastCustomerAt: '2026-09-27T15:00:00Z' })
] };

async function open(page, { width = 1280, session = true, mobile = false } = {}) {
  // 11:00 em Miami, 5:00 no Havaí.
  await page.clock.setFixedTime(new Date('2026-10-13T15:00:00Z'));
  await page.setViewportSize({ width, height: 900 });
  if (session) await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  const calls = [];
  const progress = new Map();
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) { calls.push({ external: url.href }); return route.abort(); }
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/sb', publishableKey: 'k', environment: 'preview' });
    if (url.pathname === '/api/panel/retomar' && request.method() === 'GET') return json({ ...LIST, items: LIST.items.map((one) => ({ ...one, progress: progress.get(one.journeyId) || null })) });
    if (url.pathname === '/api/panel/retomar') {
      const body = JSON.parse(request.postData() || '{}');
      calls.push(body);
      const one = LIST.items.find((row) => row.journeyId === body.journeyId);
      if (body.action === 'prepare') {
        const link = body.optionsKey ? 'https://www.mycarscout.net/o/' + 'c'.repeat(43) : null;
        const saved = { channel: one.channel, lang: body.lang, texts: messages.sequence({ lang: body.lang, name: one.name, link, car: body.car }), link, partsSent: 0, detected: [false, false, false], replied: false, resultRecorded: false };
        progress.set(one.journeyId, saved);
        return json({ progress: saved, review: messages.review({ name: one.name, link }) });
      }
      const saved = { ...progress.get(one.journeyId), partsSent: body.parts, resultRecorded: body.parts === 3 };
      progress.set(one.journeyId, saved);
      return json({ progress: saved });
    }
    if (url.pathname === '/api/panel/reply') { calls.push(JSON.parse(request.postData() || '{}')); return json({ recorded: true, messageId: id(99) }); }
    if (url.pathname === '/api/panel/push-handoff') return json({ available: false });
    return route.continue();
  });
  await page.goto(base + '/retomar/index.html', { waitUntil: 'domcontentloaded' });
  return calls;
}
const cardOf = (page, journeyId) => page.locator(`.card[data-journey="${journeyId}"]`);

test('computador · WhatsApp: a parte 1 abre o WhatsApp Web com o texto do Leo e o link; a parte fica salva; voltar', async ({ page, context }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const calls = await open(page);
  const card = cardOf(page, WA);
  await expect(card.locator('h2')).toHaveText('Carlos Souza');
  await expect(card).toContainText('12 opções no lote · a mensagem 3 leva o link das opções');
  await expect(card).toContainText('Horário do cliente: 11:00');
  await expect(card.locator('.part-text').first()).toHaveText(/^Hi Carlos, how are you\? First, I’m really sorry/);
  const opened = [];
  await context.route('https://web.whatsapp.com/**', (route) => { opened.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: 'WhatsApp' }); });
  await card.getByRole('button', { name: 'Parte 1 no WhatsApp Web' }).click();
  await expect.poll(() => opened.length).toBe(1);
  expect(opened[0]).toContain('https://web.whatsapp.com/send?phone=13055550101');
  expect(decodeURIComponent(opened[0])).toContain('Hi Carlos, how are you?');
  await expect(card.getByRole('button', { name: 'Parte 2 no WhatsApp Web' })).toBeVisible();
  await expect(card.locator('.part').first()).toContainText('✓ enviada');
  expect(calls.filter((call) => call.action).map((call) => [call.action, call.parts])).toEqual([['prepare', undefined], ['step', 1]]);
  expect(calls.find((call) => call.action === 'prepare').optionsKey).toBe('journey:' + WA + ':CARRO');
  await card.getByRole('button', { name: '◀ Voltar uma parte' }).click();
  await expect(card.getByRole('button', { name: 'Parte 1 no WhatsApp Web' })).toBeVisible();
  // Em andamento depois de 1 parte; os 3 balões; o português para conferir.
  await card.getByRole('button', { name: 'Ver em português' }).click();
  await expect(card.locator('.part-review').first()).toHaveText(/^Oi, Carlos, tudo bem\?/);
  await expect(card.locator('.part')).toHaveCount(3);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('computador · SMS: QR code para o celular e o SMS registrado na conversa; sem opções a mensagem 3 pede o carro', async ({ page }) => {
  const calls = await open(page);
  const card = cardOf(page, SMS);
  await expect(card).toContainText('Sem opções no lote · a mensagem 3 pede o carro e o valor');
  await expect(card.locator('select')).toHaveValue('pt');
  await expect(card.locator('.part-text').nth(2)).toHaveText(/me disser o carro e o seu valor máximo.*Você ainda está procurando um carro\?$/s);
  await card.getByRole('button', { name: 'Parte 1 por SMS no celular (QR)' }).click();
  await expect(page.locator('.wa-handoff-dialog .wa-handoff-qr svg')).toBeVisible();
  await expect.poll(() => calls.filter((call) => call.action === 'sms_sent').length).toBe(1);
  expect(calls.find((call) => call.action === 'sms_sent').text).toMatch(/^Oi, Ana, tudo bem\?/);
  await page.locator('.wa-handoff-dialog').getByRole('button', { name: 'Fechar' }).click();
  await expect(card.getByRole('button', { name: 'Parte 2 por SMS no celular (QR)' })).toBeVisible();
});

test('fora do horário do cliente (5:00 no Havaí): os botões de envio ficam bloqueados, os outros clientes não', async ({ page }) => {
  await open(page);
  const card = cardOf(page, HAWAII);
  await expect(card).toContainText('Fora do horário do cliente (são 05:00 lá)');
  await expect(card.getByRole('button', { name: 'Parte 1 no WhatsApp Web' })).toBeDisabled();
  await expect(cardOf(page, WA).getByRole('button', { name: 'Parte 1 no WhatsApp Web' })).toBeEnabled();
});

test('celular: a parte é salva antes de abrir o WhatsApp; a sequência completa grava o resultado', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const calls = await open(page, { width: 390 });
  const card = cardOf(page, WA);
  await card.getByRole('button', { name: 'Enviar parte 1 no WhatsApp' }).click();
  await expect.poll(() => calls.some((call) => call.external && call.external.startsWith('https://wa.me/13055550101'))).toBe(true);
  const order = calls.map((call) => call.action ? call.action + (call.parts || '') : call.external ? 'wa.me' : '?');
  expect(order.indexOf('step1')).toBeGreaterThan(-1);
  expect(order.indexOf('step1')).toBeLessThan(order.indexOf('wa.me'));
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await context.close();
});

test('sem login no navegador: pede para entrar pelo painel', async ({ page }) => {
  await open(page, { session: false });
  await expect(page.getByRole('link', { name: 'Entrar pelo painel' })).toHaveAttribute('href', '/painel/');
});

test('filtro: mais recentes (padrão), mais antigos, SMS e WhatsApp recentes ou antigos; continua depois de recarregar', async ({ page }) => {
  await open(page);
  const names = () => page.locator('.card h2').allTextContents();
  await expect(page.locator('.card')).toHaveCount(3);
  expect(await names()).toEqual(['Kai', 'Carlos Souza', 'Ana Lima']);
  const view = page.getByRole('combobox', { name: 'Filtrar e ordenar' });
  await view.selectOption('oldest');
  expect(await names()).toEqual(['Ana Lima', 'Carlos Souza', 'Kai']);
  await view.selectOption('sms_recent');
  expect(await names()).toEqual(['Ana Lima']);
  await view.selectOption('wa_recent');
  expect(await names()).toEqual(['Kai', 'Carlos Souza']);
  await view.selectOption('wa_oldest');
  expect(await names()).toEqual(['Carlos Souza', 'Kai']);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('combobox', { name: 'Filtrar e ordenar' })).toHaveValue('wa_oldest');
  expect(await page.locator('.card h2').allTextContents()).toEqual(['Carlos Souza', 'Kai']);
});

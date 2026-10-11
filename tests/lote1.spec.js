'use strict';

// Lote 1 da auditoria no navegador, com /api/** simulado (nenhuma chamada real, nada enviado).
// Run: PANEL_VISUAL_LOCAL=1 npx playwright test tests/lote1.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const JOURNEY = '51000000-0000-4000-8000-000000000001';

async function session(page) {
  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
  });
}

async function mockApi(page, overrides = {}) {
  const calls = [];
  await page.route('**/supabase-simulado/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    calls.push({ path: url.pathname, search: url.search, body });
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    for (const [pattern, handler] of Object.entries(overrides)) if (url.pathname === pattern) return handler({ url, body, json, route });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  return calls;
}

test('C5: contador com erro 500 não desloga; mostra "—" e aviso', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await session(page);
  // ENVIAR OPÇÕES counts from the batch view: that one fails, the others answer.
  await mockApi(page, { '/api/panel/records': ({ json, url }) => url.searchParams.get('view') === 'manheim' ? json({ error: 'PANEL_ACTION_FAILED' }, 500) : json({ items: [], page: 1, pageSize: 50, total: 0, hasMore: false, counts: { periodLeads: 0, situations: {}, sections: {} }, meta: {} }) });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#boot-warning')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#login-view')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('mcs_panel_session'))).not.toBeNull();
  await expect(page.locator('[data-count="searches"]').first()).toHaveText('—');
  expect(errors).toEqual([]);
});

function leadData(lastCustomerAt) {
  return {
    ref: 'ABC23', hasCalculatorRef: false, order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [],
    zip: '', state: null, city: null, timezone: 'America/New_York', goodHour: true, payment: 'cash', plate: 'transf', florida: true,
    maxBidCents: null, totalCeilingCents: null, bid: null, costs: null, score: null, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [],
    record: { id: JOURNEY, status: 'ATIVO', stage: 'RESPONDIDO', enabled: true, contact: { display_name: 'Cliente Teste' }, phones: [], attachments: [], returns: [],
      conversation: [{ id: 'm1', chat_id: 'c1', channel: 'WHATSAPP', direction: 'CUSTOMER', body_text: 'Oi, ainda tem o carro?', occurred_at_utc: lastCustomerAt }] }
  };
}

for (const scenario of [{ name: 'envia pelo painel com mensagem do cliente nas últimas 24 h', hoursAgo: 2, open: true }, { name: 'abre no celular fora da janela de 24 h', hoursAgo: 30, open: false }]) {
  test(`A20: "Responder pelo painel" ${scenario.name}`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    await session(page);
    const lastAt = new Date(Date.now() - scenario.hoursAgo * 3600000).toISOString();
    const calls = await mockApi(page, {
      '/api/panel/lead': ({ json }) => json(leadData(lastAt)),
      '/api/panel/reply': ({ body, json }) => {
        const who = { name: 'Cliente Teste', phone: '+13055550100', whatsappBase: 'https://wa.me/13055550100' };
        if (body.action === 'window') return json(scenario.open ? { allowed: true, openUntil: new Date(Date.parse(lastAt) + 86400000).toISOString(), lastCustomerAt: lastAt, ...who } : { allowed: false, ...who });
        return json({ error: 'NOT_EXPECTED_IN_TEST' }, 400);
      }
    });
    await page.goto(base + '/painel/#ficha/' + JOURNEY, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#lead-conversation')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => calls.some((call) => call.path === '/api/panel/reply' && call.body?.action === 'window')).toBe(true);
    // One send path for the composer too, said before the click: panel (window open) or phone (closed).
    const composer = page.locator('#lead-conversation .reply-composer');
    await expect(composer).toBeVisible();
    await expect(composer.locator('h4')).toHaveText('Responder pelo painel');
    await expect(composer).toContainText('Para Cliente Teste · +13055550100');
    // Empty (nothing translated): only your message, Traduzir and Enviar sem traduzir show; the rest waits for one of them.
    await expect(composer.locator('textarea').first()).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Traduzir', exact: true })).toBeVisible();
    await expect(composer.getByRole('button', { name: 'Enviar sem traduzir', exact: true })).toBeVisible();
    await expect(composer.locator('.reply-en')).toBeHidden();
    await expect(composer.locator('.reply-send')).toBeHidden();
    if (scenario.open) {
      await expect(composer).toContainText('Janela de 24 h aberta');
      await expect(composer).toContainText('sai pelo painel, só depois da sua confirmação');
      await expect(composer.locator('button.suggestion-send'), 'sem tradução, nada sai').toBeDisabled();
      await expect(composer.locator('a.suggestion-open')).toHaveAttribute('aria-disabled', 'true');
      await expect(composer.locator('.wa-phone')).toBeDisabled();
    } else {
      await expect(composer).toContainText('Janela de 24 h encerrada');
      await expect(composer).toContainText('abre a conversa no WhatsApp com');
      await expect(composer.locator('button.suggestion-send')).toHaveCount(0);
      await expect(composer.locator('a.suggestion-open')).toHaveAttribute('aria-disabled', 'true');
    }
    expect(calls.filter((call) => call.path === '/api/panel/reply' && call.body?.action === 'send')).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test('SMS: mesma caixa, tradução, QR do texto atual e rascunho ao voltar, sem envio no servidor', async ({ page }) => {
  await session(page);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const calls = await mockApi(page, {
    '/api/panel/lead': ({ json }) => { const data = leadData(new Date().toISOString()); data.record.conversation[0].channel = 'SMS'; return json(data); },
    '/api/panel/reply': ({ body, json }) => {
      if (body.action === 'window') return json({ channel: 'SMS', allowed: false, name: 'Cliente Teste', phone: '+13055550100' });
      if (body.action === 'translate') return json({ en: 'Hi, the car is ready.', pt_back: 'Oi, o carro está pronto.' });
      return json({ error: 'UNEXPECTED_SEND' }, 400);
    }
  });
  await page.goto(base + '/painel/#ficha/' + JOURNEY);
  const box = page.locator('#lead-conversation .reply-composer');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Para Cliente Teste · +13055550100');
  await box.locator('textarea').first().fill('Oi, o carro está pronto.');
  await box.getByRole('button', { name: 'Traduzir', exact: true }).click();
  await expect(box.locator('.reply-en')).toHaveValue('Hi, the car is ready.');
  await page.evaluate(() => { const make = window.qrcode; window.QR_TEXT = []; window.qrcode = (...args) => { const qr = make(...args), add = qr.addData; qr.addData = (text, ...rest) => { window.QR_TEXT.push(text); return add.call(qr, text, ...rest); }; return qr; }; });
  await box.getByRole('link', { name: 'Enviar por SMS' }).click();
  await expect(page.locator('.wa-handoff-dialog .wa-handoff-qr svg')).toHaveCount(1);
  expect(await page.evaluate(() => window.QR_TEXT)).toEqual(['sms:+13055550100&body=Hi%2C%20the%20car%20is%20ready.']);
  await expect(page.locator('.wa-handoff-push')).toHaveCount(0);
  await page.locator('.wa-handoff-dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await box.locator('textarea').first().fill('Texto alterado');
  await expect(box.locator('.reply-sms')).toHaveAttribute('aria-disabled', 'true');
  await page.locator('[data-view="today"]').first().click();
  await page.evaluate((id) => { location.hash = '#ficha/' + id; }, JOURNEY);
  await expect(box.locator('textarea').first()).toHaveValue('Texto alterado');
  expect(calls.filter((c) => c.path === '/api/panel/reply' && c.body?.action === 'send')).toHaveLength(0);
  expect(calls.filter((c) => c.path === '/api/panel/push-handoff')).toHaveLength(0);
  expect(errors).toEqual([]);
});

test('SMS no iPhone: abre o link direto com número e texto traduzido, sem QR ou confirmação extra', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await session(page);
  const calls = await mockApi(page, {
    '/api/panel/lead': ({ json }) => json(leadData(new Date().toISOString())),
    '/api/panel/reply': ({ body, json }) => body.action === 'window'
      ? json({ channel: 'SMS', allowed: false, name: 'Cliente Teste', phone: '+13055550100' })
      : json({ en: 'Hi!', pt_back: 'Oi!' })
  });
  await page.goto(base + '/painel/#ficha/' + JOURNEY);
  const box = page.locator('#lead-conversation .reply-composer');
  await box.locator('textarea').first().fill('Oi!');
  await box.getByRole('button', { name: 'Traduzir', exact: true }).click();
  await expect(box.locator('.reply-sms')).toHaveAttribute('href', 'sms:+13055550100&body=Hi!');
  // Observe the application's click decision; prevent only the test from opening a real native app.
  await box.locator('.reply-sms').evaluate((link) => link.addEventListener('click', (event) => {
    window.SMS_CLICK = { preventedByApp: event.defaultPrevented, url: link.getAttribute('href') }; event.preventDefault();
  }));
  await box.getByRole('link', { name: 'Enviar por SMS' }).tap();
  expect(await page.evaluate(() => window.SMS_CLICK)).toEqual({ preventedByApp: false, url: 'sms:+13055550100&body=Hi!' });
  await expect(page.locator('.wa-handoff-dialog')).toHaveCount(0);
  expect(await page.evaluate(() => MCSWaHandoff.smsUrl('+13055550100', 'Hi!', { userAgent: 'Android' }))).toBe('sms:+13055550100?body=Hi!');
  expect(calls.filter((c) => c.path === '/api/panel/reply' && c.body?.action === 'send')).toHaveLength(0);
  await context.close();
});

test('WhatsApp aberto: QR do texto revisado não envia nem registra; confirmação do painel continua única', async ({ page }) => {
  await session(page);
  const calls = await mockApi(page, {
    '/api/panel/lead': ({ json }) => json(leadData(new Date().toISOString())),
    '/api/panel/reply': ({ body, json }) => {
      if (body.action === 'window') return json({ allowed: true, openUntil: new Date(Date.now() + 3600000).toISOString(), name: 'Cliente Teste', phone: '+13055550100', whatsappBase: 'https://wa.me/13055550100' });
      if (body.action === 'translate') return json({ en: 'Hi!', pt_back: 'Oi!' });
      return json({ ok: true, simulated: true });
    }
  });
  await page.goto(base + '/painel/#ficha/' + JOURNEY);
  const box = page.locator('#lead-conversation .reply-composer');
  await expect(box.locator('.wa-phone')).toBeDisabled();
  await box.locator('textarea').first().fill('Oi!');
  await box.getByRole('button', { name: 'Traduzir', exact: true }).click();
  await page.evaluate(() => { const make = window.qrcode; window.QR_TEXT = []; window.qrcode = (...args) => { const qr = make(...args), add = qr.addData; qr.addData = (text, ...rest) => { window.QR_TEXT.push(text); return add.call(qr, text, ...rest); }; return qr; }; });
  await box.getByRole('button', { name: 'No celular', exact: true }).click();
  await expect(page.locator('.wa-handoff-dialog .wa-handoff-qr svg')).toHaveCount(1);
  expect(await page.evaluate(() => window.QR_TEXT)).toEqual(['https://wa.me/13055550100?text=Hi!']);
  expect(calls.filter((c) => c.path === '/api/panel/reply' && c.body?.action !== 'window' && c.body?.action !== 'translate')).toHaveLength(0);
  await page.locator('.wa-handoff-dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await box.locator('textarea').first().fill('https://www.mycarscout.net/t/example');
  await expect(box.locator('.wa-phone')).toBeDisabled();
  await box.getByRole('button', { name: 'Enviar sem traduzir', exact: true }).click();
  await box.getByRole('button', { name: 'No celular', exact: true }).click();
  expect(await page.evaluate(() => window.QR_TEXT)).toEqual(['https://wa.me/13055550100?text=Hi!', 'https://wa.me/13055550100?text=https%3A%2F%2Fwww.mycarscout.net%2Ft%2Fexample']);
  expect(calls.filter((c) => c.path === '/api/panel/reply' && c.body?.action === 'send')).toHaveLength(0);
  await page.locator('.wa-handoff-dialog').getByRole('button', { name: 'Fechar', exact: true }).click();
  await box.getByRole('button', { name: 'Enviar pelo painel', exact: true }).click();
  expect(calls.filter((c) => c.path === '/api/panel/reply' && c.body?.action === 'send')).toHaveLength(0);
  await box.getByRole('button', { name: 'Confirmar envio', exact: true }).click();
  await expect(box).toContainText('Enviado pelo painel');
  await expect(box.locator('.wa-phone')).toBeDisabled();
  expect(calls.filter((c) => c.path === '/api/panel/reply' && c.body?.action === 'send')).toHaveLength(1);
});

test('WhatsApp no iPhone: alternativa no aplicativo com janela aberta, número brasileiro e texto atual', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await session(page);
  const calls = await mockApi(page, {
    '/api/panel/lead': ({ json }) => json(leadData(new Date().toISOString())),
    '/api/panel/reply': ({ body, json }) => body.action === 'window'
      ? json({ allowed: true, openUntil: new Date(Date.now() + 3600000).toISOString(), name: 'Cliente Teste', phone: '+5521999990000', whatsappBase: 'https://wa.me/5521999990000' })
      : json({ error: 'UNEXPECTED_SEND' }, 400)
  });
  await page.goto(base + '/painel/#ficha/' + JOURNEY);
  const box = page.locator('#lead-conversation .reply-composer');
  await box.locator('textarea').first().fill('Hi, which option do you like?');
  await box.getByRole('button', { name: 'Enviar sem traduzir', exact: true }).tap();
  const app = box.getByRole('link', { name: 'Abrir no WhatsApp do celular', exact: true });
  await expect(app).toBeVisible();
  await expect(app).toHaveAttribute('aria-disabled', 'false');
  await expect(box.getByRole('button', { name: 'Enviar pelo painel', exact: true })).toBeEnabled();
  expect(await app.evaluate((link) => MCSWhatsApp.appUrl(link.href))).toBe('whatsapp://send?phone=5521999990000&text=Hi%2C%20which%20option%20do%20you%20like%3F');
  await expect(box.locator('.wa-phone')).toHaveCount(0);
  await box.locator('textarea').first().fill('New draft');
  await expect(app).toHaveAttribute('aria-disabled', 'true');
  expect(calls.filter((c) => c.path === '/api/panel/reply' && c.body?.action !== 'window')).toHaveLength(0);
  await context.close();
});

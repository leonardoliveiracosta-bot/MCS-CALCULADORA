'use strict';

// Abertura rápida (/api/panel/boot): duas cargas da lista ao mesmo tempo nunca fazem um caso sumir. Antes, a resposta
// mais antiga, processada por último, montava a lista com os casos que a outra já tinha apagado do navegador; o caso
// sumia sem aviso (só ficava a linha de decisão, sem carro) e a próxima abertura desenhava a lista sem ele.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/boot-concorrente.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `7f100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const NEW = id(1), OLD = id(2);
const item = (journeyId, name, phone, minutes, text) => ({
  kind: 'JOURNEY', id: journeyId, journeyId, name, contact: { display_name: name }, phones: [{ phone_e164: phone, is_primary: true }],
  sortAt: iso(minutes), lastCustomerAt: iso(minutes), awaitingReply: true,
  latestMessage: { direction: 'CUSTOMER', occurred_at_utc: iso(minutes), body_text: 'Oi', is_automatic: false, channel: 'WHATSAPP' },
  group: { key: 'NAO_ATENDIDO', label: 'Não atendidos', origin: { key: 'CALCULADORA:WHATSAPP', label: 'Veio pela calculadora · Via WhatsApp', financing: false }, calcMode: 'CARRO', hasCalculator: true,
    unattended: { reason: 'NO_RESPONSE', reasonText: 'Mensagem do cliente sem resposta', since: iso(minutes), waitedText: text, timeLabel: `WhatsApp há ${text} · sem resposta`, missing: 'Resposta', next: 'Responder o cliente' } },
  cardFacts: { modes: ['CARRO'], perMode: { CARRO: { vehicleText: '2013–2022 Porsche Cayenne', yearsText: '2013–2022', mileageText: '30000–80000' } }, vehicleText: '2013–2022 Porsche Cayenne' }
});
const NEW_29 = item(NEW, 'Mirzet', '+16166344376', 29, '29 min'), NEW_30 = item(NEW, 'Mirzet', '+16166344376', 30, '30 min');
const OLDER = item(OLD, 'Cliente Antigo', '+13055550100', 600, '10 h');
const today = (items) => ({ meta: { dataUpdatedAt: new Date().toISOString() }, items });

async function open(page, answers) {
  const calls = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/boot') {
      const body = JSON.parse(route.request().postData() || '{}');
      if (body.part !== 'main') return json({ part: body.part, parts: {} });
      calls.push(body);
      const answer = answers(calls.length, body);
      if (answer.delay) await new Promise((resolve) => setTimeout(resolve, answer.delay));
      return json({ part: 'main', generatedAt: new Date().toISOString(), parts: { today: answer.today, entry: { ok: true, hash: 'e', body: { chats: [], reviews: [] } }, triage: { ok: true, hash: 't', body: {} }, whatsapp: { ok: true, hash: 'w', body: {} } } });
    }
    if (url.pathname === '/api/panel/today') return json(today([NEW_30, OLDER]));
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: {}, requests: [], signals: [], meta: {} });
  });
  return calls;
}
const rowOf = (page, journeyId) => page.locator(`#today-list .attend-row[data-journey-id="${journeyId}"]`);

test('duas cargas ao mesmo tempo, respostas fora de ordem: nenhum caso some, nem agora nem na próxima abertura', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  // 1. First opening: the browser keeps both cases (keys A = "29 min", B).
  let stage = 1;
  await open(page, (n, body) => {
    if (stage === 1) return { today: { ok: true, hash: 'h1', body: { meta: {} }, order: ['A', 'B'], items: { A: NEW_29, B: OLDER } } };
    if (stage === 2) {
      // 2. Two loads at once after reopening. The first asks with A and B kept; it answers last and its server still saw
      // "29 min" (A, kept: nothing sent). The second answers first and already sees "30 min" (C, sent; A is dropped).
      const first = n === 2;
      return first ? { delay: 2500, today: { ok: true, hash: 'h2', body: { meta: {} }, order: ['A', 'B'], items: {} } }
        : { today: { ok: true, hash: 'h3', body: { meta: {} }, order: ['C', 'B'], items: { C: NEW_30 } } };
    }
    // 3. Next opening: nothing changed on the server since the slow answer (same hash).
    const known = new Set(body.have && body.have.todayItems || []);
    return body.have && body.have.today === 'h2' ? { today: { ok: true, hash: 'h2', same: true } }
      : { today: { ok: true, hash: 'h4', body: { meta: {} }, order: ['C', 'B'], items: known.has('C') ? {} : { C: NEW_30 } } };
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(rowOf(page, NEW)).toBeVisible({ timeout: 30000 });
  await expect(rowOf(page, OLD)).toBeVisible();
  stage = 2;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#today-list')).toBeVisible({ timeout: 30000 });
  await page.locator('[data-view="today"]').first().click();
  await expect(rowOf(page, NEW)).toContainText('2013–2022 Porsche Cayenne', { timeout: 30000 });
  await page.waitForTimeout(3500);
  await expect(rowOf(page, NEW)).toContainText('2013–2022 Porsche Cayenne');
  stage = 3;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(rowOf(page, OLD)).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  // The newest case is still there, with its car and its time; the other case too.
  await expect(rowOf(page, NEW)).toContainText('2013–2022 Porsche Cayenne');
  await expect(rowOf(page, NEW).locator('.attend-wait')).toContainText('30 min');
  await expect(rowOf(page, OLD)).toBeVisible();
  expect(errors).toEqual([]);
});

// The list is drawn again when the incomplete requests arrive (seconds after the opening): the screen never moves.
for (const scrolled of [0, 600]) {
  test(`redesenho tardio da lista não move a tela (${scrolled ? 'rolada até ' + scrolled + ' px' : 'no topo'})`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
    const many = Array.from({ length: 40 }, (_, n) => item(id(100 + n), 'Cliente ' + n, '+1305555' + String(2000 + n), 60 * (n + 1), (n + 1) + ' h'));
    const order = many.map((_, n) => 'k' + n), items = Object.fromEntries(many.map((one, n) => ['k' + n, one]));
    await open(page, () => ({ today: { ok: true, hash: 'x' + scrolled, body: { meta: {} }, order, items } }));
    await page.route('**/api/panel/pesquisas', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: Array.from({ length: 11 }, (_, n) => ({ key: 'p' + n, state: 'PRECISA_DETALHE', person: { journeyId: id(300 + n), name: 'Pedido ' + n }, lacksText: 'Falta o carro' })), meta: {} }) });
    });
    await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#today-list .attend-row')).toHaveCount(30, { timeout: 30000 });
    if (scrolled) await page.evaluate((y) => window.scrollTo(0, y), scrolled);
    // The case at the top of the screen (scrolled) and where it is.
    const topRow = () => page.evaluate(() => { const row = [...document.querySelectorAll('#today-list .attend-row')].find((one) => one.getBoundingClientRect().bottom > 0); return row ? { key: row.dataset.caseKey, top: Math.round(row.getBoundingClientRect().top) } : null; });
    const before = await topRow();
    // The 11 incomplete requests join the list (TODOS 40 → 51): the list was drawn again.
    await expect(page.locator('[data-count="today"]')).toHaveText('51', { timeout: 30000 });
    await page.waitForTimeout(1500);
    if (!scrolled) expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
    else expect(await topRow()).toEqual(before);
    expect(errors).toEqual([]);
  });
}

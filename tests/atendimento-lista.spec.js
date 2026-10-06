'use strict';

// ATENDIMENTO em lista (aba TODOS): uma linha por caso, ~8 por tela no computador, cartão compacto no celular.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/atendimento-lista.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
const SHOTS = process.env.PANEL_SHOTS_DIR || '';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const HOUR = 3600000, DAY = 24 * HOUR;
const id = (n) => `7c000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const waiting = (ms, channel = 'WhatsApp') => {
  const text = ms < 48 * HOUR ? `${Math.floor(ms / HOUR)} h` : `${Math.floor(ms / DAY)} dias`;
  return { key: 'NAO_ATENDIDO', label: 'Não atendidos', origin: { key: 'CALCULADORA:WHATSAPP', label: 'Calculadora', financing: false },
    unattended: { reason: 'NO_RESPONSE', reasonText: 'Mensagem do cliente sem resposta', waitedMs: ms, waitedText: text, timeLabel: `${channel} há ${text} · sem resposta`, missing: 'Resposta', next: 'Responder o cliente' } };
};
const valor = (n, car, bid, zip, ms) => ({ kind: 'JOURNEY', id: id(n), journeyId: id(n), name: '', contact: { display_name: '' }, awaitingReply: true,
  phones: [{ phone_e164: '+1551300' + String(9100 + n), is_primary: true }], hasCalcRef: true, calcRef: 'R' + String(n).padStart(4, 'Q'),
  cardFacts: { modes: ['VALOR'], perMode: { VALOR: { vehicleText: car, budgetCents: bid * 100 } }, zipText: zip }, group: waiting(ms) });
const carro = (n, car, years, miles, zip, ms) => ({ kind: 'JOURNEY', id: id(n), journeyId: id(n), name: '', contact: { display_name: '' }, awaitingReply: true,
  phones: [{ phone_e164: '+1424265' + String(8700 + n), is_primary: true }], hasCalcRef: true, calcRef: 'F' + String(n).padStart(4, 'Z'),
  cardFacts: { modes: ['CARRO'], perMode: { CARRO: { vehicleText: car, yearsText: years, mileageText: miles } }, zipText: zip }, group: waiting(ms, 'SMS') });
const ITEMS = [
  valor(1, 'BMW M4', 4000, '07501 · Paterson · NJ', 17 * DAY),
  valor(2, 'Dodge Charger', 5000, '80019 · Aurora · CO', 17 * DAY),
  valor(3, 'Land Rover Range Rover Velar', 18000, '60452 · Oak Forest · IL', 16 * DAY),
  valor(4, 'Chevrolet Tahoe', 45000, '85251 · Scottsdale · AZ', 3 * DAY),
  valor(5, 'Ford Mustang', 20000, '48858 · Mount Pleasant · MI', 2 * DAY),
  carro(6, '2016–2026 Porsche Cayenne · 2026 Tesla Model X', '2016–2026', '1–70.000 mi', '60618 · Chicago · IL', 17 * HOUR),
  carro(7, '2023–2026 Lexus GS', '2023–2026', '30.000–50.000 mi', '77001 · Houston · TX', 17 * HOUR),
  carro(8, '1995–1999 Mercedes-Benz S-Class · 1995–1999 Buick LeSabre', '1995–1999', '20.000–100.000 mi', '33647 · Tampa · FL', 16 * HOUR),
  carro(9, '2025–2027 Porsche 911', '2025–2027', '100–20.000 mi', '11553 · Uniondale · NY', 15 * HOUR),
  { kind: 'JOURNEY', id: id(10), journeyId: id(10), name: 'Maria Souza', contact: { display_name: 'Maria Souza' }, awaitingReply: false, phones: [{ phone_e164: '+13055550110', is_primary: true }],
    group: { key: 'ATENDIDO', label: 'Atendidos', origin: { key: 'MENSAGEM:WHATSAPP', label: 'Mensagem', financing: false }, unattended: null } }
];

async function open(page, width, height) {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
    // An old pill choice left in the browser never narrows the list again.
    localStorage.setItem('mcs_attend_bucket', 'aguardando');
    localStorage.setItem('mcs_today-subject', 'FINANCIAMENTO');
    window.__opened = [];
    window.open = (url, target) => { window.__opened.push([String(url), target]); return null; };
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') return json({ meta: { dataUpdatedAt: new Date().toISOString() }, items: ITEMS });
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], suggestions: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  return errors;
}

test('computador: uma linha por caso, cerca de 8 por tela, cor só na bolinha', async ({ page }) => {
  const errors = await open(page, 1280, 900);
  const rows = page.locator('#today-list .attend-row');
  await expect(rows).toHaveCount(ITEMS.length, { timeout: 30000 });
  await expect(page.locator('[data-count="today"]')).toHaveText(String(ITEMS.length));
  // Rows visible in the first screen (the list starts below the bar and the numbers).
  const fit = await rows.evaluateAll((all) => all.filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight).length);
  expect(fit).toBeGreaterThanOrEqual(7);
  const first = rows.first();
  await expect(first.locator('.attend-wait .attend-l1')).toHaveText('17 dias');
  await expect(first.locator('.attend-wait .attend-l2')).toHaveText('WhatsApp · sem resposta');
  await expect(first.locator('.attend-ref')).toHaveText('REF RQQQ1');
  await expect(first.locator('.attend-car .attend-l2')).toHaveText('Calculate My Cost · por valor');
  await expect(first.locator('.attend-order .attend-l2')).toHaveText('lance máximo');
  await expect(first.locator('.attend-place .attend-l1')).toHaveText('Paterson · NJ');
  await expect(first.locator('.attend-place .attend-l2')).toHaveText('07501');
  await expect(page.locator('#today-list .attend-dot-old')).toHaveCount(3);
  await expect(page.locator('#today-list .attend-dot-mid')).toHaveCount(2);
  await expect(page.locator('#today-list .attend-dot-new')).toHaveCount(4);
  // No wait time (answered case): the short status, no dot.
  const maria = rows.filter({ hasText: 'Maria Souza' });
  await expect(maria.locator('.attend-dot')).toHaveCount(0);
  await expect(maria.locator('.attend-wait')).toContainText('Aguardando o cliente');
  // Find One: years and mileage in Pedido.
  const lexus = rows.filter({ hasText: 'Lexus GS' });
  await expect(lexus.locator('.attend-order')).toContainText('2023–2026');
  await expect(lexus.locator('.attend-order')).toContainText('30.000–50.000 mi');
  await expect(lexus.locator('.attend-wait .attend-l2')).toHaveText('SMS · sem resposta');
  // "prontos para comprar" is gold, not red; the old filters are gone.
  const hot = page.locator('[data-today-stat="hot"] strong');
  expect(await hot.evaluate((node) => getComputedStyle(node).color)).toBe('rgb(201, 162, 39)');
  await expect(page.locator('[data-attend-bucket], #today-origin, #today-subject, #today-period, .today-primary')).toHaveCount(0);
  await expect(page.locator('#today-panel #ai-budget')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'atendimento-lista-1280.png') });
  // The phone opens WhatsApp and the row stays closed; the checkbox selects without opening.
  await first.locator('.attend-phone').click();
  expect((await page.evaluate(() => window.__opened)).map(([url]) => url).join(' ')).toMatch(/whatsapp\.com\/send\?phone=15513009101|wa\.me\/15513009101/);
  await first.locator('.case-pick').click();
  await expect(page.locator('.attend-bulk')).toContainText('1 selecionado');
  await expect(page.locator('#detail-panel')).toBeHidden();
  // The search narrows the loaded list.
  await page.locator('#attend-search').fill('Tahoe');
  await expect(rows).toHaveCount(1);
  await page.locator('#attend-search').fill('');
  await expect(rows).toHaveCount(ITEMS.length);
  // The whole row opens the ficha (on the conversation, as "Responder" did).
  await rows.nth(1).locator('.attend-car').click();
  await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 30000 });
  expect(errors).toEqual([]);
});

test('celular: cada linha vira um cartão compacto com as mesmas informações, sem rolagem lateral', async ({ page }) => {
  const errors = await open(page, 390, 844);
  const rows = page.locator('#today-list .attend-row');
  await expect(rows).toHaveCount(ITEMS.length, { timeout: 30000 });
  await expect(page.locator('.attend-head')).toBeHidden();
  const first = rows.first();
  for (const text of ['17 dias', 'WhatsApp · sem resposta', 'REF RQQQ1', 'BMW M4', 'Calculate My Cost · por valor', 'lance máximo', 'Paterson · NJ', '07501']) await expect(first).toContainText(text);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'atendimento-lista-390.png') });
  expect(errors).toEqual([]);
});

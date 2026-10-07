'use strict';

// ATENDIMENTO em tabela (aba TODOS): uma linha por caso com Espera · Canal · Ref · Telefone · Carro · Valor · Ano ·
// Milha · Origem · Estado, no máximo 8 por tela no computador, cartão com os mesmos campos no celular.
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
  return { key: 'NAO_ATENDIDO', label: 'Não atendidos', origin: { key: 'CALCULADORA:' + channel.toUpperCase(), group: 'CALCULADORA', sub: channel.toUpperCase(), label: 'Calculadora', financing: false },
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
    group: { key: 'ATENDIDO', label: 'Atendidos', origin: { key: 'MENSAGEM:WHATSAPP', group: 'MENSAGEM', sub: 'WHATSAPP', label: 'Mensagem', financing: false }, unattended: null } },
  // Came by the site's financing form; came from the site with the calculator not known (Ref to recover).
  { kind: 'JOURNEY', id: id(11), journeyId: id(11), name: 'Paulo Financia', contact: { display_name: 'Paulo Financia' }, awaitingReply: false, phones: [{ phone_e164: '+13055550111', is_primary: true }],
    group: { key: 'ATENDIDO', label: 'Atendidos', origin: { key: 'MENSAGEM:SMS', group: 'MENSAGEM', sub: 'SMS', label: 'Mensagem', financing: true }, unattended: null } },
  { kind: 'JOURNEY', id: id(12), journeyId: id(12), name: 'Rita Site', contact: { display_name: 'Rita Site' }, awaitingReply: false, phones: [], refState: 'A_RECUPERAR',
    cardFacts: { zipText: '33101' }, group: { key: 'ATENDIDO', label: 'Atendidos', origin: { key: 'CALCULADORA:WHATSAPP', group: 'CALCULADORA', sub: 'WHATSAPP', label: 'Calculadora', financing: false }, unattended: null } }
];

async function open(page, width, height, contactResults = {}) {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
    // An old pill choice left in the browser never narrows the list again.
    localStorage.setItem('mcs_attend_bucket', 'aguardando');
    localStorage.setItem('mcs_today-subject', 'FINANCIAMENTO');
    localStorage.setItem('mcs_zip_33101', 'Miami · FL');
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
    if (url.pathname === '/api/panel/today') return json({ meta: { dataUpdatedAt: new Date().toISOString() }, items: ITEMS, contactResults });
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], suggestions: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  return errors;
}

test('computador: tabela com as 10 colunas, uma linha de texto por célula, no máximo 8 linhas por tela', async ({ page }) => {
  const errors = await open(page, 1280, 900);
  const rows = page.locator('#today-list .attend-row');
  await expect(rows).toHaveCount(ITEMS.length, { timeout: 30000 });
  await expect(page.locator('[data-count="today"]')).toHaveText(String(ITEMS.length));
  await expect(page.locator('.attend-head > span')).toHaveText(['', 'Espera', 'Canal', 'Ref', 'Telefone', 'Carro', 'Valor', 'Ano', 'Milha', 'Origem', 'Estado', '']);
  // At most 8 rows in the first screen, and at least 5 (the list starts below the bar and the numbers).
  const fit = await rows.evaluateAll((all) => all.filter((row) => row.getBoundingClientRect().bottom <= window.innerHeight).length);
  expect(fit).toBeLessThanOrEqual(8);
  expect(fit).toBeGreaterThanOrEqual(5);
  const cells = async (row) => (await row.locator(':scope > .attend-cell[data-label]').allTextContents()).map((text) => text.replace(/\u00a0/g, ' '));
  // Calculate My Cost: value, no years or mileage; the state of the ZIP.
  expect(await cells(rows.first())).toEqual(['17 dias · sem resposta', 'WhatsApp', 'RQQQ1', '(551) 300-9101', 'BMW M4', 'US$ 4.000,00', '', '', 'Calculate My Cost', 'NJ']);
  // Find One For Me: years and mileage, no value; SMS.
  const lexus = rows.filter({ hasText: 'Lexus GS' });
  expect(await cells(lexus)).toEqual(['17 h · sem resposta', 'SMS', 'FZZZ7', '(424) 265-8707', '2023–2026 Lexus GS', '', '2023–2026', '30.000–50.000 mi', 'Find One For Me', 'TX']);
  // Financing form of the site; site with the calculator not known; direct message (blank Origem); blank fields stay blank.
  const paulo = rows.filter({ has: page.locator('[title="Financiamento"]') });
  expect((await cells(paulo))[1]).toBe('SMS');
  expect((await cells(paulo))[8]).toBe('Financiamento');
  const rita = rows.filter({ has: page.locator('.attend-origin[title="Site"]') });
  expect(await cells(rita)).toEqual([await rita.locator('.attend-wait').textContent(), 'WhatsApp', '', '', '', '', '', '', 'Site', 'FL']);
  const maria = rows.filter({ hasText: '(305) 555-0110' });
  expect((await cells(maria))[8]).toBe('');
  // Nothing written as "—" or "não informado" in a row; no dot, chip, tag or gold in a row.
  expect(await rows.evaluateAll((all) => all.map((row) => row.textContent).join(' '))).not.toMatch(/—|não informado|Sem Ref|sem número/);
  await expect(page.locator('#today-list .attend-row .attend-dot, #today-list .attend-row .attend-chip, #today-list .attend-row .badge, #today-list .attend-row .attend-chev')).toHaveCount(0);
  // One line of text per cell: a long text ends in "…" and is whole on hover.
  const porsche = rows.filter({ hasText: 'Porsche Cayenne' }).locator('.attend-car');
  expect(await porsche.evaluate((node) => [getComputedStyle(node).whiteSpace, getComputedStyle(node).textOverflow, node.scrollWidth > node.clientWidth])).toEqual(['nowrap', 'ellipsis', true]);
  await expect(porsche).toHaveAttribute('title', '2016–2026 Porsche Cayenne · 2026 Tesla Model X');
  const heights = await rows.evaluateAll((all) => all.map((row) => Math.round(row.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  // Look of the photo: bold black titles with a line under them, rows alternating gray and white.
  const head = await page.locator('.attend-head').evaluate((node) => [getComputedStyle(node).fontWeight, getComputedStyle(node).color, getComputedStyle(node).borderBottomStyle]);
  expect(head).toEqual(['700', 'rgb(23, 26, 32)', 'solid']);
  const backgrounds = await rows.evaluateAll((all) => all.slice(0, 2).map((row) => getComputedStyle(row).backgroundColor));
  expect(backgrounds).toEqual(['rgb(255, 255, 255)', 'rgb(242, 243, 245)']);
  // "prontos para comprar" (numbers on top) stays gold; the old filters are gone.
  const hot = page.locator('[data-today-stat="hot"] strong');
  expect(await hot.evaluate((node) => getComputedStyle(node).color)).toBe('rgb(201, 162, 39)');
  await expect(page.locator('[data-attend-bucket], #today-origin, #today-subject, #today-period, .today-primary')).toHaveCount(0);
  await expect(page.locator('#today-panel #ai-budget')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'atendimento-tabela-1280.png') });
  // The phone opens WhatsApp and the row stays closed; the checkbox selects without opening.
  await rows.first().locator('.attend-phone').click();
  expect((await page.evaluate(() => window.__opened)).map(([url]) => url).join(' ')).toMatch(/whatsapp\.com\/send\?phone=15513009101|wa\.me\/15513009101/);
  await rows.first().locator('.case-pick').click();
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

test('celular: cada linha vira um cartão com os mesmos campos, sem rolagem lateral', async ({ page }) => {
  const errors = await open(page, 390, 844);
  const rows = page.locator('#today-list .attend-row');
  await expect(rows).toHaveCount(ITEMS.length, { timeout: 30000 });
  await expect(page.locator('.attend-head')).toBeHidden();
  const first = rows.first();
  for (const text of ['17 dias · sem resposta', 'WhatsApp', 'RQQQ1', 'BMW M4', 'US$ 4.000,00', 'Calculate My Cost', 'NJ']) await expect(first).toContainText(text);
  // Same fields with their name; an empty field takes no space.
  expect(await first.locator('.attend-value').evaluate((node) => getComputedStyle(node, '::before').content)).toBe('"Valor: "');
  await expect(first.locator('.attend-year')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'atendimento-tabela-390.png') });
  expect(errors).toEqual([]);
});

test('Espera: o resultado marcado na ficha aparece em negrito no lugar de "sem resposta"; sem marca, "sem resposta"', async ({ page }) => {
  const errors = await open(page, 1280, 900, { [id(1)]: { type: 'ANSWERED', label: 'Atendeu', at: new Date().toISOString() }, [id(7)]: { type: 'NO_ANSWER', label: 'Não atendeu', at: new Date().toISOString() } });
  const rows = page.locator('#today-list .attend-row');
  await expect(rows).toHaveCount(ITEMS.length, { timeout: 30000 });
  // The time stays as it was; the mark replaces "sem resposta", in bold.
  const ana = page.locator(`#today-list .attend-row[data-journey-id="${id(1)}"] .attend-wait`);
  await expect(ana).toHaveText('17 dias · Atendeu');
  await expect(ana.locator('strong')).toHaveText('Atendeu');
  expect(await ana.locator('strong').evaluate((node) => Number(getComputedStyle(node).fontWeight))).toBeGreaterThanOrEqual(700);
  await expect(ana).toHaveAttribute('title', '17 dias · Atendeu');
  await expect(page.locator(`#today-list .attend-row[data-journey-id="${id(7)}"] .attend-wait`)).toHaveText('17 h · Não atendeu');
  // Nothing marked: "sem resposta", not bold (the common path stays as it was).
  const bia = page.locator(`#today-list .attend-row[data-journey-id="${id(2)}"] .attend-wait`);
  await expect(bia).toHaveText('17 dias · sem resposta');
  await expect(bia.locator('strong')).toHaveCount(0);
  // Messages never set the state: a case "aguardando o cliente" with nothing marked is "sem resposta".
  await expect(page.locator(`#today-list .attend-row[data-journey-id="${id(10)}"] .attend-wait`)).toHaveText('Sem resposta');
  // The other columns do not change.
  await expect(page.locator(`#today-list .attend-row[data-journey-id="${id(1)}"] .attend-channel`)).toHaveText('WhatsApp');
  expect(errors).toEqual([]);
});

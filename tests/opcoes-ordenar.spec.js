'use strict';

// ENVIAR OPÇÕES · "Ordenar" a fila (quem tem carro no lote e ainda não recebeu a V1), com /api/** simulado.
// Recente/antigo = última mensagem DO CLIENTE (nunca a nossa resposta); sem mensagem vai para o fim e nunca
// some; a ordem vale para a fila inteira, junto com "Buscar na fila"; a escolha volta ao recarregar.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/opcoes-ordenar.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const HOUR = 3600000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const id = (n) => `6e100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Last CUSTOMER message: Ana WhatsApp 1 h, Bia SMS 3 h, Caio WhatsApp 5 h (but our reply 10 min ago),
// Duda SMS 10 h. Eva is an order without any message.
const PEOPLE = [
  { n: 1, name: 'Ana Zap', medium: 'WHATSAPP', hours: 1 },
  { n: 2, name: 'Bia Sms', medium: 'SMS', hours: 3 },
  { n: 3, name: 'Caio Zap', medium: 'WHATSAPP', hours: 5, ourReplyHours: 0.15 },
  { n: 4, name: 'Duda Sms', medium: 'SMS', hours: 10 }
];
const journeys = PEOPLE.map((person) => ({
  id: id(person.n), reference_code: null, status: 'ATIVO', stage: 'RESPONDIDO', enabled: true, name: person.name, contact: { display_name: person.name }, phones: [],
  created_at: ago(48), contactAt: ago(person.hours), contactMedium: person.medium, contactChannel: person.medium,
  latestMessage: { direction: person.ourReplyHours ? 'MCS' : 'CUSTOMER', occurred_at_utc: ago(person.ourReplyHours || person.hours) }
}));
const order = { ref: 'EVA22', key: 'ref:EVA22', contactName: 'Eva Sem Mensagem', vehicleText: 'Honda CR-V', simulations: [], logicalModes: ['CARRO'], contactAt: null };
const wish = [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022 }];
const offer = { lane: 1, offLane: 0, incomplete: 0, selected: 0, selectedIds: [], max: 10 };
const demands = [
  ...PEOPLE.map((person) => ({ key: `journey:${id(person.n)}:CARRO`, mode: 'CARRO', targetType: 'JOURNEY', journeyId: id(person.n), ref: null, name: person.name, wishes: wish, issues: [], matchCount: 1, offer })),
  { key: 'ref:EVA22:CARRO', mode: 'CARRO', targetType: 'ORDER', journeyId: null, ref: 'EVA22', calcRef: 'EVA22', name: 'Eva Sem Mensagem', wishes: wish, issues: [], matchCount: 1, offer }
];
const manheim = {
  items: journeys, orders: [order], demands, targets: [], review: [], uploads: [], undoAvailable: true,
  upload: { id: id(90), vehicle_count: 10, matched_vehicle_count: 5, uploaded_at: ago(2), current_lead_count: 5 },
  counts: { VALOR: { demands: 0, served: 0, matches: 0 }, CARRO: { demands: 5, served: 5, matches: 5 }, total: { people: 5, served: 5, matches: 5, review: 0 } }, meta: {}
};

async function openQueue(page, opened) {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  page.on('console', (entry) => { if (entry.type() === 'error' && !/Failed to load resource/.test(entry.text())) errors.push(entry.text()); });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') === 'manheim') return json(manheim);
    if (url.pathname === '/api/panel/records' && url.searchParams.get('id')) { opened.push(url.searchParams.get('id')); return json({ item: null }); }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], requests: [], demands: [], v1: {}, v2: {}, meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  // The panel always opens in ATENDER AGORA.
  await expect(page.locator('#page-title')).toHaveText('ATENDER AGORA', { timeout: 30000 });
  await page.locator('[data-view="searches"]').click();
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(5, { timeout: 30000 });
  return errors;
}
const order_ = (page) => page.locator('#options-queue .options-queue-card').evaluateAll((cards) => cards.map((card) => (card.innerText.match(/Ana Zap|Bia Sms|Caio Zap|Duda Sms|Eva Sem Mensagem/) || ['?'])[0]));
const sortBox = (page) => page.locator('#options-queue-sort');

test('Ordenar: 4 opções, pela última mensagem do cliente, sem mensagem no fim; junto com a busca; volta ao recarregar', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const opened = [];
  const errors = await openQueue(page, opened);
  const box = sortBox(page);
  await expect(page.locator('label', { has: box })).toContainText('Ordenar');
  await expect(box.locator('option')).toHaveText(['Mais recentes', 'Mais antigos', 'Mensagem SMS recentes primeiro', 'Mensagem WhatsApp recentes primeiro']);
  // Default: most recent customer message first (Caio's newer reply from us does not count).
  await expect(box).toHaveValue('recent');
  expect(await order_(page)).toEqual(['Ana Zap', 'Bia Sms', 'Caio Zap', 'Duda Sms', 'Eva Sem Mensagem']);
  // Desktop: on the same line as "Buscar na fila".
  const searchBox = await page.locator('#options-queue-search').boundingBox();
  const sortRect = await box.boundingBox();
  expect(Math.abs(searchBox.y - sortRect.y)).toBeLessThan(8);

  await box.selectOption('oldest');
  expect(await order_(page)).toEqual(['Duda Sms', 'Caio Zap', 'Bia Sms', 'Ana Zap', 'Eva Sem Mensagem']);
  await box.selectOption('sms');
  expect(await order_(page)).toEqual(['Bia Sms', 'Duda Sms', 'Ana Zap', 'Caio Zap', 'Eva Sem Mensagem']);
  await box.selectOption('whatsapp');
  expect(await order_(page)).toEqual(['Ana Zap', 'Caio Zap', 'Bia Sms', 'Duda Sms', 'Eva Sem Mensagem']);

  // Search + sort: the search filters, the sort orders the result; changing the sort keeps the typed search.
  await page.locator('#options-queue-search').fill('sms');
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(2);
  expect(await order_(page)).toEqual(['Bia Sms', 'Duda Sms']);
  await box.selectOption('oldest');
  expect(await order_(page)).toEqual(['Duda Sms', 'Bia Sms']);
  await expect(page.locator('#options-queue-search')).toHaveValue('sms');
  // Changing the order opened no ficha and did not leave the tab.
  expect(opened).toEqual([]);
  await expect(page).not.toHaveURL(/#ficha\//);
  await expect(page.locator('#page-title')).toHaveText('ENVIAR OPÇÕES');

  // The choice comes back after reloading (the panel still opens in ATENDER AGORA).
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('#page-title')).toHaveText('ATENDER AGORA', { timeout: 30000 });
  await page.locator('[data-view="searches"]').click();
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(5, { timeout: 30000 });
  await expect(sortBox(page)).toHaveValue('oldest');
  expect(await order_(page)).toEqual(['Duda Sms', 'Caio Zap', 'Bia Sms', 'Ana Zap', 'Eva Sem Mensagem']);
  expect(errors).toEqual([]);
});

test('Ordenar no celular: cabe na largura, sem rolagem lateral', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = await openQueue(page, []);
  const box = sortBox(page);
  await expect(box).toBeVisible();
  const rect = await box.boundingBox();
  expect(rect.x).toBeGreaterThanOrEqual(0);
  expect(rect.x + rect.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await box.selectOption('sms');
  expect(await order_(page)).toEqual(['Bia Sms', 'Duda Sms', 'Ana Zap', 'Caio Zap', 'Eva Sem Mensagem']);
  expect(errors).toEqual([]);
});

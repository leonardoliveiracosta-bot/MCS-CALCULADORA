'use strict';

// ENVIAR OPÇÕES mostra todos (as mesmas pessoas de TODOS, antiga ATENDER AGORA), na ordem da última
// mensagem do cliente. Quem não tem carro diz por quê: busca ainda não feita (falta informação ou
// nenhum pedido), busca feita sem carro no lote atual, ou pedido ainda não comparado com o lote atual
// (botão Atualizar compara de novo). Quem já recebeu V1 aparece com esse aviso. A contagem da aba
// continua sendo quem tem carro e ainda não recebeu V1. /api/** simulado.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/opcoes-todos.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const HOUR = 3600000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const id = (n) => `6e200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const NAMES = ['Ana Carro', 'Bia Sem Carro', 'Caio Atualizar', 'Duda Falta', 'Eva V1', 'Fabio Sem Pedido'];
const journeys = NAMES.map((name, index) => ({
  id: id(index + 1), reference_code: 'REF' + (index + 1) + 'X', status: 'ATIVO', stage: 'RESPONDIDO', enabled: true, name, state: index === 0 ? 'FL' : '', contact: { display_name: name }, phones: [],
  created_at: ago(48), simulations: [{ occurredAt: ago(200 - index * 10) }], contactAt: ago(index + 1), contactMedium: 'WHATSAPP', contactChannel: 'WHATSAPP', latestMessage: { direction: 'CUSTOMER', occurred_at_utc: ago(index + 1) }
}));
const wish = [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022 }];
const offer = { lane: 2, offLane: 0, incomplete: 0, selected: 0, selectedIds: [], max: 10 };
const demand = (n, extra) => ({ key: `journey:${id(n)}:CARRO`, mode: 'CARRO', targetType: 'JOURNEY', journeyId: id(n), ref: null, name: NAMES[n - 1], wishes: wish, issues: [], matchCount: 0, compared: true, offer: { ...offer, lane: 0 }, ...extra });
const manheim = {
  items: journeys, orders: [], targets: [], uploads: [], undoAvailable: true,
  demands: [demand(1, { matchCount: 2, offer }), demand(2), demand(3, { compared: false }), demand(5, { matchCount: 1, offer: { ...offer, lane: 1 } })],
  review: [{ key: `journey:${id(4)}:CARRO`, mode: 'CARRO', journeyId: id(4), name: NAMES[3], issues: [{ code: 'MODEL_MISSING', text: 'Falta o modelo' }] }],
  upload: { id: id(90), vehicle_count: 10, matched_vehicle_count: 5, uploaded_at: ago(2), current_lead_count: 2 },
  counts: { VALOR: { demands: 0, served: 0, matches: 0 }, CARRO: { demands: 4, served: 2, matches: 3 }, total: { people: 4, served: 2, matches: 3, review: 1 } }, meta: {}
};
const funnel = { v1: { tapped: [], waiting: [{ vitrineId: id(70), journeyId: id(5), referenceCode: 'REF5X', name: NAMES[4], cars: [], vins: [] }], expired: [] }, v2: { bid: [], waiting: [], expired: [] }, counts: { v1Action: 0, v2Action: 0 } };

test('ENVIAR OPÇÕES: todos, com o motivo de quem não tem carro; Atualizar compara de novo; aba TODOS', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  const errors = [], posts = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.addInitScript(() => { localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })); localStorage.removeItem('mcs_options_queue_sort'); });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') === 'manheim') return json(manheim);
    if (url.pathname === '/api/panel/vitrine-funnel') return json(funnel);
    if (url.pathname === '/api/panel/manheim-options' && request.method() === 'POST') { posts.push(JSON.parse(request.postData() || '{}')); return json({ withdrawn: 0, kept: 0, added: 2 }); }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], requests: [], demands: [], v1: {}, v2: {}, meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  // The first tab is now called TODOS and the panel still opens on it.
  await expect(page.locator('#page-title')).toHaveText('TODOS', { timeout: 30000 });
  await expect(page.locator('.tab[data-view="today"]')).toContainText('TODOS');
  await page.locator('[data-view="searches"]').click();
  const cards = page.locator('#options-queue .options-queue-card');
  await expect(cards).toHaveCount(6, { timeout: 30000 });
  const names = await cards.evaluateAll((list) => list.map((card) => (card.innerText.match(/Ana Carro|Bia Sem Carro|Caio Atualizar|Duda Falta|Eva V1|Fabio Sem Pedido/) || ['?'])[0]));
  expect(names).toEqual(NAMES);
  const card = (name) => cards.filter({ hasText: name });
  await expect(page.locator('.options-queue-list-head')).toHaveText(/Cliente.*Telefone.*Ref.*Pedido.*Opções.*Prazo.*Estado.*Ação/);
  const options = (name) => card(name).locator('.options-queue-options');
  await expect(options('Ana Carro')).toHaveText('2');
  await expect(options('Bia Sem Carro')).toHaveText('Sem resultado');
  await expect(options('Caio Atualizar')).toHaveText('Não comparado');
  await expect(options('Duda Falta')).toHaveText('Busca não feita');
  await expect(options('Eva V1')).toHaveText('1');
  await expect(options('Fabio Sem Pedido')).toHaveText('Busca não feita');
  await expect(card('Ana Carro').locator('.options-queue-demand')).toContainText('Por carro · Honda CR-V · 2019 a 2022');
  await expect(card('Ana Carro').locator('.options-queue-state')).toHaveText('FL');
  await expect(card('Ana Carro').getByRole('button', { name: 'Ver opções' })).toBeVisible();
  await expect(page.locator('#options-queue-count')).toHaveText('6 na fila · toque na linha para ver as opções do cliente');
  // The tab still counts who has cars and is waiting for the V1.
  await expect(page.locator('.tab[data-view="searches"] [data-count]')).toHaveText('1');
  // "Ref mais recentes": the newest Ref first, whatever the last message.
  await page.locator('#options-queue-sort').selectOption('ref_recent');
  const byRef = await cards.evaluateAll((list) => list.map((card) => (card.innerText.match(/Ana Carro|Bia Sem Carro|Caio Atualizar|Duda Falta|Eva V1|Fabio Sem Pedido/) || ['?'])[0]));
  expect(byRef).toEqual(NAMES.slice().reverse());
  // Atualizar (one chip per request not compared): compares that request again, without opening the ficha.
  await card('Caio Atualizar').getByRole('button', { name: 'Atualizar' }).click();
  await expect.poll(() => posts.map((p) => p.action + ':' + p.key).join()).toBe(`rematch:journey:${id(3)}:CARRO`);
  await expect(page.locator('#detail-panel')).toBeHidden();
  expect(errors).toEqual([]);
});

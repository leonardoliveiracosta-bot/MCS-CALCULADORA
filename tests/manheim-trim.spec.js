'use strict';

// ENVIAR OPÇÕES · tela "Opções do cliente": filtro por TRIM numa aba (grupo), no navegador real, com os
// handlers reais contra um banco PGlite. Marcar um trim reduz a lista e a contagem da aba; o selecionado
// fora do filtro continua no contador de selecionados e aparece em "X selecionados fora do filtro"; o
// filtro volta depois de recarregar; no celular o campo cabe na largura. Nada sai da máquina.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-trim.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { openOptionsScreen } = require('./abrir-ficha-opcoes');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.LOTE_SHOTS || '';
test.setTimeout(120000);

const id = (n) => `6c700000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOURNEY = id(10), CONTACT = id(11);
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Trim','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', trim: 'Plug in hybrid, Ultra or plus', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','trimtela-1','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'t1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');
const TRIMS = ['EX', 'EX-L', 'ex l', 'Touring', ''];
const car = (n) => {
  const vin = 'TRIM' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2019 + (n % 4), make: 'Honda', model: 'CR-V', trim: TRIMS[n % TRIMS.length], miles: 20000 + n, mmrCents: 2500000 + n * 1000, location: 'FL - Orlando', startsAt: '2099-10-01T15:00:00Z', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: '4.0', cleanTitle: true, odometerOk: true } };
};
// 60 cars in Lane/Run: EX 12, EX-L 24 (two spellings), Touring 12, no trim 12. The screen shows 25 per page,
// so the whole group and a two-trim filter (36) have a second page, and EX-L alone (24) fits in one.
const cars = Array.from({ length: 60 }, (_, n) => car(n));
// The car's line opens the car itself (price, select, remove…) under it.
async function openCar(item) {
  if (await item.locator('.oc-detail').isHidden()) await item.locator('.oc-car').click();
  await expect(item.locator('.oc-detail')).toBeVisible();
}
let backend, handlers;
async function run(handler, request) {
  const url = new URL(request.url());
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  await handler({ method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined }, res);
  return res;
}
const direct = async (name, body) => { const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} }; await require('../api/panel/' + name)({ method: 'POST', url: '/api/panel/' + name, headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res); return res; };

test.beforeAll(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ name: 'TELA.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await direct('manheim-batch', { action: 'start', clientKey: 'f'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  await direct('manheim-batch', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await direct('manheim-batch', { action: 'finalize', uploadId: started.payload.uploadId });
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'lead', 'client-context'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

async function openPanel(page, optionPages = []) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) {
      const res = await run(handlers[url.pathname], request);
      if (url.pathname === '/api/panel/manheim-options' && request.method() === 'GET') optionPages.push((res.payload.options || []).length);
      return json(res.payload, res.statusCode);
    }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
}

test('trim: marcar reduz lista e contagem, selecionado fora do filtro continua contado, filtro volta ao recarregar', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  const screen = await openOptionsScreen(page, { mode: 'CARRO' });
  const tab = screen.locator('.oc-tab[data-group="LANE"]');
  await expect(tab).toHaveText(/\(60\)$/, { timeout: 60000 });
  await tab.click();
  const rows = screen.locator('.oc-list .oc-item');
  await expect(rows).toHaveCount(25);
  await expect(screen.locator('.offer-trim-asked')).toHaveText('Cliente pediu: Plug in hybrid, Ultra or plus');
  // Nothing checked by itself; the options are the trims of the group, with counts.
  await screen.locator('.oc-trim > summary').click();
  const options = screen.locator('.offer-trim-option');
  await expect(options).toHaveText(['EX-L (24)', 'EX (12)', 'Touring (12)', 'Sem trim (12)']);
  await expect(screen.locator('.offer-trim-option input:checked')).toHaveCount(0);
  // Select a Touring car, then filter by EX-L.
  await screen.locator('.oc-sort').selectOption('year_desc');
  const touring = rows.filter({ hasText: 'Touring' }).first();
  await openCar(touring);
  await touring.locator('[data-offer-action="select"]:visible').click();
  await expect(touring.locator('.offer-row')).toHaveAttribute('data-status', 'SELECTED');
  await expect(screen.locator('.oc-act .oc-count')).toContainText('1 de 10');
  await options.filter({ hasText: 'EX-L (24)' }).locator('input').check();
  await expect(tab).toHaveText(/\(24 de 60\)$/);
  await expect(rows).toHaveCount(24);
  await expect(screen.locator('.oc-more-button')).toHaveCount(0);
  const trims = await rows.locator('.oc-car .oc-l1').allTextContents();
  expect(trims.every((text) => /EX-L|ex l/i.test(text)), trims.join(' | ')).toBe(true);
  await expect(screen.locator('.oc-act .oc-count')).toContainText('1 de 10');
  await expect(screen.locator('.offer-trim-outside')).toContainText('1 selecionado fora do filtro');
  // Two trims: EX-L + no trim.
  await options.filter({ hasText: 'Sem trim (12)' }).locator('input').check();
  await expect(tab).toHaveText(/\(36 de 60\)$/);
  await expect(screen.locator('.oc-more')).toHaveText('+ 11 carros · Ver mais');
  await screen.locator('.oc-more-button').click();
  await expect(rows).toHaveCount(36);
  // The filter survives a reload; "Limpar filtro" shows everything again.
  await page.reload({ waitUntil: 'domcontentloaded' });
  const again = await openOptionsScreen(page, { mode: 'CARRO' });
  const againTab = again.locator('.oc-tab[data-group="LANE"]');
  await againTab.click({ timeout: 60000 });
  await expect(againTab).toHaveText(/\(36 de 60\)$/);
  await expect(again.locator('.oc-trim > summary')).toHaveText('Trim (2)');
  await again.locator('.offer-trim-outside button', { hasText: 'Limpar filtro' }).click();
  await expect(againTab).toHaveText(/\(60\)$/);
  await expect(again.locator('.oc-list .oc-item')).toHaveCount(25);
  const { rows: [{ n }] } = await backend.db.query(`select count(*)::int n from public.manheim_option_selections where status='SELECTED'`);
  expect(n, 'o filtro nunca muda a seleção').toBe(1);
  expect(errors).toEqual([]);
  expect(backend.refused).toEqual([]);
});

test('celular: Ordenar e Trim cabem na largura, sem rolagem lateral', async ({ page }) => {
  await openPanel(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  const screen = await openOptionsScreen(page, { mode: 'CARRO' });
  await screen.locator('.oc-tab[data-group="LANE"]').click({ timeout: 60000 });
  await expect(screen.locator('.oc-list .oc-row').first()).toBeVisible();
  await screen.locator('.oc-trim > summary').click();
  await expect(screen.locator('.offer-trim-option').first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const box = await screen.locator('.oc-trim > summary').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  const sort = await screen.locator('.oc-sort').boundingBox();
  expect(sort.x + sort.width).toBeLessThanOrEqual(390);
});

test('cartão da fila: só abre com apertar e soltar no mesmo lugar livre; dentro da tela de opções o trim não navega', async ({ page }) => {
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  const queueCard = page.locator('#options-queue .options-queue-card[data-mode~="CARRO"]').first();
  await expect(queueCard).toBeVisible({ timeout: 60000 });
  // Press on the line, the queue is redrawn under the finger (the pressed cell is gone), the release lands on the line:
  // no ficha and no options screen.
  await queueCard.evaluate((card) => {
    const cell = card.querySelector('.options-queue-demand');
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    cell.remove();
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(500);
  await expect(page.locator('#detail-panel')).toBeHidden();
  await expect(page.locator('#options-client')).toBeHidden();
  await expect(page.locator('#options-queue')).toBeVisible();
  // A plain press and release on the card opens the client's options screen (where the trim lives).
  await queueCard.evaluate((card) => {
    card.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  const screen = page.locator('#options-client');
  await expect(screen.locator('.oc-bar')).toBeVisible({ timeout: 30000 });
  await expect(screen).toHaveAttribute('data-mode', 'CARRO');
  // Inside the screen the trim and the tabs never navigate: the same screen stays open.
  const url = page.url();
  const tab = screen.locator('.oc-tab[data-group="LANE"]');
  await expect(tab).toHaveText(/\(60\)$/, { timeout: 60000 });
  await tab.click();
  await expect(screen.locator('.oc-list .oc-item')).toHaveCount(25);
  await screen.locator('.oc-trim > summary').click();
  await screen.locator('.offer-trim-option input').first().check();
  await page.waitForTimeout(500);
  expect(page.url()).toBe(url);
  await expect(screen).toBeVisible();
  await expect(page.locator('#detail-panel')).toBeHidden();
});

test('selecionados: lista no pedido, remover um e remover todos, e as linhas abertas acompanham', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await page.addInitScript(() => localStorage.removeItem('mcs-buscas-trims'));
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  const card = await openOptionsScreen(page, { mode: 'CARRO' });
  const tab = card.locator('.oc-tab[data-group="LANE"]');
  await tab.click({ timeout: 60000 });
  const items = card.locator('.oc-list .oc-item');
  const rows = card.locator('.oc-list .offer-row');
  await expect(rows).toHaveCount(25);
  // Clean start: whatever an earlier test selected is removed first.
  await backend.db.query(`update public.manheim_option_selections set status='AVAILABLE' where status='SELECTED'`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openOptionsScreen(page, { mode: 'CARRO' });
  await tab.click({ timeout: 60000 });
  await expect(rows).toHaveCount(25);
  for (const index of [0, 1, 2]) { await openCar(items.nth(index)); await rows.nth(index).locator('[data-offer-action="select"]:visible').click(); await expect(rows.nth(index)).toHaveAttribute('data-status', 'SELECTED'); }
  // The selected list opens from the counter of the fixed bar.
  const picked = card.locator('.offer-picked');
  await expect(picked).toBeHidden();
  await card.locator('.oc-act .oc-count').click();
  await expect(picked.locator('> summary')).toHaveText('Selecionados para o cliente (3)');
  await expect(picked.locator('.offer-picked-row')).toHaveCount(3);
  await picked.locator('.offer-picked-row').first().getByRole('button', { name: 'Remover' }).click();
  await expect(picked.locator('> summary')).toHaveText('Selecionados para o cliente (2)');
  await expect(rows.nth(0)).toHaveAttribute('data-status', 'AVAILABLE');
  await expect(items.nth(0).locator('.oc-row input[type="checkbox"]')).not.toBeChecked();
  const all = picked.locator('.offer-picked-all');
  await all.click();
  await expect(all).toHaveText('Confirmar: remover os 2 selecionados');
  await all.click();
  await expect(picked).toBeHidden();
  await expect(rows.nth(1)).toHaveAttribute('data-status', 'AVAILABLE');
  await expect(rows.nth(2)).toHaveAttribute('data-status', 'AVAILABLE');
  for (const index of [1, 2]) await expect(items.nth(index).locator('.oc-row input[type="checkbox"]')).not.toBeChecked();
  await expect(card.locator('.oc-act .oc-count')).toContainText('0 de 10');
  const { rows: [{ n }] } = await backend.db.query(`select count(*)::int n from public.manheim_option_selections where status='SELECTED'`);
  expect(n).toBe(0);
  expect(errors).toEqual([]);
});

'use strict';

// AUD-001 C3 (fluxo de venda): seleção e preço em ENVIAR OPÇÕES, com o mesmo cenário do teste do filtro por TRIM, no navegador real, com os handlers reais contra um banco PGlite.
// Marcar um trim reduz a lista e a contagem do título; o selecionado fora do filtro continua no
// contador de selecionados e aparece em "X selecionados fora do filtro"; o filtro volta depois de
// recarregar; no celular o campo cabe na largura. Nada sai da máquina.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-trim.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
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
// 25 cars in Lane/Run: EX 5, EX-L 10 (two spellings), Touring 5, no trim 5.
const cars = Array.from({ length: 25 }, (_, n) => car(n));
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


test('AUD-001 #57: seleção continua depois de reordenar o grupo (não volta ao retrato antigo)', async ({ page }) => {
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  // The options live in the ficha now: open it from the queue card (the client's screen, then the full ficha).
  await page.locator('#options-queue .options-queue-card').first().locator('.identity-name').click();
  await page.locator('#options-client').getByRole('button', { name: 'Abrir ficha completa' }).click();
  const card = () => page.locator('#detail-panel .ficha-demand').first();
  const group = () => card().locator('.offer-group[data-group="LANE"]');
  await expect(group().locator('> summary')).toHaveText(/\(25\)$/, { timeout: 60000 });
  await group().locator('> summary').click();
  const row = group().locator('.offer-row').first();
  await row.locator('[data-offer-action="select"]:visible').click();
  await expect(row).toHaveAttribute('data-status', 'SELECTED');
  await expect(card().locator('.offer-counter')).toContainText('1 de 10');
  // Reorder the group: the list is drawn again from the snapshot of the page.
  await group().locator('.offer-sort-select').selectOption({ index: 1 });
  await expect(card().locator('.offer-counter')).toContainText('1 de 10');
  await group().locator('.offer-sort-select').selectOption({ index: 0 });
  await expect(card().locator('.offer-counter')).toContainText('1 de 10');
});

test('AUD-001 #61: valor em dólar digitado e Selecionar logo em seguida grava o valor digitado', async ({ page }) => {
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  // The options live in the ficha now: open it from the queue card (the client's screen, then the full ficha).
  await page.locator('#options-queue .options-queue-card').first().locator('.identity-name').click();
  await page.locator('#options-client').getByRole('button', { name: 'Abrir ficha completa' }).click();
  const card = page.locator('#detail-panel .ficha-demand').first();
  const group = card.locator('.offer-group[data-group="LANE"]');
  await expect(group.locator('> summary')).toHaveText(/\(25\)$/, { timeout: 60000 });
  await group.locator('> summary').click();
  const row = group.locator('.offer-row').nth(2);
  const input = row.locator('.offer-final-label input');
  const current = Number((await input.inputValue()).replace(/\D/g, ''));
  const typed = current + 100; // one dollar more: not reachable by a percentage with two decimals
  // The select request arrives after the save of the typed value (the order of a slow network).
  await page.route('**/api/panel/manheim-options', async (route) => {
    const body = route.request().postData() || '';
    if (route.request().method() === 'POST' && body.includes('"action":"select"')) await new Promise((done) => setTimeout(done, 1500));
    return route.fallback();
  });
  await input.fill((typed / 100).toFixed(0));
  await row.locator('[data-offer-action="select"]:visible').click();
  await expect(row).toHaveAttribute('data-status', 'SELECTED');
  await page.waitForTimeout(2500);
  const { rows } = await backend.db.query(`select final_cents from public.manheim_option_selections where status='SELECTED' order by updated_at desc limit 1`);
  expect(Number(rows[0].final_cents), 'valor gravado = valor digitado').toBe(typed);
});

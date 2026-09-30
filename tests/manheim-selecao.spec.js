'use strict';

// BUSCAS com a seleção para o cliente, no navegador real, com os handlers reais contra um banco
// PGlite: três grupos por demanda, 10 carros por vez (nunca todos), selecionar três, contador
// "Selecionados 3 de 10" e percentual ajustado mudando o valor na hora. Depois, o complemento do
// lote ativo pelo botão: conta, pede confirmação e reagrupa. Nada sai da máquina.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-selecao.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.LOTE_SHOTS || '';
test.setTimeout(120000);

const id = (n) => `6c500000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOURNEY = id(10), CONTACT = id(11);
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Cliente Tela','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','tela-1','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'t1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');
const car = (n, extra = {}) => {
  const vin = 'TELA' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', startsAt: '2026-10-01T15:00:00Z', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: (4.9 - n * 0.2).toFixed(1), cleanTitle: true, odometerOk: true, ...extra } };
};
// 14 in Lane/Run, one in Lane/Run WITH Buy Now Price and one without CR (both stay in Lane/Run), one
// without Lane/Run and with Buy Now (outside Lane/Run), two without Lane/Run nor Buy Now (incomplete).
const cars = [...Array.from({ length: 14 }, (_, n) => car(n)), car(30, { buyNowPrice: '26500' }), car(32, { conditionGrade: '' }), car(33, { lane: '', run: '', buyNowPrice: '26500' }), car(31, { lane: '', run: '' }), car(34, { lane: '', run: '' })];

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
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
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

test('três grupos, seleção com contador 3 de 10 e percentual mudando o valor, sem carregar todos', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const optionPages = [];
  await openPanel(page, optionPages);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  const card = page.locator('#buscas-carro .manheim-lead').first();
  await expect(card.locator('.offer-counter')).toContainText('16 passam em Lane/Run · 1 Buy Now / Make Offer / fora de Lane-Run · 2 incompletos · Selecionados 0 de 10', { timeout: 60000 });
  await expect(card.locator('.offer-group')).toHaveCount(3);
  await expect(card.locator('.offer-group[data-group="LANE"] > summary')).toHaveText('Passa em Lane/Run (16)');
  await expect(card.locator('.offer-group[data-group="OFFLANE"] > summary')).toHaveText('Buy Now / Make Offer / fora de Lane-Run (1)');
  await expect(card.locator('.offer-group[data-group="INCOMPLETE"] > summary')).toHaveText('Informação incompleta (2)');
  expect(optionPages, 'nenhum carro antes de abrir um grupo').toEqual([]);
  // Opening the group loads 10 of 16, never all of them.
  await card.locator('.offer-group[data-group="LANE"] > summary').click();
  const lane = card.locator('.offer-group[data-group="LANE"] .offer-row');
  await expect(lane).toHaveCount(10);
  expect(optionPages).toEqual([10]);
  // Select three.
  for (let index = 0; index < 3; index += 1) {
    await lane.nth(index).locator('[data-offer-action="select"]:visible').click();
    await expect(lane.nth(index)).toHaveAttribute('data-status', 'SELECTED');
  }
  await expect(card.locator('.offer-counter')).toContainText('Selecionados 3 de 10');
  // US$ 25.000 MMR: 5% by default (US$ 26.250); the operator types 8% and the value changes at once.
  const fourth = lane.nth(3);
  await expect(fourth.locator('.offer-final')).toHaveText(/26\.250,00/);
  await fourth.locator('.offer-pct').fill('8');
  await expect(fourth.locator('.offer-final')).toHaveText(/27\.000,00/);
  await fourth.locator('.offer-pct').dispatchEvent('change');
  await expect.poll(async () => (await backend.db.query(`select manual_pct::float from public.manheim_option_selections where final_cents = 2700000`)).rows.length).toBe(1);
  // Outside Lane/Run only with a reason.
  await card.locator('.offer-group[data-group="OFFLANE"] > summary').click();
  const offLane = card.locator('.offer-group[data-group="OFFLANE"] .offer-row').first();
  await expect(offLane.locator('[data-offer-action="select"]:visible')).toHaveText('Incluir manualmente');
  if (SHOTS) await card.screenshot({ path: path.join(SHOTS, 'selecao-buscas-1366.png') });
  const { rows: [{ n }] } = await backend.db.query(`select count(*)::int n from public.manheim_option_selections where status='SELECTED'`);
  expect(n).toBe(3);
  expect(errors).toEqual([]);
  expect(backend.refused).toEqual([]);
});

// The same CSV the active batch was imported from, as the real batch (no sale fields stored). The
// batch is built with the panel's own reader, so the browser reads the file exactly the same way.
const CSV_HEADERS = ['Inventory', 'Vin', 'Year', 'Make', 'Model', 'Trim', 'Odometer Value', 'MMR', 'Condition Report Grade', 'Pickup Location', 'Starts At', 'Lane', 'Run', 'Buy Now Price', 'Event Sale Name', 'Status'];
const CSV_ROWS = [
  ['OVE', '2HKRW2H59LH600001', '2020', 'Honda', 'CR-V', 'EX', '21000', '25000', '4.1', 'FL - Orlando', '2026-10-01T15:00:00Z', '', '', '', '', 'Active'],
  ['Simulcast', '2HKRW2H59LH600001', '2020', 'Honda', 'CR-V', 'EX', '21000', '25000', '4.1', 'FL - Orlando', '2026-10-01T15:00:00Z', '3', '41', '26500', 'Orlando Tuesday', 'Active'],
  ['Simulcast', '2HKRW2H59LH600002', '2020', 'Honda', 'CR-V', 'EX', '22000', '25000', '4.0', 'FL - Orlando', '2026-10-01T15:00:00Z', '4', '12', '', 'Orlando Tuesday', 'Active'],
  ['Simulcast', '2HKRW2H59LH600003', '2020', 'Honda', 'CR-V', 'EX', '23000', '25000', '3.9', 'FL - Orlando', '2026-10-01T15:00:00Z', '5', '7', '', 'Orlando Tuesday', 'Active'],
  ['OVE', '2HKRW2H59LH600004', '2020', 'Honda', 'CR-V', 'EX', '24000', '25000', '3.8', 'FL - Orlando', '2026-10-01T15:00:00Z', '', '', '27000', 'Buy Now / Make Offer', 'Active'],
  ['OVE', '2HKRW2H59LH600005', '2020', 'Honda', 'CR-V', 'EX', '25000', '25000', '3.7', 'FL - Orlando', '2026-10-01T15:00:00Z', '', '', '28000', '', 'Active'],
  ['OVE', '2HKRW2H59LH600006', '2020', 'Honda', 'CR-V', 'EX', '26000', '25000', '3.6', 'FL - Orlando', '2026-10-01T15:00:00Z', '', '', '', '', 'Active'],
  ['Simulcast', '1FTEW1EP5LK000007', '2020', 'Ford', 'F-150', 'XLT', '30000', '30000', '4.0', 'FL - Orlando', '2026-10-01T15:00:00Z', '1', '1', '', 'Orlando Tuesday', 'Active']
];
const CSV_TEXT = [CSV_HEADERS, ...CSV_ROWS].map((row) => row.join(',')).join('\n') + '\n';

test('complementar dados do lote ativo: conta, confirma e reagrupa sem novo lote nem match', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const legacy = await require('./fixtures/manheim-csv').importLegacy((body) => direct('manheim-batch', body), [{ name: 'COMPLEMENTO.csv', text: CSV_TEXT }]);
  expect(legacy.vehicleCount).toBe(7);
  const q = async (sql) => (await backend.db.query(sql)).rows[0];
  const before = await q(`select (select count(*) from public.manheim_uploads)::int uploads, (select count(*) from public.manheim_matches)::int matches, (select count(*) from public.manheim_vehicles)::int vehicles`);
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  const card = page.locator('#buscas-carro .manheim-lead').first();
  await expect(card.locator('.offer-counter')).toContainText('0 passam em Lane/Run · 0 Buy Now / Make Offer / fora de Lane-Run · 6 incompletos', { timeout: 60000 });
  const button = page.locator('#manheim-complement');
  await expect(button).toHaveText('Complementar dados do lote ativo');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles({ name: 'COMPLEMENTO.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV_TEXT) });
  const status = page.locator('#manheim-complement-status');
  const confirm = page.locator('.inline-confirm');
  await expect(confirm).toContainText('7 carros do lote ativo conferidos com o manifesto. 7 vão receber Lane, Run, Inventory, Status e Event Sale Name: 4 com Lane/Run, 2 Buy Now / Make Offer, 1 ainda incompletos');
  expect((await q(`select count(*)::int n from public.manheim_sale_info`)).n, 'nada gravado antes da confirmação').toBe(0);
  if (SHOTS) await page.locator('#searches-panel > section.card').first().screenshot({ path: path.join(SHOTS, 'complemento-confirmacao.png') });
  await confirm.getByRole('button', { name: 'Complementar agora' }).click();
  await expect(status).toHaveText('Complemento concluído · 7 carros · 4 com Lane/Run · 2 Buy Now / Make Offer · 1 ainda incompletos', { timeout: 30000 });
  await expect(card.locator('.offer-counter')).toContainText('3 passam em Lane/Run · 2 Buy Now / Make Offer / fora de Lane-Run · 1 incompletos', { timeout: 30000 });
  if (SHOTS) await page.locator('#searches-panel').screenshot({ path: path.join(SHOTS, 'complemento-concluido.png') });
  const after = await q(`select (select count(*) from public.manheim_uploads)::int uploads, (select count(*) from public.manheim_matches)::int matches, (select count(*) from public.manheim_vehicles)::int vehicles`);
  expect(after).toEqual(before);
  expect(errors).toEqual([]);
  expect(backend.refused).toEqual([]);
});

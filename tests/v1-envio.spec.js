'use strict';

// BUSCAS no navegador real, handlers reais contra um banco PGlite: gerar a V1, "Enviar no WhatsApp"
// com confirmação (texto editável) e o 360dialog SIMULADO (fora de produção nenhum envio é real), e o
// histórico de lotes recolhido com "Ocultar da lista". Nada sai da máquina.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/v1-envio.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { openOptionsScreen } = require('./abrir-ficha-opcoes');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.LOTE_SHOTS || '';
test.setTimeout(120000);

const id = (n) => `6c800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOURNEY = id(10), CONTACT = id(11);
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${CONTACT}','preview','Maria Tela','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${CONTACT}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`,
  `insert into public.contact_phones(environment,contact_id,phone_raw,phone_e164,is_current,created_at) values('preview','${CONTACT}','+13055550199','+13055550199',true,now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${CONTACT}','wa:+13055550199','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'t1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');
const car = (n, extra = {}) => {
  const vin = 'ENVI' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', startsAt: '2099-10-01T15:00:00Z', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: (4.9 - n * 0.2).toFixed(1), cleanTitle: true, odometerOk: true, ...extra } };
};
// 14 in Lane/Run, one in Lane/Run WITH Buy Now Price and one without CR (both stay in Lane/Run), one
// without Lane/Run and with Buy Now (outside Lane/Run), two without Lane/Run nor Buy Now (incomplete).
const cars = Array.from({ length: 4 }, (_, n) => car(n));

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
  // An older batch, already undone: it goes to the collapsed history.
  const old = [car(90)];
  const oldFiles = [{ name: 'ANTIGO.csv', size: 1, rowCount: 1, vehicleCount: 1, chunkCount: 1, chunks: [{ count: 1, hash: contentHash(old) }] }];
  const oldStart = await direct('manheim-batch', { action: 'start', clientKey: 'b'.repeat(32), vehicleCount: 1, files: oldFiles, manifestHash: contentHash(oldFiles), headers: [['Vin']], headerMap: {} });
  await direct('manheim-batch', { action: 'chunk', uploadId: oldStart.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: old });
  await direct('manheim-batch', { action: 'finalize', uploadId: oldStart.payload.uploadId });
  await backend.db.exec(`update public.manheim_uploads set undone_at = now() - interval '1 day', uploaded_at = now() - interval '2 days' where id = '${oldStart.payload.uploadId}'`);
  const files = [{ name: 'TELA.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await direct('manheim-batch', { action: 'start', clientKey: 'f'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  await direct('manheim-batch', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await direct('manheim-batch', { action: 'finalize', uploadId: started.payload.uploadId });
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'v1-send'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

test('exemplo fictício do Preview: confirmação completa, clique duplo barrado e fora da janela de 24 h, sem banco', async ({ page }) => {
  const before = (await backend.db.query('select (select count(*) from public.v1_sends)::int sends, (select count(*) from public.vitrines)::int vitrines')).rows[0];
  const posts = [];
  // Only the POSTs (the GET of the latest V1 of the cards on screen only reads).
  page.on('request', (request) => { if (request.url().includes('/api/panel/v1-send') && request.method() === 'POST') posts.push(JSON.parse(request.postData() || '{}').action); });
  await openPanel(page);
  await page.goto(base + '/painel/');
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-view="searches"]').click();
  const demo = page.locator('#v1-demo');
  await expect(demo).toContainText('EXEMPLO FICTÍCIO');
  await expect(demo).toContainText('Nada é gravado no banco nem enviado ao WhatsApp');
  const open = demo.locator('.v1-demo-card').nth(0), closed = demo.locator('.v1-demo-card').nth(1);
  await expect(open.locator('.v1-send-state')).toHaveText(/^Para Cliente Fictício \(teste\) · \+15550100100 · envio simulado neste ambiente · Janela de 24 h aberta/);
  // The approved message appears once, editable, with the link; the confirmation repeats whom and the text.
  await expect(open.locator('.v1-send-text')).toHaveValue(/^Hi Cliente,\n\nI put together a first look/);
  await open.locator('.v1-send-go').click();
  const box = open.locator('.v1-send-confirm');
  await expect(box).toContainText('Enviar para Cliente Fictício (teste) · +15550100100');
  await expect(box).toContainText('/v/EXEMPLO-FICTICIO-NAO-E-CLIENTE');
  await expect(box.locator('.v1-send-preview')).toContainText('I put together a first look');
  const confirm = box.getByRole('button', { name: 'Confirmar envio' });
  await confirm.dblclick();
  await expect(open.locator('.v1-send-state')).toHaveText(/^Enviado às \d\d:\d\d · simulado$/, { timeout: 10000 });
  expect(posts.filter((action) => action === 'demo_send')).toHaveLength(1);
  // Outside the 24-hour window: no panel send is offered; WhatsApp on the phone opens with the text ready.
  await expect(closed.locator('.v1-send-state')).toContainText('Janela de 24 h encerrada');
  await expect(closed.locator('.v1-send-go')).toBeHidden();
  await expect(closed.locator('.v1-send-fallback')).toHaveAttribute('href', /^https:\/\/wa\.me\/15550100100\?text=Hi%20Cliente/);
  expect(posts.every((action) => action.startsWith('demo_') || !action)).toBe(true);
  const after = (await backend.db.query('select (select count(*) from public.v1_sends)::int sends, (select count(*) from public.vitrines)::int vitrines')).rows[0];
  expect(after).toEqual(before);
  if (SHOTS) await demo.screenshot({ path: path.join(SHOTS, 'v1-exemplo-ficticio.png') });
});

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

test('V1 pelas Opções do cliente abre o WhatsApp com a mensagem e o link (nada enviado pelo painel) e histórico de lotes recolhido', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="imports"]').click();
  // History: the active batch in view, the undone one inside a collapsed "Histórico de lotes".
  const batches = page.locator('#manheim-batches');
  await expect(batches.locator(':scope > .batch-line')).toHaveCount(1, { timeout: 60000 });
  await expect(batches.locator(':scope > .batch-line')).toContainText('Ativo · em uso');
  const history = batches.locator('.batch-history');
  await expect(history.locator(':scope > summary')).toHaveText('Histórico de lotes (1)');
  await expect(history).not.toHaveAttribute('open', '');
  await history.locator(':scope > summary').click();
  if (SHOTS) await batches.screenshot({ path: path.join(SHOTS, 'historico-lotes-aberto.png') });
  await history.locator('[data-batch-visibility="hide"]').click();
  await expect(batches.locator('.batch-history > summary')).toHaveText('Histórico de lotes (0)');
  await expect(batches.locator('.batch-hidden > summary')).toHaveText('Ver lotes ocultos (1)');
  if (SHOTS) await batches.screenshot({ path: path.join(SHOTS, 'historico-lotes-oculto.png') });

  // V1 (#218): in the client's options screen, select two cars (the box of the line) and "Gerar V1 e abrir
  // no WhatsApp" creates the V1 and opens the conversation with the approved message and the link. Nothing
  // is sent by the panel.
  await page.evaluate(() => { window.__opened = []; window.open = (href) => { window.__opened.push(String(href)); return null; }; });
  const card = await openOptionsScreen(page, { mode: 'CARRO' });
  await expect(card.locator('.oc-bar .oc-tab.on')).toHaveAttribute('data-group', 'LANE');
  const lane = card.locator('.oc-list .oc-item');
  for (let index = 0; index < 2; index += 1) {
    await lane.nth(index).locator('.oc-row input[type="checkbox"]').check();
    await expect(lane.nth(index).locator('.offer-row')).toHaveAttribute('data-status', 'SELECTED');
  }
  const foot = card.locator('.oc-act');
  await foot.getByRole('button', { name: 'Gerar V1 e abrir no WhatsApp' }).click();
  await expect(foot.locator('.ficha-v1-status')).toHaveText('WhatsApp aberto com a mensagem · O envio é feito por você no WhatsApp', { timeout: 30000 });
  if (SHOTS) await foot.screenshot({ path: path.join(SHOTS, 'v1-ficha-whatsapp.png') });
  const opened = await page.evaluate(() => window.__opened);
  expect(opened.length).toBe(1);
  const url = new URL(opened[0]);
  // On the computer the conversation opens in WhatsApp Web (wa.me on the phone); the number is the client's.
  expect(url.origin + url.pathname).toBe('https://web.whatsapp.com/send');
  expect(url.searchParams.get('phone')).toBe('13055550199');
  const text = url.searchParams.get('text');
  expect(text).toMatch(/^Hi Maria,\n\nI reviewed the current auction listings/);
  expect(text).toContain(base + '/v/');
  // One V1 with the two cars; nothing left the panel (no send row, no MCS message).
  const { rows: [vitrine] } = await backend.db.query(`select v.id, count(c.id)::int cars from public.vitrines v join public.vitrine_cars c on c.vitrine_id = v.id where v.journey_id = '${JOURNEY}' and v.version = 'V1' group by v.id`);
  expect(vitrine.cars).toBe(2);
  expect((await backend.db.query(`select count(*)::int n from public.v1_sends`)).rows[0].n).toBe(0);
  expect((await backend.db.query(`select count(*)::int n from public.messages where direction = 'MCS'`)).rows[0].n).toBe(0);
  expect(errors).toEqual([]);
  expect(backend.refused).toEqual([]);
});

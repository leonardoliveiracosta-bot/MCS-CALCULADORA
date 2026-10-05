'use strict';

// As três telas no navegador real, handlers reais contra um banco PGlite: PESQUISAS (pedidos com
// estado e evidências, leitura simulada das conversas), OPÇÕES (cartões por cliente) e IMPORTAÇÕES
// (arquivos e lotes), em 1366 e 390 px. Nada sai da máquina e nenhuma IA é chamada.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/pesquisas.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.LOTE_SHOTS || '';
test.setTimeout(120000);

const id = (n) => `6cb00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const conversation = (n, name, texts) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(10 + n)}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(30 + n)}','preview','WHATSAPP','${id(10 + n)}','wa:+1305556${String(n).padStart(4, '0')}','RESOLVED',false,now(),now(),now(),now());`,
  ...texts.map((text, index) => `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(100 + n * 10 + index)}','preview','${id(30 + n)}','WHATSAPP','CUSTOMER','${text}','x',now() - interval '${10 - index} days','v${n}${index}',1,'WHATSAPP_WEBHOOK',now());`)
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  // A ficha with criteria (the current demands) and read conversations.
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(9)}','preview','Marta Ficha','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(8)}','preview','${id(9)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(7)}','preview','WHATSAPP','${id(9)}','wa:+13055569999','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(6)}','preview','${id(7)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'mf',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(6)}','${id(8)}','IMPORT',now());`,
  ...conversation(1, 'Lucas Conversa', ['Hi, I am looking for a Honda CR-V 2019-2021 between 20,000 and 60,000 miles, up to $28,000', 'No rush, I plan to buy in 4 months']),
  ...conversation(2, 'Caio Conversa', ['Need a Ford F-150 2018-2020 with 30,000 to 90,000 miles']),
  ...conversation(3, 'Rafa Conversa', ['I want a Civic, budget $18,000']),
  ...conversation(4, 'Bia Conversa', ['Obrigado pelo retorno'])
].join('\n');
const car = (n) => ({ fingerprint: 'vin:TRES' + String(n).padStart(13, '0'), vehicle: { vin: 'TRES' + String(n).padStart(13, '0'), year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 30000 + n, mmrCents: 2500000, lane: '2', run: String(10 + n), saleType: 'Simulcast', conditionGrade: '4.1', cleanTitle: true, odometerOk: true } });
const cars = [car(1), car(2)];

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
  for (const key of ['OPENAI_API_KEY', 'SEARCH_EXTRACTION_AI_ENABLED', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'D360_API_KEY']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ name: 'TRES.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await direct('manheim-batch', { action: 'start', clientKey: 'd'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  await direct('manheim-batch', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await direct('manheim-batch', { action: 'finalize', uploadId: started.payload.uploadId });
  // Simulated reading of the conversations (no AI outside production).
  for (const n of [1, 2, 3, 4]) await direct('pesquisas', { action: 'extract', chatId: id(30 + n) });
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'v1-send', 'pesquisas'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

for (const width of [1366, 390]) {
  test(`${width} px · PESQUISAS, OPÇÕES e IMPORTAÇÕES separadas`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    await openPanel(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

    // PESQUISAS: only vehicle requests, no batch, no upload, no option cards.
    await page.locator('[data-view="requests"]').click();
    const list = page.locator('#requests-list');
    await expect(list.locator('.request-card').first()).toBeVisible({ timeout: 60000 });
    await page.locator('#requests-compare').click();
    await expect(page.locator('#requests-status')).toContainText('Leitura das conversas: simulada neste ambiente', { timeout: 30000 });
    await expect(list.locator('.request-card[data-state="COM_OPCOES"]').first()).toBeVisible({ timeout: 30000 });
    const lucas = list.locator('.request-card', { hasText: 'Lucas Conversa' });
    await expect(lucas).toContainText('Honda CR-V · 2019 a 2021 · 20,000 a 60,000 milhas · até US$ 28,000');
    await expect(lucas).toContainText(/opç(ão|ões) no lote/);
    await expect(page.locator('#requests-carro .request-card', { hasText: 'Lucas Conversa' })).toHaveCount(1);
    // (The quoted phrase of the conversation left the request card with "Evidências", comando 3; it is in the ficha.)
    // CARRO without a value is a search; model and value is VALOR.
    await expect(page.locator('#requests-carro .request-card', { hasText: 'Caio Conversa' })).toContainText('Resultado no lote: ATENDIMENTO MANUAL');
    await expect(page.locator('#requests-valor .request-card', { hasText: 'Rafa Conversa' })).toContainText('Resultado no lote: ATENDIMENTO MANUAL');
    // Ficha by year and mileage without a bid: ready, with options.
    await expect(list.locator('.request-card', { hasText: 'Marta Ficha' })).toContainText(/opç(ão|ões) no lote/);
    await expect(list).not.toContainText('Bia Conversa');
    await expect(page.locator('#requests-panel #manheim-drop-zone, #requests-panel .manheim-lead, #requests-panel #manheim-batches')).toHaveCount(0);
    await noOverflow();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `pesquisas-${width}.png`), fullPage: true });
    // Historical audit: one button, a confirmation on the page (never a browser dialog, which an
    // installed app can silently dismiss), visible progress (simulated here, no AI).
    page.on('dialog', (dialog) => { throw new Error('caixa do navegador não deve aparecer: ' + dialog.message()); });
    await page.locator('#requests-history').click();
    const confirmBox = page.locator('#requests-history-confirm');
    await expect(confirmBox).toBeVisible({ timeout: 30000 });
    for (const line of ['desde 09/08/2026', 'Não envia nenhuma mensagem', 'leitura simulada', 'pausar e continuar', 'US$ 50']) await expect(confirmBox).toContainText(line);
    await expect(page.locator('#requests-history-text')).not.toContainText('Lendo');
    await page.locator('#requests-history-go').click();
    await expect(page.locator('#requests-history-text')).toContainText('conversas processadas', { timeout: 30000 });
    await expect(page.locator('#requests-history-text')).toContainText('Auditoria concluída', { timeout: 60000 });
    await expect(confirmBox).toBeHidden();
    await page.locator('#requests-audit > summary').click();
    await expect(page.locator('#requests-audit-content')).toContainText('Ainda não há prova de que todo pedido de veículo foi atendido', { timeout: 30000 });

    // OPÇÕES: the cards per customer, no upload.
    await page.locator('[data-view="searches"]').click();
    await expect(page.locator('#options-queue .options-queue-card').first()).toBeVisible({ timeout: 60000 }); // fila (#218)
    await expect(page.locator('#manheim-drop-zone')).toBeHidden();
    await noOverflow();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `opcoes-${width}.png`), fullPage: true });

    // IMPORTAÇÕES: the files, the complement and the batches.
    await page.locator('[data-view="imports"]').click();
    await expect(page.locator('#manheim-drop-zone')).toBeVisible();
    await expect(page.locator('#manheim-complement')).toBeVisible();
    await expect(page.locator('#manheim-batches .batch-line').first()).toContainText('Ativo · em uso', { timeout: 60000 });
    await expect(page.locator('#imports-panel .options-queue-card')).toHaveCount(0);
    await noOverflow();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `importacoes-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    expect(backend.refused).toEqual([]);
  });
}
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


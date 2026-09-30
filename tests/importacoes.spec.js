'use strict';

// IMPORTAÇÕES como ponto central das entradas manuais, no navegador real, handlers reais contra um banco PGlite: PESQUISAS (pedidos com
// estado e evidências, leitura simulada das conversas), OPÇÕES (cartões por cliente) e IMPORTAÇÕES
// (arquivos e lotes), em 1366 e 390 px. Nada sai da máquina e nenhuma IA é chamada.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/importacoes.spec.js
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
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'v1-send', 'pesquisas', 'sms-print', 'vitrine-photos'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

for (const width of [1366, 390]) {
  test(`${width} px · IMPORTAÇÕES reúne as entradas manuais e cada cartão diz o que aceita e para onde vai`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => { errors.push('caixa do navegador: ' + dialog.message()); dialog.dismiss(); });
    await openPanel(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + '/painel/');
    await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    // Opened directly: the manual imports still get the contacts to choose from.
    await page.locator('[data-view="imports"]').click();
    const panel = page.locator('#imports-panel');
    for (const card of ['#import-card-manheim', '#auto-print-card', '#import-card-sms', '#import-card-whatsapp', '#import-card-history', '#import-card-automatic', '#import-card-v2']) await expect(panel.locator(card)).toBeVisible();
    for (const key of ['manheim', 'print', 'sms', 'whatsapp', 'history', 'automatic', 'v2']) expect(await panel.locator(`[data-import-facts="${key}"] li`).count(), key).toBeGreaterThan(1);
    await expect(panel.locator('#import-card-whatsapp #import-review-card')).toHaveCount(1);
    await expect(panel.locator('#manheim-files')).toHaveCount(1);
    await panel.locator('#import-card-sms summary').click();
    await expect.poll(() => page.locator('#sms-contact option').count(), { timeout: 30000 }).toBeGreaterThan(1);
    await expect(page.locator('#manheim-batches .batch-line').first()).toContainText('Ativo · em uso', { timeout: 60000 });
    await noOverflow();
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `importacoes-central-${width}.png`), fullPage: true });
    // ENTRADA keeps a way there; the automatic messages stay (they are a setting, not an import).
    await page.locator('[data-view="entry"]').click();
    await expect(page.locator('#entry-panel #auto-print-card, #entry-panel #sms-form, #entry-panel #whatsapp-files, #entry-panel #history-import-file')).toHaveCount(0);
    await expect(page.locator('#entry-panel #automatic-messages-card')).toHaveCount(1);
    await page.locator('#entry-go-imports').click();
    await expect(page.locator('#imports-panel')).toBeVisible();
    await noOverflow();
    expect(errors).toEqual([]);
    expect(backend.refused).toEqual([]);
  });
}
test('arrastar um print escolhe o arquivo como o seletor, sem enviar nada sozinho', async ({ page }) => {
  const posts = [];
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/')) posts.push(request.url()); });
  await openPanel(page);
  await page.goto(base + '/painel/');
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-view="imports"]').click();
  const drop = page.locator('#auto-print-card .print-drop');
  await expect(drop).toBeVisible();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const transfer = await page.evaluateHandle((data) => { const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); const t = new DataTransfer(); t.items.add(new File([bytes], 'print-sms.png', { type: 'image/png' })); return t; }, png);
  await drop.dispatchEvent('drop', { dataTransfer: transfer });
  await expect(page.locator('#auto-print-file-info')).toContainText('print-sms.png');
  await expect(page.locator('#auto-print-send')).toBeEnabled();
  expect(posts.filter((url) => url.includes('sms-print'))).toEqual([]);
  // Something that is not an image is refused with a clear message.
  const text = await page.evaluateHandle(() => { const t = new DataTransfer(); t.items.add(new File(['oi'], 'nota.txt', { type: 'text/plain' })); return t; });
  await drop.dispatchEvent('drop', { dataTransfer: text });
  await expect(page.locator('#auto-print-status')).toContainText('Solte uma imagem');
});

test('Cancelar em Confirmar conversa descarta só o arquivo, sem gravar nada', async ({ page }) => {
  const posts = [];
  page.on('request', (request) => { if (request.method() === 'POST' && request.url().includes('/api/panel/entry')) posts.push(request.postData() || ''); });
  await openPanel(page);
  await page.goto(base + '/painel/');
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-view="imports"]').click();
  const before = (await backend.db.query('select (select count(*)::int from public.messages) m, (select count(*)::int from public.contacts) c, (select count(*)::int from public.chats) ch')).rows[0];
  const chat = '29/09/2026 10:00 - Pessoa Nova: Oi, quero um carro\n29/09/2026 10:02 - Atendente MCS: Claro, qual modelo?\n';
  await page.locator('#whatsapp-files').setInputFiles({ name: 'WhatsApp Chat with Pessoa Nova.txt', mimeType: 'text/plain', buffer: Buffer.from(chat) });
  const review = page.locator('#import-card-whatsapp #import-review-card');
  await expect(review).toBeVisible({ timeout: 30000 });
  await page.locator('#import-review-cancel').click();
  await expect(review).toBeHidden();
  await expect(page.locator('#import-status')).toContainText('1 arquivo(s) cancelado(s), nada foi gravado');
  const after = (await backend.db.query('select (select count(*)::int from public.messages) m, (select count(*)::int from public.contacts) c, (select count(*)::int from public.chats) ch')).rows[0];
  expect(after).toEqual(before);
  expect(posts.filter((body) => /"action":"(start|batch|finish|review)"/.test(body))).toEqual([]);
});

test('prints não guardados esperam na ENTRADA: tentar ler de novo, guardar ou descartar', async ({ page }) => {
  const actor = (await backend.db.query('select id from public.panel_users limit 1')).rows[0].id;
  await backend.db.exec(`insert into public.sms_print_reads(id,environment,status,original_filename,mime_type,quarantine_path,extracted_json,error_code,created_at,updated_at,created_by) values
    ('7a000000-0000-4000-8000-000000000001','preview','READY','falhou.png','image/png','quarantine/preview/sms-print/x/falhou.png','{}','AI_UNAVAILABLE',now(),now(),'${actor}'),
    ('7a000000-0000-4000-8000-000000000002','preview','READY','lido.png','image/png','quarantine/preview/sms-print/y/lido.png','{"message":"Hi, Ref ABCD2","phone":""}',null,now() - interval '2 hours',now() - interval '2 hours','${actor}'),
    ('7a000000-0000-4000-8000-000000000003','preview','READY','agora.png','image/png','quarantine/preview/sms-print/z/agora.png','{"message":"oi"}',null,now(),now(),'${actor}')`);
  await openPanel(page);
  await page.goto(base + '/painel/');
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
  await page.locator('[data-view="entry"]').click();
  const cards = page.locator('#entry-queue .failed-print');
  await expect(cards).toHaveCount(2, { timeout: 30000 });
  const failed = cards.filter({ hasText: 'falhou.png' });
  await expect(failed).toContainText('Não consegui ler este print');
  await expect(failed.locator('button', { hasText: 'Tentar ler de novo' })).toBeVisible();
  const read = cards.filter({ hasText: 'Hi, Ref ABCD2' });
  await expect(read).toContainText('O print foi lido, mas não foi guardado');
  await expect(read.locator('button', { hasText: 'Guardar pelo painel' })).toBeVisible();
  await expect(read.locator('input[type="tel"]')).toBeVisible();
  // A print being read right now is not an orphan and does not show up.
  await expect(page.locator('#entry-queue')).not.toContainText('agora.png');
  await failed.locator('button', { hasText: 'Descartar print' }).click();
  await expect(cards).toHaveCount(1, { timeout: 30000 });
  expect((await backend.db.query(`select status from public.sms_print_reads where id='7a000000-0000-4000-8000-000000000001'`)).rows[0].status).toBe('DISCARDED');
  await backend.db.exec(`delete from public.sms_print_reads where id like '7a000000%'`).catch(() => backend.db.exec(`delete from public.sms_print_reads where id::text like '7a000000%'`));
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


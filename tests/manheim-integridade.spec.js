'use strict';

// Integridade do lote Manheim no navegador real, com os handlers reais (api/panel/*.js) contra um
// banco PGlite: cada recusa diz ao operador o que aconteceu e o que fazer, e oferece "Descartar
// este envio". Nada fica ativo pela metade e o lote ativo não muda. Nada sai da máquina.
//  * conteúdo de bloco diferente do manifesto (bloco alterado no caminho): recusado pelo servidor
//  * retomada com as buscas dos clientes mudadas: não continua; descartar e recomeçar funciona
//  * bloco conflitante e conferência final com diferença: a mensagem e o descarte
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-integridade.spec.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { volumeFiles, volumeSeed, volumeJourneyId } = require('./fixtures/manheim-volume');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.LOTE_SHOTS || '';
const ACTOR = '6e400000-0000-4000-8000-000000000001';
test.setTimeout(240000);
test.describe.configure({ mode: 'serial' });

let backend, handlers, files;
test.beforeAll(async () => {
  backend = await createBackend({ seed: volumeSeed(ACTOR) });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lote-integridade-'));
  // Two files, 3 blocks in the first: small enough to repeat each case.
  files = volumeFiles({ files: 2, perFile: 1200 }).files.map((file) => { const target = path.join(dir, file.name); fs.writeFileSync(target, file.text); return target; });
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

async function run(handler, request, body) {
  const url = new URL(request.url());
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  await handler({ method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body }, res);
  return res;
}

// intercept(key, body): return { fake: {status, payload} } to answer without the server,
// { body } to send a changed body to the real server, or nothing to pass through.
async function openPanel(page, log, intercept) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let body = request.postData() ? JSON.parse(request.postData()) : undefined;
    const key = body && body.action === 'chunk' ? `${body.fileIndex}:${body.chunkIndex}` : body && body.action;
    log.push(key);
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    const custom = intercept.current && intercept.current(key, body);
    if (custom && custom.abort) return route.abort('failed');
    if (custom && custom.fake) return json(custom.fake.payload, custom.fake.status);
    if (custom && custom.body) body = custom.body;
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) { const res = await run(handlers[url.pathname], request, body); return json(res.payload, res.statusCode); }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  await expect(page.locator('#manheim-summary')).toContainText(/Nenhuma importação ativa|carro\(s\) analisado\(s\)/, { timeout: 60000 });
}
const staging = async () => (await backend.db.query(`select count(*)::int n from public.manheim_uploads where activated_at is null and canceled_at is null`)).rows[0].n;
const live = async () => (await backend.db.query(`select count(*)::int n from public.manheim_uploads where activated_at is not null and undone_at is null`)).rows[0].n;

async function discard(page) {
  const button = page.getByRole('button', { name: 'Descartar este envio' });
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.locator('#manheim-status')).toHaveText('Envio descartado. O lote ativo não mudou');
}

test('bloco com conteúdo diferente do manifesto: recusado, mensagem clara, descartar', async ({ page }) => {
  const log = [], intercept = {};
  // One car of block 2 is changed on the way: the server recalculates the hash and refuses it.
  intercept.current = (key, body) => key === '0:1' ? { body: { ...body, vehicles: body.vehicles.map((item, index) => index ? item : { ...item, vehicle: { ...item.vehicle, mmrCents: (item.vehicle.mmrCents || 0) + 100 } }) } } : null;
  await openPanel(page, log, intercept);
  await page.locator('#manheim-files').setInputFiles(files);
  const status = page.locator('#manheim-status');
  await expect(status).toContainText('O conteúdo do bloco 2 de MCS_VOLUME_01.csv não confere com o que foi declarado no início do envio', { timeout: 120000 });
  await expect(status).toContainText('Nada foi gravado neste bloco, nada foi ativado e o lote ativo não mudou');
  await expect(page.locator('#manheim-summary')).toHaveText('Nenhuma importação ativa');
  expect(log.filter((key) => key === '0:1').length, 'recusa definitiva não repete').toBe(1);
  expect(log).not.toContain('finalize');
  if (SHOTS) await page.locator('#searches-panel > section.card').first().screenshot({ path: path.join(SHOTS, 'integridade-hash-1366.png') });
  await discard(page);
  expect(await staging()).toBe(0);
  expect(await live()).toBe(0);
});

test('retomada com as buscas mudadas: não continua; descartar e recomeçar ativa o lote', async ({ page }) => {
  const log = [], intercept = {};
  intercept.current = (key) => key === '1:0' ? { abort: true } : null;
  await openPanel(page, log, intercept);
  await page.locator('#manheim-files').setInputFiles(files);
  const status = page.locator('#manheim-status');
  await expect(status).toContainText('Envio interrompido em MCS_VOLUME_02.csv, bloco 1', { timeout: 120000 });
  // A customer changes the search before the operator comes back.
  await backend.db.query(`update public.journeys set criteria_json = jsonb_set(criteria_json, '{wishlists,0,yearMin}', '2015') where id=$1`, [volumeJourneyId(1)]);
  intercept.current = null;
  await page.locator('#manheim-files').setInputFiles(files);
  await expect(status).toContainText('as buscas dos clientes mudaram desde que ele começou', { timeout: 60000 });
  await expect(status).toContainText('Descarte o envio anterior e selecione os arquivos de novo para começar outro lote');
  await expect(page.locator('#manheim-summary')).toHaveText('Nenhuma importação ativa');
  if (SHOTS) await page.locator('#searches-panel > section.card').first().screenshot({ path: path.join(SHOTS, 'integridade-retomada-1366.png') });
  await discard(page);
  await page.locator('#manheim-files').setInputFiles(files);
  await expect(status).toContainText('Lote ativo · 2 arquivo(s)', { timeout: 120000 });
  expect(await live()).toBe(1);
  expect(await staging()).toBe(0);
});

test('bloco conflitante e conferência final com diferença: o que aconteceu, o que fazer e descartar', async ({ page }) => {
  const log = [], intercept = {};
  intercept.current = (key) => key === '0:0' ? { fake: { status: 409, payload: { error: 'MANHEIM_CHUNK_CONFLICT' } } } : null;
  await openPanel(page, log, intercept);
  await page.locator('#manheim-files').setInputFiles(files);
  const status = page.locator('#manheim-status');
  await expect(status).toContainText('O bloco 1 de MCS_VOLUME_01.csv já tinha sido recebido com outro conteúdo', { timeout: 120000 });
  await expect(status).toContainText('Descarte este envio e selecione os arquivos de novo para começar outro lote');
  if (SHOTS) await page.locator('#searches-panel > section.card').first().screenshot({ path: path.join(SHOTS, 'integridade-conflito-1366.png') });
  await discard(page);
  // The final check finds a difference: nothing active, the active batch did not change.
  intercept.current = (key) => key === 'finalize' ? { fake: { status: 409, payload: { error: 'MANHEIM_BATCH_INTEGRITY_ERROR' } } } : null;
  const activeBefore = (await backend.db.query(`select id from public.manheim_uploads where activated_at is not null and undone_at is null`)).rows;
  await page.locator('#manheim-files').setInputFiles(files);
  await expect(status).toContainText('A conferência final encontrou diferença entre os carros recebidos e os declarados', { timeout: 120000 });
  await expect(status).toContainText('Nada foi ativado e o lote ativo não mudou');
  if (SHOTS) await page.locator('#searches-panel > section.card').first().screenshot({ path: path.join(SHOTS, 'integridade-conferencia-1366.png') });
  await discard(page);
  expect((await backend.db.query(`select id from public.manheim_uploads where activated_at is not null and undone_at is null`)).rows).toEqual(activeBefore);
  expect(await staging()).toBe(0);
  expect(backend.refused).toEqual([]);
});

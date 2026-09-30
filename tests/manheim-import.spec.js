'use strict';

// Importação do Manheim em lote único no navegador real, com os handlers reais do painel
// (api/panel/*.js) contra um banco PGlite com todas as migrações. 19 CSVs sintéticos (~70 mil
// linhas) escolhidos juntos; a rede cai num bloco do arquivo 13; o operador escolhe os mesmos
// arquivos de novo e o envio continua de onde parou; o lote ativa inteiro de uma vez; BUSCAS abre
// sem carros e mostra as opções 10 por vez. Nada sai da máquina.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-import.spec.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { volumeFiles, volumeSeed } = require('./fixtures/manheim-volume');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.LOTE_SHOTS || '';
const ACTOR = '6e400000-0000-4000-8000-000000000001';
test.setTimeout(420000);
test.describe.configure({ mode: 'serial' });

let backend, handlers, files;
test.beforeAll(async () => {
  backend = await createBackend({ seed: volumeSeed(ACTOR) });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'manheim-searches', 'vitrine-requests', 'triage', 'actions', 'capture', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lote-unico-'));
  files = volumeFiles().files.map((file) => { const target = path.join(dir, file.name); fs.writeFileSync(target, file.text); return target; });
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

async function run(handler, request) {
  const url = new URL(request.url());
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  const req = { method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined };
  await handler(req, res);
  return res;
}

async function openPanel(page, width, log, options = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    const key = body && body.action === 'chunk' ? `${body.fileIndex}:${body.chunkIndex}` : body && body.action;
    log.push({ path: url.pathname, key });
    if (options.dropChunk && options.dropChunk(key)) return route.abort('failed');
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) { const res = await run(handlers[url.pathname], request); return json(res.payload, res.statusCode); }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  await expect(page.locator('#manheim-summary')).toContainText(/Nenhuma importação ativa|carro\(s\) analisado\(s\)/, { timeout: 60000 });
  // The files are chosen in IMPORTAÇÕES (only the 1366 test uploads).
  if (width !== 390) await page.locator('[data-view="imports"]').click();
}

test('19 arquivos viram um lote; a rede cai no arquivo 13 e o envio continua dos mesmos arquivos', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const log = [];
  let dropping = true;
  await openPanel(page, 1366, log, { dropChunk: (key) => dropping && key === '12:3' });
  await page.locator('#manheim-files').setInputFiles(files);
  // Interrupted: nothing is activated; the message says where it stopped and how to continue.
  const status = page.locator('#manheim-status');
  await expect(status).toContainText('Envio interrompido em MCS_VOLUME_13.csv, bloco 4', { timeout: 240000 });
  await expect(status).toContainText('Selecione os mesmos arquivos de novo para continuar de onde parou');
  await expect(page.getByRole('button', { name: 'Descartar este envio' })).toBeVisible();
  await expect(page.locator('#manheim-summary')).toHaveText('Nenhuma importação ativa');
  if (SHOTS) await page.locator('#imports-panel > section.card').first().screenshot({ path: path.join(SHOTS, 'lote-interrompido-1366.png') });
  const firstRound = log.filter((entry) => entry.key && /^\d+:\d+$/.test(entry.key));
  // Same files again: only the missing blocks travel.
  dropping = false;
  await page.locator('#manheim-files').setInputFiles(files);
  await expect(page.locator('#manheim-progress')).toContainText('Lote único · 19 arquivos', { timeout: 60000 });
  if (SHOTS) await page.locator('#manheim-progress').screenshot({ path: path.join(SHOTS, 'lote-retomado-progresso.png') }).catch(() => {});
  await expect(status).toContainText('Lote ativo · 19 arquivo(s)', { timeout: 240000 });
  const chunks = log.filter((entry) => entry.key && /^\d+:\d+$/.test(entry.key));
  const successful = new Set(firstRound.filter((entry) => entry.key !== '12:3').map((entry) => entry.key));
  const resent = chunks.slice(firstRound.length).filter((entry) => successful.has(entry.key));
  expect(resent, 'bloco já confirmado não é reenviado').toEqual([]);
  // The interrupted round never reached the activation: one activation, at the end.
  expect(log.filter((entry) => entry.key === 'finalize').length).toBe(1);
  await expect(page.locator('#manheim-batches')).toContainText('19 arquivos');
  // OPÇÕES: the active batch, no car in the first answer, 10 options when a demand is opened.
  await page.locator('[data-view="searches"]').click();
  await expect(page.locator('#manheim-summary')).toContainText('carro(s) analisado(s)', { timeout: 60000 });
  const { rows: [db] } = await backend.db.query(`select count(*)::int uploads, count(*) filter (where activated_at is not null)::int live, max(source_file_count)::int files from public.manheim_uploads`);
  expect(db).toEqual({ uploads: 1, live: 1, files: 19 });
  // The synthetic CSVs have no Lane/Run: the cars stay in "Informação incompleta" (nothing invented).
  const card = page.locator('#buscas-valor .manheim-lead').first();
  await expect(card.locator('.manheim-row')).toHaveCount(0);
  const incomplete = card.locator('.offer-group[data-group="INCOMPLETE"]');
  await incomplete.locator('> summary').click();
  await expect(incomplete.locator('.manheim-row')).toHaveCount(10);
  await incomplete.locator('.manheim-options-toggle').click();
  await expect(incomplete.locator('.manheim-row')).toHaveCount(20);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'lote-ativo-1366.png'), fullPage: false });
  expect(errors).toEqual([]);
  expect(backend.refused).toEqual([]);
});

test('390 px: BUSCAS do lote ativo cabe na tela, opções por página e alvos grandes', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await openPanel(page, 390, []);
  await expect(page.locator('#manheim-summary')).toContainText('carro(s) analisado(s)', { timeout: 60000 });
  const card = page.locator('#buscas-carro .manheim-lead').first();
  await card.locator('.offer-group[data-group="INCOMPLETE"] > summary').click();
  await expect(card.locator('.manheim-row')).toHaveCount(10);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const toggle = await card.locator('.offer-group[data-group="INCOMPLETE"] .manheim-options-toggle').boundingBox();
  expect(toggle.height).toBeGreaterThanOrEqual(32);
  if (SHOTS) await card.screenshot({ path: path.join(SHOTS, 'lote-opcoes-390.png') });
  expect(errors).toEqual([]);
});

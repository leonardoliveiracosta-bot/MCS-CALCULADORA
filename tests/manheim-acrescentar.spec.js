'use strict';

// Acrescentar arquivos ao lote ativo pelo botão da tela, no navegador real, com os handlers reais contra um banco
// PGlite: o lote continua o mesmo, os carros novos entram, o repetido é pulado e a tela diz quantos.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-acrescentar.spec.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `6ca00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`;
const car = (vin) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 30000, mmrCents: 2500000, location: 'FL - Orlando', cleanTitle: true, odometerOk: true } });

let backend, handlers, lotId;
async function run(handler, request) {
  const url = new URL(request.url());
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  await handler({ method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined }, res);
  return res;
}
const direct = async (body) => { const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} }; await require('../api/panel/manheim-batch')({ method: 'POST', url: '/api/panel/manheim-batch', headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res); return res; };

test.beforeAll(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  // The active batch: 3 cars, imported before.
  const cars = [car('2HKRW2H50LH000001'), car('2HKRW2H50LH000002'), car('2HKRW2H50LH000003')];
  const files = [{ name: 'MCS_MANHA.csv', size: 1, rowCount: 3, vehicleCount: 3, chunkCount: 1, chunks: [{ count: 3, hash: contentHash(cars) }] }];
  const started = await direct({ action: 'start', clientKey: '9'.repeat(32), vehicleCount: 3, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  lotId = started.payload.uploadId;
  await direct({ action: 'chunk', uploadId: lotId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await direct({ action: 'finalize', uploadId: lotId });
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'lead', 'client-context'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

test('o botão acrescenta só os carros novos ao lote ativo, sem trocar o lote', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  const starts = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) {
      if (url.pathname === '/api/panel/manheim-batch' && request.method() === 'POST' && JSON.parse(request.postData()).action === 'start') starts.push(JSON.parse(request.postData()));
      const res = await run(handlers[url.pathname], request);
      return json(res.payload, res.statusCode);
    }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="imports"]').click();
  await expect(page.locator('#manheim-append')).toHaveText('Acrescentar arquivos ao lote ativo');
  // A new CSV with 1 car already in the batch and 2 new ones. A tiny file: no "smaller batch" question.
  const csv = 'Vin,Year,Make,Model,Trim,Odometer Value,MMR\n2HKRW2H50LH000002,2020,Honda,CR-V,EX,30000,25000\n2HKRW2H50LH000004,2020,Honda,CR-V,EX,31000,25000\n2HKRW2H50LH000005,2021,Honda,CR-V,EX,20000,26000\n';
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acrescentar-')), 'MCS_TARDE.csv');
  fs.writeFileSync(file, csv);
  await page.locator('#manheim-append-files').setInputFiles(file);
  await expect(page.locator('#manheim-status')).toContainText('Acrescentado ao lote ativo · 2 carro(s) novo(s) · 1 já estavam no lote · lote agora com 5 carros', { timeout: 60000 });
  await expect(page.locator('.inline-confirm')).toHaveCount(0);
  expect(starts.map((body) => body.append)).toEqual([true]);
  const q = async (sql) => (await backend.db.query(sql)).rows;
  expect((await q(`select public.panel_manheim_active_upload_id('preview')::text id`))[0].id).toBe(lotId);
  expect((await q(`select count(*)::int n from public.manheim_vehicles where upload_id='${lotId}'`))[0].n).toBe(5);
  expect((await q(`select count(*)::int n from public.manheim_uploads where activated_at is not null`))[0].n).toBe(1);
  expect(errors).toEqual([]);
  expect(backend.refused).toEqual([]);
});

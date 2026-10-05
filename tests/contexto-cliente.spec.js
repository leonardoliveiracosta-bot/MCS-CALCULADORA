'use strict';

// Demonstração completa de um caso fictício em todas as abas, no navegador real, com os handlers
// reais contra o banco PGlite: calculadora (Ref DMCRA) → conversa no WhatsApp → leitura da conversa →
// ficha → lote do Manheim com carros → OPÇÕES. Em cada aba o mesmo resumo do cliente, e na ficha o
// resumo completo, campo a campo, com a origem de cada valor. 1366 e 390 px. Nada sai da máquina.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/contexto-cliente.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { openClientsList } = require('./abrir-clientes');
const { openOptionsFicha } = require('./abrir-ficha-opcoes');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const demo = require('./fixtures/caso-demonstracao');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.CONTEXT_SHOTS || '';
test.setTimeout(180000);

// Active batch: two Corollas inside the value band of the US$ 18,000 bid, one out of it, and a
// CX-5 for the calculator order that has no ficha.
const car = (vin, year, make, model, miles, mmr, extra = {}) => ({ fingerprint: 'vin:' + vin, vehicle: { vin, year, make, model, trim: 'LE', miles, mmrCents: mmr, location: 'FL - Orlando', lane: '3', run: '41', saleType: 'Simulcast', saleDate: '2026-10-02', conditionGrade: '4.1', cleanTitle: true, odometerOk: true, ...extra } });
const cars = [
  car('DEMOCOROLLA000001', 2020, 'Toyota', 'Corolla', 41000, 1750000),
  car('DEMOCOROLLA000002', 2019, 'Toyota', 'Corolla', 58000, 1950000, { run: '57' }),
  car('DEMOCOROLLA000003', 2022, 'Toyota', 'Corolla', 12000, 2600000),
  car('DEMOMAZDACX500001', 2019, 'Mazda', 'CX-5', 64000, 1900000)
];

let backend, handlers;
const fakeRes = () => ({ statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } });
async function run(handler, request) {
  const url = new URL(request.url());
  const res = fakeRes();
  await handler({ method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined }, res);
  return res;
}
const direct = async (name, body) => { const res = fakeRes(); await require('../api/panel/' + name)({ method: 'POST', url: '/api/panel/' + name, headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res); return res; };

test.beforeAll(async () => {
  backend = await createBackend({ seed: demo.seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'SEARCH_EXTRACTION_AI_ENABLED', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'D360_API_KEY', 'V1_DIRECT_SEND_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  // The supported CSV flow: the batch goes in through the real import handler (no Manheim API).
  const files = [{ name: 'DEMO.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await direct('manheim-batch', { action: 'start', clientKey: 'c'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin', 'Lane', 'Run']], headerMap: {} });
  if (started.statusCode !== 201) throw new Error(JSON.stringify(started.payload));
  await direct('manheim-batch', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  const done = await direct('manheim-batch', { action: 'finalize', uploadId: started.payload.uploadId });
  if (done.statusCode !== 200) throw new Error(JSON.stringify(done.payload));
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'v1-send', 'pesquisas', 'lead', 'client-context']
    .map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

// Before a capture the page is scrolled to the end, so every summary has loaded (as a person reading
// it), then back to the top so the fixed header is drawn in its place.
const shot = async (page, name) => {
  if (!SHOTS) return;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 600) { await page.evaluate((top) => window.scrollTo(0, top), y); await page.waitForTimeout(150); }
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
};

for (const width of [1366, 390]) {
  test(`${width} px · o mesmo contexto do cliente em todas as abas e o caso completo na ficha`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    const contextCalls = [];
    await openPanel(page, contextCalls);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    // The summaries load as their card comes near the screen (like a person scrolling the list).
    const summaryOf = (card) => card.locator('.client-context[data-context-state="done"]').first();
    const reach = async (card) => { await card.scrollIntoViewIfNeeded(); return summaryOf(card); };

    // ATENDIMENTO: the client wrote last → depends on MCS. The card is a spec sheet (the car as title,
    // the Ref, the phone); the case summary moved to the ficha (one click on the card).
    const todayCard = page.locator('#today-list .item-card', { hasText: 'DMCRA' }).first();
    await expect(todayCard).toBeVisible({ timeout: 60000 });
    await expect(todayCard).toContainText('Toyota Corolla');
    await expect(todayCard.locator('.card-decision')).toContainText(/sem resposta/i);
    await noOverflow();
    await shot(page, `hoje-${width}`);

    // A calculator order that only clicked and never wrote is not listed anywhere in ATENDIMENTO
    // (the calculator has no phone); the "pedidos sem conversa" section is gone.
    await expect(page.locator('#entry-orders, #entry-simulated')).toHaveCount(0);
    await expect(page.locator('#today-panel')).not.toContainText(demo.LOOSE_REF);

    // CLIENTES: same client, same context.
    await openClientsList(page);
    const clientCard = page.locator('#clients-list .client-card', { hasText: 'DMCRA' }).first();
    await expect(clientCard).toBeVisible({ timeout: 60000 });
    // CLIENTES is a directory: the summary lives under "⋯ Mais" of the line.
    await clientCard.locator('.client-more > summary').click();
    // The list shows the stage, who it depends on and the criteria (the next action lives in ATENDER AGORA).
    await expect(await reach(clientCard)).toContainText('Depende de', { timeout: 30000 });
    await expect(summaryOf(clientCard)).toContainText('Critérios da busca');
    // Field by field, with the source and the message it came from.
    await summaryOf(clientCard).locator('.context-more > summary').click();
    const table = summaryOf(clientCard).locator('.context-table');
    await expect(table).toContainText('Lido pela IA · não confirmado');
    // The value read from the conversation, without the quoted phrase ("Evidências" left the cards, comando 3).
    await expect(table).toContainText('a partir de 2019');
    await expect(table).toContainText('Não informado');
    await noOverflow();
    await shot(page, `clientes-${width}`);

    // PESQUISAS: the request read from the conversation is labelled as such and linked to the right ficha.
    await page.locator('[data-view="requests"]').click();
    // Adendo: PESQUISAS is split into com carros, sem carros and busca não rodada; the conversation request is found by its label.
    const requestCard = page.locator('#requests-list .request-card', { hasText: 'Leitura da conversa pela IA' }).filter({ hasText: 'Marina Demonstração' }).first();
    await expect(requestCard).toBeVisible({ timeout: 60000 });
    await expect(requestCard).toContainText('Toyota Corolla');
    const fichaRequest = page.locator('#requests-list .request-card', { hasText: 'O que o cliente pediu' }).filter({ hasText: 'Marina Demonstração' }).first();
    await expect(fichaRequest).toBeVisible();
    await noOverflow();
    await shot(page, `pesquisas-${width}`);

    // OPÇÕES (#218): the client is in the queue; the cars of the active batch are in the ficha, with why they fit.
    const optionsFicha = await openOptionsFicha(page, { name: 'Marina', realLead: true });
    await expect(optionsFicha).toContainText('Cliente pediu');
    const lane = optionsFicha.locator('details.offer-group[data-group="LANE"]');
    if (await lane.count()) {
      await lane.locator('> summary').click();
      const row = lane.locator('.offer-row').first();
      await expect(row).toBeVisible({ timeout: 30000 });
      await expect(row).toContainText('Consultado no CSV do Manheim de');
    }
    await noOverflow();
    await shot(page, `opcoes-${width}`);
    await page.goBack();

    // IMPORTAÇÕES: the batch the options came from.
    await page.locator('[data-view="imports"]').click();
    await expect(page.locator('#manheim-batches .batch-line').first()).toContainText('Ativo · em uso', { timeout: 60000 });
    await noOverflow();
    await shot(page, `importacoes-${width}`);

    // FICHA: the full case summary.
    await openClientsList(page);
    await page.locator('#clients-list .client-card', { hasText: 'DMCRA' }).first().locator('button', { hasText: 'Abrir ficha' }).first().click();
    const full = page.locator('#detail-panel .client-context-full .context-table').first();
    await expect(full).toBeVisible({ timeout: 60000 });
    const fullCard = page.locator('#detail-panel section.client-context-full').first();
    // The case summary of the ficha is field by field (campo-a-campo.spec.js): 9 fields, each with its situation.
    for (const text of ['O que o cliente informou, campo a campo', 'Toyota Corolla', 'a partir de 2019', 'Lido pela IA · não confirmado', 'Transferir placa']) await expect(fullCard).toContainText(text);
    await expect(page.locator('#record-detail')).toContainText('placa: transferir');
    await noOverflow();
    await shot(page, `ficha-${width}`);

    expect(contextCalls.every((call) => call.status === 200)).toBe(true);
    expect(errors).toEqual([]);
    // Only the ficha's existing ZIP → city lookup tries the outside (refused here, nothing left).
    expect(backend.refused.filter((url) => !url.startsWith('https://api.zippopotam.us/'))).toEqual([]);
  });
}

async function openPanel(page, contextCalls) {
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
      if (url.pathname === '/api/panel/client-context') contextCalls.push({ status: res.statusCode, body: JSON.parse(request.postData() || '{}') });
      return json(res.payload, res.statusCode);
    }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
}

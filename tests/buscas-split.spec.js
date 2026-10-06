'use strict';

// BUSCAS por modo no navegador, com /api/** simulado (nada é gravado, nada é enviado).
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/buscas-split.spec.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { asSummary, optionsPage } = require('./fixtures/buscas-simulado');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.BUSCAS_SHOTS || '';

const JOURNEY = '64000000-0000-4000-8000-000000000001';
const REVIEW = '64000000-0000-4000-8000-000000000002';
const BATCH_NEW = '64000000-0000-4000-8000-0000000000a1';
const BATCH_OLD = '64000000-0000-4000-8000-0000000000a2';
const x5 = (vin, extra) => ({ year: 2022, make: 'BMW', model: 'X5', trim: 'xDrive40i', miles: 70000, mmrCents: 4500000, vin, locationDisplay: 'Orlando, FL', ...extra });
const match = (id, mode, kind, vin, target) => ({ id, ...target, logical_mode: mode, demandKey: target.journey_id ? `journey:${target.journey_id}:${mode}` : `ref:${target.calc_ref}:${mode}`, match_kind: kind, match_reason: null, row_fingerprint: 'vin:' + vin, vehicle_json: { parsed: x5(vin) } });

function manheimData(state) {
  const batches = [
    { id: BATCH_NEW, uploadedAt: '2026-09-29T10:00:00Z', fileCount: 3, vehicleCount: 312, matchCount: 4, leadCount: 2, status: state.undone ? 'UNDONE' : 'ACTIVE', current: !state.undone, undoSummary: state.undone ? { vehiclesWithdrawn: 312, matchesWithdrawn: 4, unitsPreserved: 1, vitrinesPreserved: 1 } : null, ai: null },
    { id: BATCH_OLD, uploadedAt: '2026-09-28T10:00:00Z', fileCount: 1, vehicleCount: 100, matchCount: 1, leadCount: 1, status: 'ACTIVE', current: state.undone, undoSummary: null, ai: null }
  ];
  const journey = { id: JOURNEY, reference_code: 'DCCC4', status: 'ATIVO', stage: 'NOVO', enabled: true, contact: { display_name: 'Cliente Dois Modos' }, phones: [], created_at: '2026-09-28T00:00:00Z' };
  const order = { ref: 'VAAA2', key: 'ref:VAAA2', contactName: 'Pedido Só Valor', vehicleText: 'BMW X5', budgetCents: 5000000, simulations: [], logicalModes: ['VALOR'] };
  const liveNew = [
    match('65000000-0000-4000-8000-000000000001', 'VALOR', 'POR_VALOR', 'VINA', { journey_id: JOURNEY }),
    match('65000000-0000-4000-8000-000000000002', 'CARRO', 'BATE', 'VINA', { journey_id: JOURNEY }),
    match('65000000-0000-4000-8000-000000000003', 'VALOR', 'POR_VALOR', 'VINB', { calc_ref: 'VAAA2' })
  ];
  const liveOld = [match('65000000-0000-4000-8000-000000000009', 'CARRO', 'BATE', 'VINOLD', { journey_id: JOURNEY })];
  const matches = state.undone ? liveOld : liveNew;
  const demands = [
    { key: `journey:${JOURNEY}:VALOR`, mode: 'VALOR', targetType: 'JOURNEY', journeyId: JOURNEY, ref: 'DCCC4', calcRef: 'DCCC4', name: 'Cliente Dois Modos', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 5000000, issues: [], stage: 'SAVED', stageLabel: '💾 Busca salva no Manheim', matchCount: 2, offer: { lane: 1, offLane: 1, incomplete: 0, selected: 0, selectedIds: [], max: 10 } },
    { key: `journey:${JOURNEY}:CARRO`, mode: 'CARRO', targetType: 'JOURNEY', journeyId: JOURNEY, ref: 'DCCC4', calcRef: 'DCCC4', name: 'Cliente Dois Modos', wishes: [{ make: 'BMW', model: 'X5', trim: 'xDrive40i', yearMin: 2020, yearMax: 2025, minMiles: 50000, maxMiles: 90000 }], bidCents: null, issues: [], stage: 'MISSING', stageLabel: '🔍 Busca não salva no Manheim', matchCount: 1, offer: { lane: 1, offLane: 0, incomplete: 0, selected: 0, selectedIds: [], max: 10 } },
    { key: 'ref:VAAA2:VALOR', mode: 'VALOR', targetType: 'ORDER', journeyId: null, ref: 'VAAA2', calcRef: 'VAAA2', name: 'Pedido Só Valor', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 5000000, issues: [], matchCount: 1, offer: { lane: 0, offLane: 1, incomplete: 0, selected: 0, selectedIds: [], max: 10 } }
  ];
  const count = (mode) => ({ demands: demands.filter((demand) => demand.mode === mode).length, served: new Set(matches.filter((item) => item.logical_mode === mode).map((item) => item.journey_id || item.calc_ref)).size, matches: matches.filter((item) => item.logical_mode === mode).length });
  return {
    items: [journey], orders: [order], demands, matches, targets: [],
    upload: { id: state.undone ? BATCH_OLD : BATCH_NEW, vehicle_count: state.undone ? 100 : 312, matched_vehicle_count: matches.length, uploaded_at: '2026-09-29T10:00:00Z', current_lead_count: 2 },
    uploads: batches, undoAvailable: true,
    review: [
      { key: `journey:${REVIEW}:REVIEW`, mode: 'REVIEW', targetType: 'JOURNEY', journeyId: REVIEW, name: 'Cliente Sem Tipo', ref: null, issues: [{ code: 'MODE_UNKNOWN', text: 'tipo de busca indefinido' }], canDefineMode: true },
      { key: `journey:${JOURNEY}:REVIEW_MANUAL`, mode: 'REVIEW', targetType: 'JOURNEY', journeyId: JOURNEY, name: 'Cliente Dois Modos', ref: 'DCCC4', manual: true, wishes: [{ make: 'Honda', model: 'Civic', yearMin: 2015, yearMax: 2018 }], issues: [{ code: 'MANUAL_MODE_UNKNOWN', text: 'critério manual sem modo definido' }], canDefineMode: true }
    ],
    counts: { VALOR: count('VALOR'), CARRO: count('CARRO'), total: { people: 2, served: 2, matches: matches.length, review: 1 } }, meta: {}
  };
}

const searchesData = {
  countsByMode: { VALOR: { MISSING: 0, SAVED: 1, SENT: 0 }, CARRO: { MISSING: 1, SAVED: 0, SENT: 0 } },
  items: [
    { key: JOURNEY + ':VALOR', journeyId: JOURNEY, mode: 'VALOR', ref: 'DCCC4', name: 'Cliente Dois Modos', exactSearch: 'BMW X5 · lance até US$ 50.000', stage: 'SAVED', stageSource: 'MARK', stageLabel: '💾 Busca salva no Manheim', days: 0, matchCount: 1 },
    { key: JOURNEY + ':CARRO', journeyId: JOURNEY, mode: 'CARRO', ref: 'DCCC4', name: 'Cliente Dois Modos', exactSearch: 'BMW X5 xDrive40i · 2020 a 2025 · 50.000 a 90.000 milhas', stage: 'MISSING', stageSource: null, stageLabel: '🔍 Busca não salva no Manheim', days: 0, matchCount: 1 }
  ]
};
// BUSCAR CARROS: the same person with a request in each type (one per column).
const pesquisasData = {
  upload: { id: 'u', uploadedAt: '2026-09-29T10:00:00Z' }, extraction: 'SIMULADA', mergedReadings: 0,
  items: [
    { key: `ficha:journey:${JOURNEY}:VALOR`, groupKey: 'c:VALOR:h1', source: 'FICHA', searchMode: 'VALOR', state: 'COM_OPCOES', stateLabel: 'COM OPÇÕES NO LOTE', optionCount: 1, criteriaText: 'BMW X5 · lance US$ 50,000', person: { journeyId: JOURNEY, name: 'Cliente Dois Modos', ref: 'DCCC4' }, evidence: [] },
    { key: `ficha:journey:${JOURNEY}:CARRO`, groupKey: 'c:CARRO:h2', source: 'FICHA', searchMode: 'CARRO', state: 'COM_OPCOES', stateLabel: 'COM OPÇÕES NO LOTE', optionCount: 1, criteriaText: 'BMW X5 xDrive40i · 2020 a 2025', person: { journeyId: JOURNEY, name: 'Cliente Dois Modos', ref: 'DCCC4' }, evidence: [] }
  ]
};
const savedData = {
  groups: [
    { key: 'bmw|x5|valor', mode: 'VALOR', basis: 'VALUE', make: 'BMW', model: 'X5', mmrMinCents: 3500000, mmrMaxCents: 5750000, leads: 2, clients: [], searches: 1, percent: 100, individualPercent: 100, created: false },
    { key: 'bmw|x5', mode: 'CARRO', basis: 'CRITERIA', make: 'BMW', model: 'X5', yearFrom: 2020, yearTo: 2025, milesFrom: 50000, milesTo: 90000, leads: 1, clients: [], searches: 1, percent: 100, individualPercent: 100, created: false }
  ], review: []
};

async function openBuscas(page, state, calls, extra = {}) {
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/supabase-simulado/**', (route) => route.abort());
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postData() ? JSON.parse(route.request().postData()) : null;
    calls.push({ path: url.pathname, view: url.searchParams.get('view'), body });
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (extra[url.pathname]) return extra[url.pathname]({ body, json, url });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') === 'manheim') return json(asSummary(manheimData(state)));
    if (url.pathname === '/api/panel/manheim-options') return json(optionsPage(manheimData(state), url));
    if (url.pathname === '/api/panel/searches') return json(searchesData);
    if (url.pathname === '/api/panel/pesquisas' && route.request().method() === 'GET') return json(pesquisasData);
    if (url.pathname === '/api/panel/manheim-searches') return json(savedData);
    if (url.pathname === '/api/panel/actions' && body?.action === 'manheim_undo') { state.undone = true; return json({ uploadId: body.uploadId, alreadyUndone: false, summary: { vehiclesWithdrawn: 312, matchesWithdrawn: 4, unitsPreserved: 1, vitrinesPreserved: 1 } }); }
    if (url.pathname === '/api/panel/actions' && body?.action === 'set_search_mode') return json({ journeyId: body.journeyId, modes: [body.mode] });
    if (url.pathname === '/api/panel/actions' && body?.action === 'assign_manual_mode') return json({ journeyId: body.journeyId, mode: body.mode });
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], requests: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  // ENVIAR OPÇÕES is a queue now: one compact card per demand, nothing expands inline.
  await expect(page.locator('#options-queue .options-queue-card').first()).toBeVisible({ timeout: 30000 });
}

test('19 · desktop: ENVIAR OPÇÕES é uma fila de cartões compactos, nada expande na lista', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 1000 });
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const calls = [];
  await openBuscas(page, { undone: false }, calls);
  // The import tools live in IMPORTAÇÕES now; OPÇÕES shows only the queue.
  await expect(page.locator('#manheim-drop-zone')).toBeHidden();
  // Search at the top of the tab.
  await expect(page.locator('#options-queue-search')).toBeVisible();
  // One compact card per demand: the same person has one card per mode, each with its own criteria.
  const cards = page.locator('#options-queue .options-queue-card');
  await expect(cards).toHaveCount(3);
  const valorCard = page.locator('#options-queue .options-queue-card', { hasText: 'Cliente Dois Modos' }).filter({ hasText: 'lance máximo US$ 50.000,00' });
  const carroCard = page.locator('#options-queue .options-queue-card', { hasText: 'xDrive40i' });
  await expect(valorCard).toHaveCount(1);
  await expect(carroCard).toHaveCount(1);
  // The three blocks: who (name + Ref), what the client asked, the collapsed groups with counts.
  await expect(cards.first()).toContainText('Cliente Dois Modos');
  await expect(cards.first()).toContainText('Ref DCCC4');
  await expect(cards.first()).toContainText('O que o cliente pediu');
  await expect(cards.first()).toContainText(/em Lane\/Run|em Buy Now/);
  // Footer: next step + one button; tapping the card opens the ficha (no inline expansion).
  await expect(cards.first()).toContainText('Abrir ficha');
  await expect(page.locator('#options-queue .manheim-table')).toHaveCount(0);
  await expect(page.locator('#options-queue details')).toHaveCount(0);
  // Ref-only VALOR order is in the queue too.
  await expect(page.locator('#options-queue .options-queue-card', { hasText: 'Pedido Só Valor' })).toHaveCount(1);
  // Queue counter and the general total.
  await expect(page.locator('#options-queue-count')).toContainText('3 na fila');
  await expect(page.locator('#buscas-total')).toContainText('Total geral');
  // The queue search filters by name, phone, Ref and car.
  await page.locator('#options-queue-search').fill('xDrive40i');
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(1);
  await page.locator('#options-queue-search').fill('DCCC4');
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(2);
  await page.locator('#options-queue-search').fill('');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'enviar-opcoes-desktop.png'), fullPage: true });
  // BUSCAR CARROS: one request per type in its column, the result apart from the work stage, and
  // "Quais buscas salvar no Manheim" under each column.
  await page.locator('[data-view="requests"]').click();
  await expect(page.locator('#buscas-valor-saved')).toContainText('POR VALOR #1');
  await expect(page.locator('#buscas-carro-saved')).toContainText('POR ANO E MILHAGEM #1');
  await expect(page.locator('#requests-valor .request-card')).toHaveCount(1);
  await expect(page.locator('#requests-carro .request-card')).toHaveCount(1);
  await expect(page.locator('#requests-carro .request-card')).toContainText(/opç(ão|ões) no lote/);
  await expect(page.locator('#requests-carro .request-card')).toContainText('Salvar busca no Manheim');
  await expect(page.locator('#requests-valor .request-card')).not.toContainText('Andamento:');
  await expect(page.locator('#requests-panel')).not.toContainText('Falta buscar');
  await expect(page.locator('#requests-totals')).toContainText('2 pedidos de 1 pessoa');
  await expect(page.locator('.tab[data-view="requests"] [data-count]')).toHaveText('2');
  const [colValor, colCarro] = await Promise.all(['#search-col-valor', '#search-col-carro'].map((selector) => page.locator(selector).boundingBox()));
  expect(Math.abs(colValor.width - colCarro.width)).toBeLessThan(2);
  expect(colValor.x).toBeLessThan(colCarro.x);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'buscar-carros-desktop.png'), fullPage: true });
  // The result button goes to the queue card in ENVIAR OPÇÕES; the options open in the ficha.
  await page.locator('#requests-carro .request-view-options').click();
  await expect(page.locator('#searches-panel')).toBeVisible();
  const target = page.locator(`#options-queue [data-demand-key="journey:${JOURNEY}:CARRO"]`);
  await expect(target).toBeVisible();
  await expect(target.locator('.manheim-table')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'buscas-desktop.png'), fullPage: true });
  if (SHOTS) await page.locator('#manheim-results').screenshot({ path: path.join(SHOTS, 'buscas-mesma-pessoa.png') });
  expect(errors).toEqual([]);
});

test('20 · 390 px: fila em coluna única, nada fora da tela e alvos de 44 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await openBuscas(page, { undone: false }, []);
  // One column: the cards stack vertically and fit the width.
  const boxes = await page.locator('#options-queue .options-queue-card').evaluateAll((list) => list.map((card) => { const box = card.getBoundingClientRect(); return { y: box.y, height: box.height, width: box.width }; }));
  expect(boxes.length).toBe(3);
  expect(boxes[0].width).toBeGreaterThan(330);
  expect(boxes[1].y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height - 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const small = await page.locator('#searches-panel button:visible').evaluateAll((list) => list.map((button) => ({ text: button.textContent.trim().slice(0, 30), height: button.getBoundingClientRect().height })).filter((item) => item.height < 44));
  expect(small).toEqual([]);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'buscas-390.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('21-23 · Revisar tipo de busca define CARRO ou VALOR só para aquela demanda', async ({ page }) => {
  const calls = [];
  await openBuscas(page, { undone: false }, calls);
  await page.locator('[data-view="requests"]').click();
  await page.locator('#buscas-review > summary').click();
  const line = page.locator('#buscas-review-list .review-line', { hasText: 'Cliente Sem Tipo' });
  await expect(line).toContainText('tipo de busca indefinido');
  await line.getByRole('button', { name: 'Definir como CARRO' }).click();
  await expect.poll(() => calls.find((call) => call.body?.action === 'set_search_mode')?.body).toEqual({ action: 'set_search_mode', journeyId: REVIEW, mode: 'CARRO' });
  await expect(line.getByRole('button', { name: 'Definir como VALOR' })).toBeVisible();
  await expect(line.getByRole('button', { name: 'Manter pendente' })).toBeVisible();
  await expect(line.getByRole('button', { name: 'Abrir ficha' })).toBeVisible();
  // A manual criterion without mode, on a ficha with both searches, is assigned to ONE search.
  const manual = page.locator('#buscas-review-list .review-line', { hasText: 'critério manual sem modo definido' });
  await expect(manual).toContainText('Critério manual: Honda Civic · 2015 a 2018');
  await expect(manual.getByRole('button', { name: 'Definir como CARRO' })).toHaveCount(0);
  if (SHOTS) await page.locator('#buscas-review').screenshot({ path: path.join(SHOTS, 'buscas-review.png') });
  await manual.getByRole('button', { name: 'Aplicar a VALOR' }).click();
  await expect.poll(() => calls.find((call) => call.body?.action === 'assign_manual_mode')?.body).toEqual({ action: 'assign_manual_mode', journeyId: JOURNEY, mode: 'VALOR' });
});

test('24-27 · lote com vários CSVs aparece como um lote; desfazer pede confirmação na página e o lote anterior fica igual', async ({ page }) => {
  const calls = [];
  let dialogs = 0; page.on('dialog', async (dialog) => { dialogs += 1; await dialog.dismiss(); });
  const state = { undone: false };
  await openBuscas(page, state, calls);
  await page.locator('[data-view="imports"]').click();
  const newer = page.locator(`#manheim-batches [data-batch-id="${BATCH_NEW}"]`);
  const older = page.locator(`#manheim-batches [data-batch-id="${BATCH_OLD}"]`);
  await expect(newer).toContainText('3 arquivos');
  await expect(newer).toContainText('312 veículos · 4 carros com combinação');
  await expect(newer).toContainText('Ativo · em uso');
  const olderBefore = await older.textContent();
  await newer.getByRole('button', { name: 'Desfazer importação' }).click();
  const confirm = page.locator('.inline-confirm');
  await expect(confirm).toContainText('Unidades e vitrines já criadas ficam preservadas');
  await confirm.getByRole('button', { name: 'Cancelar' }).click();
  expect(calls.some((call) => call.body?.action === 'manheim_undo')).toBe(false);
  await newer.getByRole('button', { name: 'Desfazer importação' }).click();
  if (SHOTS) await page.locator('#manheim-batches').screenshot({ path: path.join(SHOTS, 'buscas-confirmar-desfazer.png') });
  await page.locator('.inline-confirm').getByRole('button', { name: 'Desfazer importação' }).click();
  await expect.poll(() => calls.filter((call) => call.body?.action === 'manheim_undo').map((call) => call.body)).toEqual([{ action: 'manheim_undo', uploadId: BATCH_NEW }]);
  await expect(page.locator('#manheim-status')).toContainText('Importação desfeita');
  await expect(newer).toContainText('Desfeito');
  await expect(newer).toContainText('1 unidade(s) e 1 vitrine(s) preservadas');
  await expect(newer.getByRole('button', { name: 'Desfazer importação' })).toHaveCount(0);
  // The previous batch is untouched and becomes the one in use.
  await expect(older).toContainText('Ativo · em uso');
  expect((await older.textContent()).replace('Ativo · em uso', 'Ativo')).toBe(olderBefore.replace('Ativo · em uso', 'Ativo'));
  // The queue follows the active batch: only the CARRO demand still has cars (everyone else is
  // listed with the reason there is no car).
  await expect(page.locator('#options-queue .options-queue-card:not(.options-queue-nocar)')).toHaveCount(1);
  await expect(page.locator('#options-queue .options-queue-card', { hasText: 'xDrive40i' })).toHaveCount(1);
  expect(dialogs).toBe(0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'buscas-desfeito.png'), fullPage: true });
});

function csvFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'buscas-')), 'Export_sintetico.csv');
  fs.writeFileSync(file, text);
  return file;
}
const CSV = 'Vin,Year,Make,Model,Trim,Odometer Value,MMR\nSYNVALID00000001,2022,BMW,X5,xDrive40i,70000,45000\nSYNAMBIG00000002,2022,BMW,X5,xDrive40i,70k mi,45000\n';
function importRoutes(ai, calls) {
  // The single batch: the server compares the cars (the browser only reads and sends them).
  const batch = { chunks: [] };
  return {
    '/api/panel/records': ({ json, url }) => json(url.searchParams.get('view') === 'manheim' ? asSummary(manheimData({ undone: false })) : { items: [], meta: {} }),
    '/api/panel/manheim-batch': ({ body, json }) => {
      if (!body) return json({ latest: { id: BATCH_NEW, vehicleCount: 312, uploadedAt: '2026-09-29T10:00:00Z', fileCount: 3 } });
      if (body.action === 'start') return json({ uploadId: BATCH_NEW, resumed: false, received: [], targetCount: 1 }, 201);
      if (body.action === 'chunk') { batch.chunks.push(body); return json({ storedVehicles: body.vehicles.length, storedMatches: body.vehicles.length, discarded: 0 }); }
      if (body.action === 'finalize') return json({ uploadId: BATCH_NEW, complete: true, fileCount: 1, vehicleCount: batch.chunks.flatMap((chunk) => chunk.vehicles).length, matchedVehicleCount: batch.chunks.flatMap((chunk) => chunk.vehicles).length, leadCount: 1, discarded: 0 });
      return json({ error: 'MANHEIM_BATCH_ACTION_INVALID' }, 400);
    },
    '/api/panel/actions': ({ body, json }) => {
      if (body.action === 'manheim_ai_rows') return json(ai(body));
      if (body.action === 'manheim_ai_summary') return json({ saved: true });
      return json({ error: 'PANEL_ACTION_INVALID' }, 400);
    }
  };
}

test('35-42 · só a linha ambígua vai para a OpenAI, a resposta é revalidada e o resumo mostra modelo e custo', async ({ page }) => {
  const calls = [];
  const ai = (body) => ({ available: true, provider: 'openai', model: 'gpt-5.4-nano', usage: { inputTokens: 320, outputTokens: 60 }, costUsd: 0.000139, ms: 900, suggestions: body.rows.map((row) => ({ id: row.id, year: 2022, make: 'BMW', model: 'X5', trim: 'xDrive40i', miles: 70000, mmr: 45000, confident: true })) });
  await openBuscas(page, { undone: false }, calls, importRoutes(ai, calls));
  await page.locator('[data-view="imports"]').click();
  await page.locator('#manheim-files').setInputFiles(csvFile(CSV));
  // M19: this CSV is much smaller than the previous batch, so the panel asks first (in the page).
  await page.locator('.inline-confirm').getByRole('button', { name: 'Enviar mesmo assim' }).click();
  await expect(page.locator('#manheim-status')).toContainText('Lote ativo', { timeout: 30000 });
  const sent = calls.filter((call) => call.body?.action === 'manheim_ai_rows');
  expect(sent).toHaveLength(1);
  expect(sent[0].body.rows).toHaveLength(1);
  expect(Object.keys(sent[0].body.rows[0].cells).sort()).toEqual(['make', 'miles', 'mmr', 'model', 'trim', 'year']);
  expect(JSON.stringify(sent[0].body)).not.toContain('SYNVALID');
  expect(JSON.stringify(sent[0].body)).not.toContain('SYNAMBIG');
  // Both cars go in the block (the AI answer went back through the parser); the server compares them.
  const chunkCars = calls.filter((call) => call.body?.action === 'chunk').flatMap((call) => call.body.vehicles);
  expect(chunkCars).toHaveLength(2);
  expect(chunkCars.filter((item) => item.vehicle.ai?.provider === 'openai')).toHaveLength(1);
  expect(calls.some((call) => call.body?.action === 'manheim_upload_part' || call.body?.action === 'manheim_archive')).toBe(false);
  const summary = page.locator('#manheim-import-summary');
  for (const text of ['linhas lidas do CSV', '2 veículos únicos importados', '1 analisadas pela OpenAI', '1 confirmadas', '0 linhas em revisão', 'Modelo: gpt-5.4-nano', 'Custo estimado: US$ 0.0001']) await expect(summary).toContainText(text);
  const stored = calls.find((call) => call.body?.action === 'manheim_ai_summary').body.summary;
  expect([stored.provider, stored.model, stored.rowsSentToAi, stored.rowsAccepted, stored.rowsReview]).toEqual(['openai', 'gpt-5.4-nano', 1, 1, 0]);
});

test('39 · OpenAI indisponível: as linhas válidas entram, só a ambígua vai para revisão e o resumo não fala de OpenAI', async ({ page }) => {
  const calls = [];
  await openBuscas(page, { undone: false }, calls, importRoutes(() => ({ available: false, reason: 'OPENAI_NOT_ENABLED', suggestions: [] }), calls));
  await page.locator('[data-view="imports"]').click();
  await page.locator('#manheim-files').setInputFiles(csvFile(CSV));
  // M19: this CSV is much smaller than the previous batch, so the panel asks first (in the page).
  await page.locator('.inline-confirm').getByRole('button', { name: 'Enviar mesmo assim' }).click();
  await expect(page.locator('#manheim-status')).toContainText('Lote ativo', { timeout: 30000 });
  await expect(page.locator('#manheim-status')).not.toHaveClass(/error/);
  const chunkCars = calls.filter((call) => call.body?.action === 'chunk').flatMap((call) => call.body.vehicles);
  expect(chunkCars).toHaveLength(1);
  const summary = page.locator('#manheim-import-summary');
  await expect(summary).toContainText('1 linhas em revisão');
  await expect(summary).not.toContainText('OpenAI');
  await summary.locator('summary').click();
  await expect(summary).toContainText('linha 3 · leitura automática indisponível');
});

'use strict';

// Imports a Manheim CSV through the real panel with /api/** simulated.
// Run: PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-import.spec.js
// By default it uses the synthetic 911 export; MANHEIM_CSV=/path/to/Export.csv uses a local file (never commit real CSVs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { porsche911Csv, porscheCustomers } = require('./fixtures/manheim-sintetico');
const { consolidateCalcRuns, groupCalculatorByRef, wishlistsForJourney } = require('../panel-domain');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
// Lets the test use a preinstalled Chromium when the pinned Playwright build is not downloaded.
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

function csvFile() {
  if (process.env.MANHEIM_CSV) return process.env.MANHEIM_CSV;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manheim-')), 'Export_sintetico.csv');
  fs.writeFileSync(file, porsche911Csv());
  return file;
}

function customers() {
  const { journeys, calcRuns } = porscheCustomers();
  return {
    items: journeys.map((journey, index) => ({
      ...journey, reference_code: null, enabled: true, contact: { display_name: `Cliente Ficticio ${index + 1}` }, phones: [],
      wishlist: wishlistsForJourney(journey)[0], wishlists: wishlistsForJourney(journey)
    })),
    orders: groupCalculatorByRef(consolidateCalcRuns(calcRuns, []), []).map((order, index) => ({ ...order, contactName: `Pedido Ficticio ${index + 1}` }))
  };
}

test('CSV do Manheim com milhares de combinações importa inteiro, em partes, sem abrir dialog', async ({ page }) => {
  test.setTimeout(180000);
  const { items, orders } = customers();
  const server = { parts: [], uploads: [], archived: 0, draft: null };
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  let dialogs = 0;
  page.on('dialog', async (dialog) => { dialogs += 1; await dialog.dismiss(); });

  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
    window.__dialogsCreated = 0;
    new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach((node) => { if (node.nodeName === 'DIALOG') window.__dialogsCreated += 1; })))
      .observe(document, { childList: true, subtree: true });
  });

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') === 'manheim') {
      const latest = server.uploads.at(-1) || null;
      return json({ items, orders, matches: latest ? latest.matches : [], upload: latest && latest.summary, meta: {} });
    }
    if (url.pathname === '/api/panel/actions' && route.request().method() === 'POST') {
      const raw = route.request().postData() || '';
      const body = JSON.parse(raw);
      if (body.action === 'manheim_upload_part') {
        const bytes = Buffer.byteLength(raw, 'utf8');
        server.parts.push({ index: body.partIndex, count: body.partCount, items: body.matches.length, bytes, uploadId: body.uploadId });
        if (bytes >= 1500000 || body.matches.length > 250) return json({ error: 'MANHEIM_UPLOAD_INVALID' }, 400);
        if (body.partIndex === 1 && !body.uploadId) server.draft = { id: '5a000000-0000-4000-8000-00000000000' + (server.uploads.length + 1), matches: [] };
        if (!server.draft || (body.uploadId && body.uploadId !== server.draft.id)) return json({ error: 'MANHEIM_UPLOAD_NOT_FOUND' }, 400);
        server.draft.matches.push(...body.matches);
        if (body.partIndex < body.partCount) return json({ uploadId: server.draft.id, complete: false, partIndex: body.partIndex, partCount: body.partCount }, 202);
        const matches = server.draft.matches.map((match, index) => ({
          id: `5b000000-0000-4000-8000-${String(index).padStart(12, '0')}`, journey_id: match.journeyId || null, calc_ref: match.calcRef || null,
          match_kind: match.kind, match_reason: match.reason, mmr_status: match.mmrStatus, row_fingerprint: match.fingerprint, vehicle_json: match.vehicle, dataGap: match.dataGap === true
        }));
        const leads = new Set(matches.map((match) => match.journey_id || match.calc_ref)).size;
        server.uploads.push({ id: server.draft.id, matches, summary: { id: server.draft.id, vehicle_count: body.vehicleCount, matched_vehicle_count: matches.length, lead_count: leads, uploaded_at: new Date().toISOString() } });
        return json({ uploadId: server.draft.id, complete: true, partIndex: body.partIndex, partCount: body.partCount, matchedVehicleCount: matches.length, leadCount: leads }, 201);
      }
      if (body.action === 'manheim_archive') {
        server.archived += body.vehicles.length;
        return json({ archived: body.vehicles.length, ignored: 0 });
      }
      return json({ error: 'PANEL_ACTION_INVALID' }, 400);
    }
    return json({ items: [], orders: [], matches: [], groups: [], meta: {} });
  });

  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  const dialogsBefore = await page.evaluate(() => window.__dialogsCreated);
  await page.locator('#manheim-files').setInputFiles(csvFile());
  const status = page.locator('#manheim-status');
  await expect(status).toContainText('arquivados', { timeout: 150000 });
  const text = await status.textContent();
  const kinds = server.uploads[0] ? server.uploads[0].matches.reduce((acc, match) => { const key = match.match_kind + (match.dataGap ? ' (falta de dado)' : ''); acc[key] = (acc[key] || 0) + 1; return acc; }, {}) : {};
  console.log('Status final:', text, '| partes:', server.parts.length, '| maior parte:', Math.max(...server.parts.map((part) => part.bytes)), 'bytes', '| tipos:', JSON.stringify(kinds));

  await expect(status).not.toHaveClass(/error/);
  expect(text).toMatch(/^\d+ carros arquivados, \d+ ignorados, \d+ combinações$/);
  const combinations = Number(/ignorados, (\d+) combinações/.exec(text)[1]);
  expect(combinations).toBeGreaterThan(2000);
  expect(server.parts.length).toBeGreaterThan(1);
  expect(server.parts.every((part) => part.items <= 250 && part.bytes < 1500000)).toBe(true);
  expect(server.parts[0].uploadId).toBeNull();
  expect(server.parts.slice(1).every((part) => part.uploadId === server.uploads[0].id)).toBe(true);
  expect(server.uploads).toHaveLength(1);
  expect(server.uploads[0].matches).toHaveLength(combinations);
  expect(dialogs).toBe(0);
  expect(await page.evaluate(() => window.__dialogsCreated)).toBe(dialogsBefore);
  expect(await page.locator('dialog[open]').count()).toBe(0);
  expect(errors).toEqual([]);

  // BUSCAS: at most 10 visible rows per customer, the rest behind "Ver mais (N)".
  await page.evaluate(() => document.querySelector('[data-view="searches"]')?.click());
  await expect(page.locator('#manheim-results .manheim-more').first()).toBeVisible({ timeout: 30000 });
  const cards = page.locator('#manheim-results .manheim-lead');
  const cardIndex = await cards.evaluateAll((list) => list.findIndex((item) => item.querySelector('.manheim-more')));
  const card = cards.nth(cardIndex);
  expect(await card.locator('.manheim-row').count()).toBe(10);
  const more = card.locator('.manheim-more');
  const hidden = Number(/\((\d+)\)/.exec(await more.textContent())[1]);
  await more.click();
  expect(await card.locator('.manheim-row').count()).toBe(10 + hidden);
  const rows = await card.locator('.manheim-row').evaluateAll((list) => list.map((row) => ({
    kind: row.classList.contains('match') ? 'BATE' : row.classList.contains('value') ? 'POR_VALOR' : 'QUASE',
    miles: Number(([...row.querySelectorAll('span')].map((span) => /^([\d.,\s\u00a0]+) milhas/.exec(span.textContent)).find(Boolean) || ['', ''])[1].replace(/\D/g, '') || NaN)
  })));
  expect(rows.every((row) => Number.isFinite(row.miles))).toBe(true);
  // Order: BATE, then POR VALOR, then QUASE.
  const order = { BATE: 0, POR_VALOR: 1, QUASE: 2 };
  for (let index = 1; index < rows.length; index += 1) expect(order[rows[index].kind]).toBeGreaterThanOrEqual(order[rows[index - 1].kind]);
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].kind === rows[index - 1].kind) expect(rows[index].miles).toBeGreaterThanOrEqual(rows[index - 1].miles);
  }
});

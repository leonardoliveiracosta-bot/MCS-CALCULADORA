'use strict';

// Complemento pelo botão real do painel, com CSVs sintéticos e os handlers reais em PGlite.
// Prévia e cancelamento não gravam; confirmar acrescenta só dados de venda; repetir é inócuo.
// Run: CHROMIUM_PATH=/usr/bin/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/manheim-complemento.spec.js
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const csv = require('./fixtures/manheim-csv');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `6cb00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(2)}','preview','Cliente Complemento','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(3)}','preview','${id(2)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], logical_modes: ['CARRO'] })}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(4)}','preview','WHATSAPP','${id(2)}','complemento-browser','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(5)}','preview','${id(4)}','WHATSAPP','CUSTOMER','Quero um CR-V','x',now(),'complemento-browser',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(5)}','${id(3)}','IMPORT',now());`
].join('\n');

const HEADERS = 'Inventory,Vin,Year,Make,Model,Trim,Odometer Value,MMR,Condition Report Grade,Pickup Location,Starts At,Lane,Run,Buy Now Price,Event Sale Name,Status';
const row = (inventory, vin, lane, run, buyNow, event) => [inventory, vin, '2020', 'Honda', 'CR-V', 'EX', '21000', '25000', '4.1', 'FL - Orlando', '2026-10-01T15:00:00Z', lane, run, buyNow, event, 'Active'].join(',');
const FILES = [
  { name: 'A.csv', text: [HEADERS,
    row('Simulcast', '2HKRW2H59LH800001', '3', '41', '26500', 'Orlando Tuesday'),
    row('OVE', '2HKRW2H59LH800002', '', '', '27000', 'Buy Now / Make Offer')].join('\n') + '\n' },
  { name: 'B.csv', text: [HEADERS,
    row('OVE', '2HKRW2H59LH800003', '', '', '', ''),
    row('OVE', '2HKRW2H59LH800001', '', '', '', '')].join('\n') + '\n' }
];

let backend, batch, handlers;
async function call(handler, method, url, body) {
  const parsed = new URL(url, base);
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await handler({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const q = async (sql) => (await backend.db.query(sql)).rows;
const snapshot = async (tables) => Object.fromEntries(await Promise.all(tables.map(async (table) => [table, await q(`select to_jsonb(t) as row from public.${table} t order by to_jsonb(t)::text`)])));
const frozen = () => snapshot(['manheim_uploads', 'manheim_vehicles', 'manheim_matches', 'manheim_option_selections', 'manheim_upload_chunks', 'journeys', 'vitrine_cars', 'messages']);
const saleState = () => snapshot(['manheim_complement_runs', 'manheim_complement_chunks', 'manheim_complement_items', 'manheim_sale_current', 'audit_log']);

test.beforeAll(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'lead', 'client-context'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
  batch = await csv.importLegacy((body) => call(handlers['/api/panel/manheim-batch'], 'POST', '/api/panel/manheim-batch', body), FILES);
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

test('prévia, cancelar, confirmar e repetir o complemento pelo navegador sem alterar o lote', async ({ page }) => {
  const errors = [];
  const actions = [];
  const refused = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === 'https://fonts.googleapis.com') return route.fulfill({ contentType: 'text/css', body: '' });
    if (url.origin !== new URL(base).origin) { refused.push(url.href); return route.abort(); }
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204, body: '' });
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) {
      const body = request.postData() ? JSON.parse(request.postData()) : undefined;
      if (url.pathname === '/api/panel/manheim-batch' && request.method() === 'POST') actions.push(body);
      const res = await call(handlers[url.pathname], request.method(), request.url(), body);
      return json(res.payload, res.statusCode);
    }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="imports"]').click();
  const status = page.locator('#manheim-complement-status');
  const confirmation = page.locator('.inline-confirm');
  const selectFiles = async () => {
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Complementar dados do lote ativo', exact: true }).click();
    // Selection order differs from import order; the saved manifest determines duplicate resolution.
    await (await chooser).setFiles([...FILES].reverse().map((file) => ({ name: file.name, mimeType: 'text/csv', buffer: Buffer.from(file.text) })));
  };
  const assertPreview = async () => {
    await expect(status).toHaveText('Aguardando confirmação', { timeout: 15000 });
    await expect(confirmation).toContainText('3 carros do lote ativo conferidos com o manifesto · 3 vão receber Lane, Run, Inventory, Status e Event Sale Name: 1 com Lane/Run, 1 Buy Now / Make Offer, 1 ainda incompletos');
    await expect(confirmation.getByRole('button', { name: 'Complementar agora', exact: true })).toBeVisible();
    await expect(status).not.toHaveClass(/error/);
  };
  expect(batch.vehicleCount).toBe(3);
  expect((await q('select count(*)::int n from public.manheim_matches'))[0].n).toBe(3);
  const before = await frozen();
  const salesBefore = await saleState();

  await test.step('a prévia confere os dois arquivos e não grava; cancelar deixa tudo intacto', async () => {
    await selectFiles();
    await assertPreview();
    expect(actions.map((body) => body.action)).toEqual(['complement-check', 'complement-check']);
    expect(actions.map((body) => body.clientKey)).toEqual([batch.clientKey, batch.clientKey]);
    expect(actions.map((body) => body.uploadId)).toEqual([batch.uploadId, batch.uploadId]);
    expect(await frozen()).toEqual(before);
    expect(await saleState()).toEqual(salesBefore);
    await confirmation.getByRole('button', { name: 'Cancelar', exact: true }).click();
    await expect(status).toHaveText('Complemento cancelado · Nada foi gravado');
    await expect(confirmation).toHaveCount(0);
    expect(actions.map((body) => body.action)).toEqual(['complement-check', 'complement-check']);
    expect(await frozen()).toEqual(before);
    expect(await saleState()).toEqual(salesBefore);
  });

  await test.step('selecionar novamente e confirmar aplica só os cinco dados de venda', async () => {
    actions.length = 0;
    await selectFiles();
    await assertPreview();
    expect(await saleState()).toEqual(salesBefore);
    await confirmation.getByRole('button', { name: 'Complementar agora', exact: true }).click();
    await expect(status).toHaveText('Complemento concluído · 3 carros complementados · 1 com Lane/Run · 1 Buy Now / Make Offer · 1 ainda incompletos · 3 combinações', { timeout: 60000 });
    await page.waitForLoadState('networkidle');
    await expect(confirmation).toHaveCount(0);
    expect(actions.map((body) => body.action)).toEqual(['complement-check', 'complement-check', 'complement-start', 'complement-stage', 'complement-stage', 'complement-apply', 'complement-result']);
    expect(actions.filter((body) => ['complement-start', 'complement-apply'].includes(body.action)).every((body) => body.confirmed === true)).toBe(true);
    expect(await frozen()).toEqual(before);
    expect((await q(`select public.panel_manheim_active_upload_id('preview')::text id`))[0].id).toBe(batch.uploadId);
    const sales = await q('select i.row_fingerprint, i.sale from public.manheim_sale_current c join public.manheim_complement_items i on i.run_id = c.run_id order by i.row_fingerprint');
    expect(sales).toHaveLength(3);
    expect(sales.every((item) => Object.keys(item.sale).sort().join() === 'eventSaleName,lane,run,saleStatus,saleType')).toBe(true);
    expect(sales[0]).toEqual({ row_fingerprint: 'vin:2HKRW2H59LH800001', sale: { lane: '3', run: '41', saleType: 'Simulcast', saleStatus: 'Active', eventSaleName: 'Orlando Tuesday' } });
    expect((await q("select count(*)::int n from public.audit_log where action = 'MANHEIM_COMPLEMENT'"))[0].n).toBe(1);
  });

  await test.step('repetir os mesmos arquivos não confirma nem grava de novo', async () => {
    const salesAfter = await saleState();
    actions.length = 0;
    await selectFiles();
    await expect(status).toHaveText('Nada a complementar · os 3 carros do lote ativo já têm estes dados', { timeout: 15000 });
    await expect(confirmation).toHaveCount(0);
    await expect(status).not.toHaveClass(/error/);
    expect(actions.map((body) => body.action)).toEqual(['complement-check', 'complement-check']);
    expect(await frozen()).toEqual(before);
    expect(await saleState()).toEqual(salesAfter);
  });
  expect(errors).toEqual([]);
  expect(refused).toEqual([]);
  expect(backend.refused).toEqual([]);
});

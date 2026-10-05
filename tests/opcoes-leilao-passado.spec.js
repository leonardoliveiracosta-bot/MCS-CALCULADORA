'use strict';

// ENVIAR OPÇÕES no navegador real, handlers reais contra um banco PGlite (migração 20261027010000):
// carro com leilão passado some das opções; o que a Leo já selecionou continua, com o selo "Leilão
// passado", e fica fora da V1 com aviso de quais saíram. Nada é apagado. Nada sai da máquina.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/opcoes-leilao-passado.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { openOptionsFicha, fichaSection } = require('./abrir-ficha-opcoes');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.LOTE_SHOTS || '';
test.setTimeout(120000);

const id = (n) => `6c900000-0000-4000-8000-${String(n).padStart(12, '0')}`;
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
  const vin = 'LEIL' + String(n).padStart(13, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make: 'Honda', model: 'CR-V', trim: 'EX', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', startsAt: '2099-10-01T15:00:00Z', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: (4.9 - n * 0.2).toFixed(1), cleanTitle: true, odometerOk: true, ...extra } };
};
// Três com leilão futuro; dois com leilão de dois dias atrás (o 3 fica selecionado, o 4 não).
const past = new Date(Date.now() - 2 * 86400000).toISOString();
const cars = [car(0), car(1), car(2), car(3, { startsAt: past, trim: 'Touring' }), car(4, { startsAt: past, trim: 'Sport' })];
const vin = (n) => 'LEIL' + String(n).padStart(13, '0');

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
  const files = [{ name: 'LEILAO.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await direct('manheim-batch', { action: 'start', clientKey: 'e'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  await direct('manheim-batch', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await direct('manheim-batch', { action: 'finalize', uploadId: started.payload.uploadId });
  // Selecionado antes de o leilão passar.
  await backend.db.exec(`insert into public.manheim_option_selections(environment,match_id,upload_id,demand_key,status,offer_group,mmr_cents,default_pct,final_cents)
    select 'preview',m.id,m.upload_id,m.demand_key,'SELECTED','LANE',2500000,10,2750000 from public.manheim_matches m where m.vehicle_json#>>'{parsed,vin}'='${vin(3)}'`);
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'manheim-batch', 'manheim-options', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'v1-send'].map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

async function openPanel(page) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) { const res = await run(handlers[url.pathname], request); return json(res.payload, res.statusCode); }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
}

test('leilão passado: some das opções, o selecionado continua com selo e fica fora da V1 com aviso', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await openPanel(page);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { window.__opened = []; window.open = (href) => { window.__opened.push(String(href)); return null; }; });
  const card = await openOptionsFicha(page, { mode: 'CARRO' });
  const group = card.locator('.offer-group[data-group="LANE"]');
  // 3 com leilão futuro + o selecionado; o de leilão passado sem seleção não aparece nem é contado.
  await expect(group.locator('> summary')).toHaveText(/\(4\)$/, { timeout: 60000 });
  await group.locator('> summary').click();
  const rows = group.locator('.offer-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.filter({ hasText: vin(4) })).toHaveCount(0);
  const kept = rows.filter({ hasText: vin(3) });
  await expect(kept).toHaveAttribute('data-status', 'SELECTED');
  await expect(kept.locator('.badge', { hasText: 'Leilão passado · não entra na V1' })).toBeVisible();
  await expect(rows.locator('.badge', { hasText: 'Leilão passado' })).toHaveCount(1);
  // V1 com um carro vivo + o selecionado de leilão passado: só o vivo entra; a tela diz qual saiu.
  const live = rows.filter({ hasText: vin(0) });
  await live.locator('[data-offer-action="select"]:visible').click();
  await expect(live).toHaveAttribute('data-status', 'SELECTED');
  const foot = page.locator('#detail-panel .ficha-v1-foot');
  await foot.getByRole('button', { name: 'Gerar V1 e abrir no WhatsApp' }).click();
  await expect(foot.locator('.ficha-v1-status')).toHaveText('WhatsApp aberto com a mensagem · O envio é feito por você no WhatsApp · Fora da V1 (leilão passado): 2020 Honda CR-V Touring', { timeout: 30000 });
  if (SHOTS) await card.screenshot({ path: path.join(SHOTS, 'leilao-passado.png') });
  const { rows: v1 } = await backend.db.query(`select c.vehicle_snapshot->>'vin' vin from public.vitrines v join public.vitrine_cars c on c.vitrine_id = v.id where v.journey_id = '${JOURNEY}' and v.version = 'V1'`);
  expect(v1.map((row) => row.vin)).toEqual([vin(0)]);
  // Nada apagado: os cinco carros continuam no lote, a seleção do carro de leilão passado também.
  expect((await backend.db.query(`select count(*)::int n from public.manheim_matches where undone_at is null`)).rows[0].n).toBe(5);
  expect((await backend.db.query(`select count(*)::int n from public.manheim_option_selections where status = 'SELECTED'`)).rows[0].n).toBe(2);
  expect(errors).toEqual([]);
  expect(backend.refused).toEqual([]);
});

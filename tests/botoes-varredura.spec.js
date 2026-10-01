'use strict';

// Varredura de botões: abre cada aba do painel e uma ficha no navegador real, com os handlers reais
// contra um banco PGlite, e clica em todos os botões visíveis. Registra erro de script, erro do
// servidor (5xx), caixa do navegador (confirm/alert/prompt), chamada a endpoint sem handler, chamada
// para fora da máquina e botão que não reage (sem requisição e sem mudança na tela). Nada sai da
// máquina: Preview simulado, sem IA e sem WhatsApp.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/botoes-varredura.spec.js
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(3600000);
const REPORT = process.env.BOTOES_REPORT || '';

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

let backend;
const handlerFor = (pathname) => {
  const file = path.join(__dirname, '..', pathname.replace(/^\//, '') + '.js');
  return fs.existsSync(file) ? require(file) : null;
};
async function run(handler, request) {
  const url = new URL(request.url());
  const res = { statusCode: 200, payload: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end(body) { if (body !== undefined && this.payload === null) this.payload = body; return null; } };
  let body;
  try { body = request.postData() ? JSON.parse(request.postData()) : undefined; } catch (_) { body = request.postData(); }
  await handler({ method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body }, res);
  return res;
}
const direct = async (name, body) => { const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} }; await require('../api/panel/' + name)({ method: 'POST', url: '/api/panel/' + name, headers: { authorization: 'Bearer token-simulado' }, query: {}, body }, res); return res; };

test.beforeAll(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'SEARCH_EXTRACTION_AI_ENABLED', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'D360_API_KEY', 'ANTHROPIC_API_KEY']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  const files = [{ name: 'TRES.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: 1, chunks: [{ count: cars.length, hash: contentHash(cars) }] }];
  const started = await direct('manheim-batch', { action: 'start', clientKey: 'd'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin']], headerMap: {} });
  await direct('manheim-batch', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex: 0, vehicles: cars });
  await direct('manheim-batch', { action: 'finalize', uploadId: started.payload.uploadId });
  for (const n of [1, 2, 3, 4]) await direct('pesquisas', { action: 'extract', chatId: id(30 + n) });
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

// Never clicked: leaving the session and actions that only open the device's file picker.
const SKIP = /^(Sair)$/;

test('varredura de todos os botões do painel', async ({ page }) => {
  const findings = [];
  const clicked = [];
  const pending = { requests: 0, last: [] };
  let current = '';
  page.on('pageerror', (error) => findings.push({ kind: 'ERRO_DE_SCRIPT', where: current, detail: String(error.message).slice(0, 200) }));
  page.on('console', (message) => { if (message.type() === 'error' && !/Failed to load resource|favicon|net::ERR_ABORTED|service worker|Notification/i.test(message.text())) findings.push({ kind: 'ERRO_NO_CONSOLE', where: current, detail: message.text().slice(0, 200) }); });
  let sideEffects = 0;
  page.on('download', () => { sideEffects += 1; });
  page.on('filechooser', () => { sideEffects += 1; });
  page.on('dialog', async (dialog) => { findings.push({ kind: 'CAIXA_DO_NAVEGADOR', where: current, detail: dialog.type() + ': ' + dialog.message().slice(0, 120) }); await dialog.dismiss(); });
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) { findings.push({ kind: 'CHAMADA_EXTERNA', where: current, detail: url.origin }); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    pending.requests += 1; pending.last.push(request.method() + ' ' + url.pathname);
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    const handler = handlerFor(url.pathname);
    if (!handler) { findings.push({ kind: 'ENDPOINT_SEM_HANDLER', where: current, detail: request.method() + ' ' + url.pathname }); return json({ error: 'NOT_FOUND' }, 404); }
    let res;
    try { res = await run(handler, request); } catch (error) { findings.push({ kind: 'SERVIDOR_EXCECAO', where: current, detail: url.pathname + ': ' + String(error.message).slice(0, 150) }); return json({ error: 'SERVER_ERROR' }, 500); }
    if (res.statusCode >= 500) findings.push({ kind: 'SERVIDOR_5XX', where: current, detail: `${request.method()} ${url.pathname} ${res.statusCode} ${JSON.stringify(res.payload).slice(0, 120)}` });
    const type = res.headers['Content-Type'] || res.headers['content-type'];
    if (type && !/json/.test(type)) return route.fulfill({ status: res.statusCode, contentType: type, body: typeof res.payload === 'string' || Buffer.isBuffer(res.payload) ? res.payload : JSON.stringify(res.payload) });
    return json(res.payload, res.statusCode);
  });
  await page.goto(base + '/painel/');
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
  await page.waitForTimeout(1500);

  const snapshot = () => page.evaluate(() => { const app = document.querySelector('#app-view'); return (app ? app.innerText.length + ':' + app.querySelectorAll('*').length + ':' + [...app.querySelectorAll('[class]')].filter((n) => !n.closest('.hidden')).length : '') + ':' + (document.activeElement && document.activeElement.tagName); });
  const save = () => { if (REPORT) fs.writeFileSync(REPORT, JSON.stringify({ clicked, findings, refused: backend.refused }, null, 2)); };
  async function sweep(where, rootSelector, maxPerLabel = 2) {
    current = where;
    try { await sweepInner(where, rootSelector, maxPerLabel); } finally { save(); }
  }
  async function sweepInner(where, rootSelector, maxPerLabel) {
    const seen = new Map();
    for (let pass = 0; pass < 400; pass += 1) {
      const buttons = await page.locator(`${rootSelector} button:visible`).all();
      let target = null, label = '';
      for (const button of buttons) {
        // A button that left the page while the list was read (a click that changed the view) is
        // skipped: every read has a limit, so the sweep never waits forever for a detached button.
        const text = ((await button.innerText({ timeout: 2000 }).catch(() => '')) || (await button.getAttribute('aria-label', { timeout: 2000 }).catch(() => null)) || (await button.getAttribute('id', { timeout: 2000 }).catch(() => null)) || '').replace(/\s+/g, ' ').trim().slice(0, 60);
        const key = text.replace(/\d+/g, '#');
        if (!text || SKIP.test(text) || (seen.get(key) || 0) >= maxPerLabel) continue;
        if (await button.isDisabled({ timeout: 2000 }).catch(() => true)) { seen.set(key, (seen.get(key) || 0) + 1); clicked.push({ where, label: text, result: 'DESABILITADO' }); continue; }
        target = button; label = text; seen.set(key, (seen.get(key) || 0) + 1); break;
      }
      if (!target) break;
      current = `${where} › ${label}`;
      const before = await snapshot(); const requestsBefore = pending.requests; const effectsBefore = sideEffects; const findingsBefore = findings.length; pending.last = [];
      // Every click has a hard limit: a button that hangs the page is a finding, never a stuck sweep.
      const step = (async () => {
        await target.click({ timeout: 5000 }).catch((error) => findings.push({ kind: 'NAO_CLICAVEL', where: current, detail: String(error.message).split('\n')[0].slice(0, 150) }));
        await page.waitForTimeout(400);
        await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
      })();
      const hung = await Promise.race([step.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 20000))]);
      if (hung) findings.push({ kind: 'TRAVOU', where: current, detail: 'mais de 20 s sem terminar o clique' });
      const after = await snapshot();
      const reacted = pending.requests > requestsBefore || after !== before || sideEffects > effectsBefore;
      clicked.push({ where, label, result: findings.length > findingsBefore ? 'PROBLEMA' : reacted ? 'OK' : 'SEM_REACAO', requests: [...pending.last].slice(0, 3) });
      if (!reacted) findings.push({ kind: 'SEM_REACAO', where: current, detail: 'nenhuma requisição e nenhuma mudança na tela' });
      // A report dialog, a detail view or a closed panel: go back to where the sweep is.
      await page.evaluate(() => { const dialog = document.querySelector('dialog[open]'); if (dialog) dialog.close(); });
      if (!rootSelector.startsWith('#record-detail') && await page.locator('#detail-panel:not(.hidden)').count()) { await page.locator('#detail-back').click().catch(() => {}); await page.waitForTimeout(500); }
      // Inside the ficha: a button that left it (another ficha, a tab) reopens the same ficha.
      if (rootSelector.startsWith('#record-detail') && reopenFicha && !(await page.locator('#detail-panel:not(.hidden)').count())) await reopenFicha();
      current = where;
    }
  }
  let reopenFicha = null;
  const view = async (name) => { await page.locator(`[data-view="${name}"]`).click(); await page.waitForTimeout(1200); await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}); };
  // Open every collapsed section so the buttons inside are reachable.
  const openDetails = () => page.evaluate(() => document.querySelectorAll('#app-view details').forEach((d) => { d.open = true; }));

  const ONLY = (process.env.BOTOES_SECTIONS || '').split(',').filter(Boolean);
  const want = (name) => !ONLY.length || ONLY.includes(name);
  if (want('HOJE')) { await view('today'); await openDetails(); await sweep('HOJE', '#today-panel'); }
  if (want('ENTRADA')) { await view('entry'); await openDetails(); await sweep('ENTRADA', '#entry-panel'); }
  if (want('PESQUISAS')) { await view('requests'); await openDetails(); await sweep('PESQUISAS', '#requests-panel'); }
  // OPÇÕES before CLIENTES: the CLIENTES sweep clicks "Desligar"/"Tratado"/"Não é lead" on the only ficha,
  // which (correctly) takes it out of OPÇÕES.
  if (want('OPÇÕES')) { await view('searches'); await expect(page.locator('#searches-panel .manheim-lead').first()).toBeVisible({ timeout: 60000 }); await page.waitForTimeout(1500);
  await openDetails(); await sweep('OPÇÕES', '#searches-panel', 3); }
  if (want('CLIENTES')) { await view('clients'); await openDetails(); await sweep('CLIENTES', '#clients-panel'); }
  // A ficha: opened from CLIENTES (Abrir lead), then every button inside it (never "Voltar").
  if (want('FICHA')) {
    reopenFicha = async () => {
      await view('clients');
      await page.locator('#clients-list button', { hasText: 'Abrir ficha' }).first().click();
      await expect(page.locator('#record-detail button').nth(3)).toBeVisible({ timeout: 60000 }); await page.waitForTimeout(1000); await openDetails();
    };
    await view('clients');
    if (await page.locator('#clients-list button', { hasText: 'Abrir ficha' }).count()) { await reopenFicha(); await sweep('FICHA', '#record-detail', 1); await page.locator('#detail-back').click().catch(() => {}); }
    else findings.push({ kind: 'SEM_FICHA_PARA_TESTAR', where: 'FICHA', detail: 'nenhum botão Abrir ficha' });
    reopenFicha = null;
  }
  if (want('IMPORTAÇÕES')) { await view('imports'); await openDetails(); await sweep('IMPORTAÇÕES', '#imports-panel'); }
  if (want('CABEÇALHO')) { current = 'CABEÇALHO'; await sweep('CABEÇALHO', 'header.topbar'); }

  const summary = { clicked, findings, refused: backend.refused };
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(summary, null, 2));
  console.log('BOTOES', clicked.length, 'PROBLEMAS', findings.length);
});

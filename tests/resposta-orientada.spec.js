'use strict';

// Ficha › CONVERSA: resposta orientada e tradução da conversa no navegador real, com os handlers reais
// contra o banco PGlite e conversas fictícias (IA simulada fora de produção). Nada é enviado. 1366 e 390 px.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/resposta-orientada.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const fixture = require('./fixtures/conversas-sugestao');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.SUGGESTION_SHOTS || '';
test.setTimeout(180000);

let backend, handlers;
const fakeRes = () => ({ statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } });
async function run(handler, request) {
  const url = new URL(request.url());
  const res = fakeRes();
  await handler({ method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined }, res);
  return res;
}

test.beforeAll(async () => {
  backend = await createBackend({ seed: fixture.seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'REPLY_SUGGESTION_ENABLED', 'D360_API_KEY', 'V1_DIRECT_SEND_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'SEARCH_EXTRACTION_AI_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  handlers = Object.fromEntries(['session', 'records', 'today', 'entry', 'searches', 'vitrine-requests', 'triage', 'actions', 'automatic-messages', 'weekly', 'orders', 'pendencias', 'whatsapp', 'vitrines', 'v1-send', 'pesquisas', 'lead', 'client-context', 'suggestions', 'reply']
    .map((name) => ['/api/panel/' + name, require('../api/panel/' + name)]));
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
};


for (const width of [1366, 390]) {
  test(`${width} px · resposta orientada e tradução da conversa, sugestão automática igual, nada enviado`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    const calls = [];
    // Each width starts with no saved translation (the cache itself is checked below, after a reload).
    await backend.db.query('delete from public.message_translations');
    await openPanel(page, calls);
    await page.setViewportSize({ width, height: 900 });
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const action = (name) => calls.filter((call) => call.path === '/api/panel/suggestions' && call.method === 'POST' && JSON.parse(call.body || '{}').action === name);
    const sendCalls = () => calls.filter((call) => (call.path === '/api/panel/v1-send' && /"action":"(send|demo_send)"/.test(call.body)) || (call.path === '/api/panel/reply' && /"action":"send"/.test(call.body)));

    await page.goto(base + '/painel/#ficha/' + fixture.people.english.journey, { waitUntil: 'domcontentloaded' });
    let opened = 0; const reopenFicha = async () => { opened += 1; await page.goto(base + '/painel/?abrir=' + opened + '#ficha/' + fixture.people.english.journey, { waitUntil: 'domcontentloaded' }); };
    const conversation = page.locator('#lead-conversation');
    const guided = conversation.locator('.guided-card');
    await expect(guided).toBeVisible({ timeout: 60000 });
    // The automatic suggestion stays where it was, with its own button.
    await expect(conversation.locator('.suggestion-card')).toHaveCount(1);
    await expect(conversation.locator('.suggestion-card')).toContainText('SUGESTÃO DE RESPOSTA');

    // Empty guidance: a warning, no call.
    await guided.getByRole('button', { name: 'Gerar resposta' }).click();
    await expect(guided.locator('.status')).toContainText('Escreva o que você quer transmitir');
    expect(action('guided').length).toBe(0);

    // Guidance → answer in the client's language + Portuguese translation; double tap = one call.
    await guided.locator('.guided-input').fill('o CR-V 2019 aparece bastante; com 22 mil dá para competir; perguntar se decide esta semana');
    await guided.getByRole('button', { name: 'Gerar resposta' }).dblclick();
    const body = guided.locator('.suggestion-body');
    await expect(body.locator('.suggestion-text')).toBeVisible({ timeout: 30000 });
    expect(action('guided').length, 'toque duplo gera uma resposta só').toBe(1);
    for (const text of ['Orientada por você', 'Idioma do cliente: Inglês', 'Tradução da resposta para português', 'Simulada · sem IA e sem custo', 'Para Ethan Example · +13055550111']) await expect(body).toContainText(text);
    // Same review as the suggestion: edit, copy, open WhatsApp (only prepares), discard.
    const textarea = body.locator('.suggestion-text');
    await textarea.fill('Hi Ethan, 2019 CR-Vs show up often. Could you decide this week?');
    // Open window: the same send path as the suggestion (panel, with confirmation), shown before the click.
    await expect(body).toContainText('Janela de 24 h aberta');
    await expect(body).toContainText('sai pelo painel, só depois da sua confirmação');
    await expect(body.getByRole('button', { name: 'Enviar pelo painel' })).toBeVisible();
    await body.getByRole('button', { name: 'Copiar' }).click();
    await expect(body.locator('.suggestion-result')).toContainText('Nada foi enviado');
    await noOverflow();
    await shot(page, `ficha-orientada-${width}`);
    if (SHOTS) await guided.screenshot({ path: path.join(SHOTS, `componente-orientada-${width}.png`) });
    await body.getByRole('button', { name: 'Descartar' }).click();
    await expect(guided.locator('.suggestion-body')).toContainText('Nada foi enviado');

    // The automatic suggestion still works as before.
    const auto = conversation.locator('.suggestion-card');
    await auto.getByRole('button', { name: 'Sugerir resposta' }).click();
    await expect(auto.locator('.suggestion-body .suggestion-text')).toBeVisible({ timeout: 30000 });
    await expect(auto.locator('.suggestion-body')).toContainText('Mileage under 60k please');

    // Translation: never on opening; each message has its own "traduzir" (shown on hover on the computer,
    // f3b05ee removed the "Traduzir conversa" bar); a double tap translates once; shown under the original.
    expect(action('translate').length, 'abrir a conversa não traduz').toBe(0);
    const firstToTranslate = conversation.locator('article.lead-message').filter({ has: page.locator('button.translate-one') }).first();
    await firstToTranslate.hover();
    await firstToTranslate.locator('button.translate-one').dblclick();
    await expect(conversation.locator('.message-translation').first()).toBeVisible({ timeout: 30000 });
    expect(action('translate').length, 'toque duplo traduz uma vez').toBe(1);
    await expect(conversation.locator('.lead-thread')).toContainText('Mileage under 60k please');
    await expect(conversation.locator('.message-translation').first()).toContainText('Tradução para português');
    await noOverflow();
    await shot(page, `ficha-traducao-${width}`);
    if (SHOTS) await conversation.locator('.lead-thread').screenshot({ path: path.join(SHOTS, `componente-traducao-${width}.png`), timeout: 15000 }).catch(() => {});

    // Reopening reuses the saved translations: no new translate call.
    const before = action('translate').length;
    await reopenFicha(); // a reload opens ATENDER AGORA (4d2e568); the ficha link reopens it
    await expect(page.locator('#lead-conversation .message-translation').first()).toBeVisible({ timeout: 60000 });
    expect(action('translate').length).toBe(before);

    // A message without a saved translation gets its own "traduzir" link, and the link translates it.
    await backend.db.query(`delete from public.message_translations where message_id = (select message_id from public.message_translations order by created_at limit 1)`);
    await reopenFicha(); // a reload opens ATENDER AGORA (4d2e568); the ficha link reopens it
    const one = page.locator('#lead-conversation button.translate-one');
    await expect(one.first()).toBeAttached({ timeout: 60000 });
    const translations = await page.locator('#lead-conversation .message-translation').count();
    const pendingBefore = await one.count();
    await page.locator('#lead-conversation article.lead-message').filter({ has: page.locator('button.translate-one') }).first().hover();
    await one.first().click();
    await expect(page.locator('#lead-conversation .message-translation')).toHaveCount(translations + 1, { timeout: 30000 });
    // Per message: the one translated loses its "traduzir"; the others keep theirs.
    await expect(page.locator('#lead-conversation button.translate-one')).toHaveCount(pendingBefore - 1);
    expect(action('translate').length).toBe(before + 1);

    // Portuguese conversation: nothing to translate.
    await page.goto(base + '/painel/#ficha/' + fixture.people.answered.journey, { waitUntil: 'domcontentloaded' });
    // (No "Traduzir conversa" bar since f3b05ee: a message in Portuguese simply has no "traduzir".)
    await expect(page.locator('#lead-conversation .lead-message').first()).toBeAttached({ timeout: 60000 });
    await page.waitForTimeout(1500);
    await expect(page.locator('#lead-conversation button.translate-one')).toHaveCount(0);
    await expect(page.locator('#lead-conversation .message-translation')).toHaveCount(0);

    expect(sendCalls(), 'nenhuma chamada de envio').toEqual([]);
    expect(errors).toEqual([]);
    expect(backend.refused).toEqual([]);
    expect(Number((await backend.db.query("select count(*) n from public.messages where source_kind='PANEL'")).rows[0].n)).toBe(0);
  });
}

async function openPanel(page, calls) {
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === 'wa.me') return route.abort();
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push({ path: url.pathname, method: request.method(), body: request.postData() || '' });
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) { const res = await run(handlers[url.pathname], request); return json(res.payload, res.statusCode); }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
}

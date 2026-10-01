'use strict';

// Sugestões de resposta e fila de conversas antigas no navegador real, com os handlers reais contra
// o banco PGlite e conversas fictícias. Nada é enviado: nenhuma chamada de envio (V1 ou resposta pelo
// painel) acontece durante o fluxo das sugestões. 1366 e 390 px.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/sugestoes.spec.js
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
  test(`${width} px · fila de conversas antigas, sugestões em inglês e espanhol, nada enviado`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    const calls = [];
    await openPanel(page, calls);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
    const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const sendCalls = () => calls.filter((call) => (call.path === '/api/panel/v1-send' && /"action":"(send|demo_send)"/.test(call.body)) || (call.path === '/api/panel/reply' && /"action":"send"/.test(call.body)));

    // CLIENTES → Retomar conversas antigas: oldest first, excluded with the reason.
    await page.locator('[data-view="clients"]').click();
    await page.locator('#clients-followup > summary').click();
    const list = page.locator('#clients-followup-list');
    const items = list.locator('.followup-item');
    await expect(items.first()).toBeVisible({ timeout: 60000 });
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Sofía Ejemplo');
    await expect(items.nth(1)).toContainText('Paulo Exemplo');
    await expect(items.nth(0)).toContainText('Janela de 24 h encerrada');
    await list.locator('.followup-excluded > summary').click();
    for (const text of ['O cliente pediu para não receber contato', 'Número de WhatsApp inválido ou ausente', 'Marcado como "não é lead"']) await expect(list.locator('.followup-excluded')).toContainText(text);
    await expect(list).not.toContainText('Rita Recente');

    // Spanish follow-up: translation, closed window, API blocked, manual path, editable, open WhatsApp.
    const sofia = items.nth(0);
    const make = sofia.getByRole('button', { name: 'Sugerir retomada' });
    await make.dblclick();
    const body = sofia.locator('.suggestion-body');
    await expect(body.locator('.suggestion-text')).toBeVisible({ timeout: 30000 });
    await expect(body).toContainText('Idioma do cliente: Espanhol');
    await expect(body).toContainText('Simulada · sem IA e sem custo');
    await expect(body).toContainText('Tradução da resposta para português');
    await expect(body).toContainText('Janela de 24 h encerrada');
    await expect(body).toContainText('envio pela API bloqueado');
    await expect(body).toContainText('você mesmo escreve e envia');
    expect(calls.filter((call) => call.path === '/api/panel/suggestions' && call.method === 'POST').length, 'clique duplo gera uma sugestão só').toBe(1);
    const textarea = body.locator('.suggestion-text');
    await textarea.fill('Hola Sofía, retomo lo del Corolla. ¿Sigues con el mismo presupuesto?');
    const open = body.locator('a.suggestion-open');
    await expect(open).toHaveAttribute('href', /^https:\/\/wa\.me\/13055550122\?text=Hola%20Sof%C3%ADa%2C%20retomo/);
    await expect(open).toHaveAttribute('target', '_blank');
    await noOverflow();
    await shot(page, `fila-retomada-${width}`);
    await body.getByRole('button', { name: 'Descartar' }).click();
    await expect(sofia.locator('.suggestion-body')).toContainText('Sugestão descartada · Nada foi enviado');

    // English reply inside the ficha's conversation: last message, translation, open window.
    await page.goto(base + '/painel/#ficha/' + fixture.people.english.journey, { waitUntil: 'domcontentloaded' });
    const card = page.locator('#lead-conversation .suggestion-card');
    await expect(card).toBeVisible({ timeout: 60000 });
    await card.getByRole('button', { name: 'Sugerir resposta' }).click();
    const reply = card.locator('.suggestion-body');
    await expect(reply.locator('.suggestion-text')).toBeVisible({ timeout: 30000 });
    for (const text of ['Idioma do cliente: Inglês', 'Última mensagem do cliente', 'Mileage under 60k please', 'Tradução para português', 'Janela de 24 h aberta', 'Para Ethan Example · +13055550111']) await expect(reply).toContainText(text);
    await expect(reply.locator('.suggestion-facts li').first()).toBeVisible();
    await reply.getByRole('button', { name: 'Copiar' }).click();
    await expect(reply.locator('.suggestion-result')).toContainText('Nada foi enviado');
    await noOverflow();
    await shot(page, `ficha-sugestao-${width}`);

    // Opt-out: no suggestion, the reason is shown.
    await page.goto(base + '/painel/#ficha/' + fixture.people.optOut.journey, { waitUntil: 'domcontentloaded' });
    const blocked = page.locator('#lead-conversation .suggestion-card');
    await expect(blocked).toBeVisible({ timeout: 60000 });
    await blocked.getByRole('button', { name: /Sugerir/ }).click();
    await expect(blocked.locator('.status')).toContainText('O cliente pediu para não receber contato', { timeout: 30000 });

    expect(sendCalls(), 'nenhuma chamada de envio durante as sugestões').toEqual([]);
    expect(errors).toEqual([]);
    expect(backend.refused).toEqual([]);
    const sent = (await backend.db.query("select count(*) n from public.messages where source_kind='PANEL'")).rows[0].n;
    expect(Number(sent)).toBe(0);
  });
}

test('V1 · confirmação mostra a janela e o caminho permitido (exemplo fictício, nada enviado)', async ({ page }) => {
  const calls = [];
  await openPanel(page, calls);
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  const demo = page.locator('#v1-demo');
  await expect(demo).toBeVisible({ timeout: 60000 });
  const openCard = demo.locator('.v1-demo-card').nth(0), closedCard = demo.locator('.v1-demo-card').nth(1);
  await expect(openCard.locator('.v1-send > button')).toBeEnabled({ timeout: 30000 });
  await openCard.locator('.v1-send > button').click();
  const confirmOpen = openCard.locator('.v1-send-confirm');
  for (const text of ['Cliente Fictício (teste)', '+15550100100', 'Link V1:', 'Janela de 24 h aberta', 'uma mensagem para esta pessoa']) await expect(confirmOpen).toContainText(text);
  await expect(confirmOpen.locator('textarea')).toHaveValue(/^Hi Cliente,\n\nI put together a first look/);
  await confirmOpen.getByRole('button', { name: 'Cancelar' }).click();
  await closedCard.locator('.v1-send > button').click();
  const confirmClosed = closedCard.locator('.v1-send-confirm');
  await expect(confirmClosed).toContainText('Janela de 24 h encerrada');
  await expect(confirmClosed).toContainText('o projeto não tem nenhum');
  await expect(confirmClosed).toContainText('você envia pelo WhatsApp Business do celular');
  await confirmClosed.getByRole('button', { name: 'Cancelar' }).click();
  expect(calls.filter((call) => /"action":"(send|demo_send)"/.test(call.body))).toEqual([]);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'v1-confirmacao.png'), fullPage: false });
});

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

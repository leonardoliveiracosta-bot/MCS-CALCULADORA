'use strict';

// Sessão que não cai ao sair da aba (/api/** e o Supabase simulados; nada é gravado ou enviado):
//  * Caminho comum: com o token válido, o painel abre direto, sem renovar e sem pedir senha; o formulário de
//    entrada é o mesmo (e-mail, senha, Entrar), com "Manter conectado" já marcado.
//  * Entrar sem mexer em nada guarda a sessão no aparelho: outra aba (ou o app reaberto) abre logado.
//  * Duas abas: a que estava oculta usa os tokens que a outra renovou; o Supabase nunca recebe o mesmo
//    refresh token duas vezes (reuso derruba a sessão).
//  * Voltar à aba com a rede acordando: a renovação falha (503) e a sessão fica guardada.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/sessao-persistente.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const TODAY = { items: [], meta: { dataUpdatedAt: new Date().toISOString() } };

// auth: the simulated Supabase. Each refresh token works once (as in production: reuse is refused).
function simulatedAuth() {
  const state = { current: 'r1', serial: 1, refreshes: [], passwords: 0, failNext: 0 };
  state.handle = async (route, url) => {
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.searchParams.get('grant_type') === 'password') { state.passwords += 1; state.serial += 1; state.current = 'r' + state.serial; return json({ access_token: 'token-' + state.serial, refresh_token: state.current, expires_in: 3600 }); }
    const body = JSON.parse(route.request().postData() || '{}');
    state.refreshes.push(body.refresh_token);
    if (state.failNext > 0) { state.failNext -= 1; return json({ message: 'unavailable' }, 503); }
    if (body.refresh_token !== state.current) return json({ error: 'invalid_grant', error_code: 'refresh_token_already_used' }, 400);
    state.serial += 1; state.current = 'r' + state.serial;
    return json({ access_token: 'token-' + state.serial, refresh_token: state.current, expires_in: 3600 });
  };
  return state;
}

// revoked: access tokens the API refuses with 401 (an expired one).
async function preparePage(page, auth, revoked = new Set()) {
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname.startsWith('/supabase-simulado/auth/v1/token')) return auth.handle(route, url);
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    const token = String(route.request().headers().authorization || '').replace('Bearer ', '');
    if (revoked.has(token)) return json({ error: 'UNAUTHORIZED' }, 401);
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') return json(TODAY);
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], demands: [], meta: {} });
  });
}
const seed = (page, session) => page.addInitScript((value) => { if (!localStorage.getItem('mcs_panel_session')) localStorage.setItem('mcs_panel_session', JSON.stringify(value)); }, session);
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mcs_panel_session') || 'null'));

test('caminho comum: token válido abre direto, sem renovar e sem senha; formulário igual, "Manter conectado" marcado', async ({ page }) => {
  const auth = simulatedAuth();
  await preparePage(page, auth);
  await seed(page, { accessToken: 'token-1', refreshToken: 'r1', accessExpiresAt: Date.now() + 3600000 });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  expect(auth.refreshes).toEqual([]);
  expect(auth.passwords).toBe(0);
  // The login form keeps its three fields and one button; only the box comes checked.
  const form = page.locator('#login-form');
  await expect(form.locator('input')).toHaveCount(3);
  await expect(form.locator('button')).toHaveCount(1);
  await expect(page.locator('#remember-login')).toBeChecked();
});

test('entrar sem mexer em nada: outra aba e o app reaberto continuam logados', async ({ context }) => {
  const auth = simulatedAuth();
  const first = await context.newPage();
  await preparePage(first, auth);
  await first.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(first.locator('#login-view')).toBeVisible();
  await first.locator('#email').fill('teste@example.test');
  await first.locator('#password').fill('senha-de-teste');
  await first.locator('#login-form button[type="submit"]').click();
  await expect(first.locator('#app-view')).toBeVisible({ timeout: 30000 });
  expect(await saved(first)).not.toBeNull();
  // A new browsing context of the same device (new tab, home-screen app, link from a notification).
  const second = await context.newPage();
  await preparePage(second, auth);
  await second.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(second.locator('#app-view')).toBeVisible({ timeout: 30000 });
  await expect(second.locator('#login-view')).toBeHidden();
  expect(auth.passwords).toBe(1);
});

test('duas abas: a oculta usa o token que a outra renovou; nenhum refresh token é usado duas vezes', async ({ context }) => {
  const auth = simulatedAuth();
  const revoked = new Set();
  const session = { accessToken: 'token-1', refreshToken: 'r1', accessExpiresAt: Date.now() + 3600000 };
  const hidden = await context.newPage();
  await preparePage(hidden, auth, revoked);
  await seed(hidden, session);
  await hidden.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(hidden.locator('#app-view')).toBeVisible({ timeout: 30000 });
  const active = await context.newPage();
  await preparePage(active, auth, revoked);
  await active.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(active.locator('#app-view')).toBeVisible({ timeout: 30000 });
  // The active tab renews (r1 → r2); token-1 stops working.
  expect(await active.evaluate(() => window.MCSPanelAuth.refresh())).toBe(true);
  revoked.add('token-1');
  // Back to the hidden tab: its next request must not reuse r1.
  const answer = await hidden.evaluate(async () => {
    const session = JSON.parse(localStorage.getItem('mcs_panel_session'));
    const response = await fetch('/api/panel/today', { headers: { Authorization: 'Bearer ' + session.accessToken } });
    return { status: response.status, ok: await window.MCSPanelAuth.refresh() };
  });
  expect(answer.status).toBe(200);
  expect(answer.ok).toBe(true);
  // Each refresh token reached the server once; the session is still saved and both tabs stay in.
  expect(auth.refreshes.length).toBe(new Set(auth.refreshes).size);
  expect(auth.refreshes).not.toContain(undefined);
  expect(await saved(hidden)).not.toBeNull();
  await expect(hidden.locator('#app-view')).toBeVisible();
  await expect(hidden.locator('#login-view')).toBeHidden();
});

test('tab oculta sem aviso do navegador: o token renovado pela outra aba é usado antes do próprio', async ({ context }) => {
  const auth = simulatedAuth();
  const hidden = await context.newPage();
  await preparePage(hidden, auth);
  await seed(hidden, { accessToken: 'token-1', refreshToken: 'r1', accessExpiresAt: Date.now() + 3600000 });
  await hidden.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(hidden.locator('#app-view')).toBeVisible({ timeout: 30000 });
  // r2 saved in this browser while this tab still holds r1 in memory (no storage event reaches the tab that
  // writes, the same as a tab that missed the other tab's event).
  auth.current = 'r2'; auth.serial = 2;
  await hidden.evaluate(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-2', refreshToken: 'r2', accessExpiresAt: Date.now() - 1000 })));
  expect(await hidden.evaluate(() => window.MCSPanelAuth.refresh())).toBe(true);
  // It renewed with r2 (the saved one), never with the r1 it had in memory.
  expect(auth.refreshes).toEqual(['r2']);
  expect((await saved(hidden)).refreshToken).toBe('r3');
});

test('voltar à aba com a rede acordando: a renovação falha e a sessão continua guardada', async ({ page }) => {
  const auth = simulatedAuth();
  auth.failNext = 1;
  await preparePage(page, auth);
  await seed(page, { accessToken: 'token-1', refreshToken: 'r1', accessExpiresAt: Date.now() - 1000 });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#login-view')).toBeHidden();
  expect(auth.refreshes[0]).toBe('r1');
  const stored = await saved(page);
  expect(stored).not.toBeNull();
  expect(stored.refreshToken).toMatch(/^r\d+$/);
});

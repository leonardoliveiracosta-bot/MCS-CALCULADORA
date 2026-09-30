'use strict';

// Login, contadores e várias abas no navegador real, com /api/** simulado (nada é gravado ou enviado):
//  * Entrar: "Entrando…" enquanto o Supabase e a sessão respondem; falha da sessão mostra erro claro
//    e "Tentar novamente"; tempo esgotado também; nunca um botão sem resposta.
//  * Contadores: "—" durante o carregamento, nunca zero; falha em BUSCAS não mexe nos outros e
//    mantém o último valor confirmado, com aviso e "Tentar novamente".
//  * Três abas, duas ocultas: só a visível faz a atualização automática; ao trocar, outra assume;
//    nenhuma atualização sobreposta da mesma tela.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/abas-login.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.ABAS_SHOTS || '';
test.setTimeout(120000);

const TODAY = { items: [{ ref: 'AAAA2', key: 'AAAA2', pending: true, contactName: 'Cliente Hoje', simulations: [] }], meta: { dataUpdatedAt: new Date().toISOString() } };
const RECORDS = { items: [], meta: {} };
const SEARCHES = { items: [{ key: 'j1:VALOR', journeyId: 'j1', mode: 'VALOR' }, { key: 'j2:CARRO', journeyId: 'j2', mode: 'CARRO' }], countsByMode: {} };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// visibility: the state this tab starts in; api: overrides per path.
async function preparePage(page, options = {}) {
  await page.addInitScript(({ visibility, refreshMs, sessionTimeout, loggedIn }) => {
    let state = visibility;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return state; } });
    Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get() { return state === 'hidden'; } });
    window.__setVisibility = (next) => { state = next; document.dispatchEvent(new Event('visibilitychange')); };
    if (refreshMs) window.MCS_REFRESH_MS = refreshMs;
    if (sessionTimeout) window.MCS_SESSION_TIMEOUT_MS = sessionTimeout;
    if (loggedIn) localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
  }, { visibility: options.visibility || 'visible', refreshMs: options.refreshMs || 0, sessionTimeout: options.sessionTimeout || 0, loggedIn: options.loggedIn !== false });
  const log = [];
  const inflight = new Map();
  let peak = 0;
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname.startsWith('/supabase-simulado/auth/v1/token')) {
      if (options.authDelay) await sleep(options.authDelay);
      return json({ access_token: 'token-novo', refresh_token: 'refresh-novo', expires_in: 3600 });
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const key = url.pathname + url.search;
    log.push({ path: url.pathname, search: url.search, at: Date.now() });
    inflight.set(url.pathname, (inflight.get(url.pathname) || 0) + 1);
    peak = Math.max(peak, inflight.get('/api/panel/today') || 0);
    try {
      const custom = options.api && options.api[url.pathname];
      if (custom) { const answer = await custom({ url, key }); if (answer === 'HANG') { await sleep(60000); return route.abort().catch(() => {}); } return await json(answer.body, answer.status || 200); }
      if (url.pathname === '/api/panel/config') return await json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
      if (url.pathname === '/api/panel/session') return await json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
      if (url.pathname === '/api/panel/today') { if (options.slowToday) await sleep(options.slowToday); return await json(TODAY); }
      if (url.pathname === '/api/panel/records') return await json(RECORDS);
      if (url.pathname === '/api/panel/searches') return await json(SEARCHES);
      return await json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
    } finally { inflight.set(url.pathname, (inflight.get(url.pathname) || 1) - 1); }
  });
  return { log, peak: () => peak };
}

test('Entrar: "Entrando…" enquanto o painel responde, depois abre', async ({ page }) => {
  let releaseSession;
  const sessionGate = new Promise((resolve) => { releaseSession = resolve; });
  await preparePage(page, { loggedIn: false, authDelay: 300, api: { '/api/panel/session': async () => { await sessionGate; return { body: { email: 'teste@example.test', role: 'admin', mustChangePassword: false } }; } } });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('#email').fill('teste@example.test');
  await page.locator('#password').fill('senha-de-teste-123');
  const button = page.locator('#login-form button[type="submit"]');
  await button.click();
  await expect(button).toHaveText('Entrando…');
  await expect(button).toBeDisabled();
  // Supabase already answered; the session is still being confirmed: the button keeps answering.
  await sleep(1500);
  await expect(button).toHaveText('Entrando…');
  if (SHOTS) await page.locator('#login-view').screenshot({ path: path.join(SHOTS, 'login-entrando.png') });
  releaseSession();
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(button).toHaveText('Entrar');
});

test('sessão falha: erro claro e "Tentar novamente" recupera; tempo esgotado também avisa', async ({ page }) => {
  let failing = true;
  await preparePage(page, { sessionTimeout: 1500, api: { '/api/panel/session': async () => failing === 'hang' ? 'HANG' : failing ? { status: 500, body: { error: 'PANEL_SESSION_ERROR' } } : { body: { email: 'teste@example.test', role: 'admin', mustChangePassword: false } } } });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#login-error')).toHaveText('Não consegui confirmar a sessão agora · Tente de novo em instantes');
  const retry = page.locator('#login-retry');
  await expect(retry).toBeVisible();
  if (SHOTS) await page.locator('#login-view').screenshot({ path: path.join(SHOTS, 'login-sessao-falhou.png') });
  // Timeout: the check has its own limit and says so.
  failing = 'hang';
  await retry.click();
  await expect(page.locator('#login-error')).toHaveText('O painel demorou para responder · Sua senha está certa; tente de novo em instantes', { timeout: 10000 });
  failing = false;
  await retry.click();
  await expect(page.locator('#app-view')).toBeVisible();
  await expect(retry).toBeHidden();
});

test('contadores: "—" durante o carregamento; falha em BUSCAS não zera nada e mantém o último valor', async ({ page }) => {
  let recordsGate, searchesFail = false;
  const gate = new Promise((resolve) => { recordsGate = resolve; });
  await preparePage(page, { api: {
    '/api/panel/records': async () => { await gate; return { body: RECORDS }; },
    '/api/panel/searches': async () => searchesFail ? { status: 500, body: { error: 'PANEL_SEARCHES_ERROR' } } : { body: SEARCHES }
  } });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible();
  // While CLIENTES is loading its badge shows "—", never 0.
  await expect(page.locator('.tab[data-view="clients"] [data-count]')).toHaveText('—');
  if (SHOTS) await page.locator('nav').screenshot({ path: path.join(SHOTS, 'contadores-carregando.png') });
  recordsGate();
  await expect(page.locator('.tab[data-view="clients"] [data-count]')).toHaveText('0');
  await expect(page.locator('.tab[data-view="searches"] [data-count]')).toHaveText('2');
  await expect(page.locator('.tab[data-view="today"] [data-count]')).toHaveText('1');
  // BUSCAS fails on the next update: it keeps 2 (marked), HOJE and CLIENTES are not touched.
  searchesFail = true;
  await page.waitForTimeout(10500); // the counters reuse answers of the last 10 s
  // Next counters update (the same one an action triggers).
  await page.evaluate(() => window.__mcsRefresh.counters());
  await expect(page.locator('#counters-note')).toContainText('Não foi possível atualizar', { timeout: 15000 });
  await expect(page.locator('.tab[data-view="searches"] [data-count]')).toHaveText('2');
  await expect(page.locator('.tab[data-view="searches"] [data-count]')).toHaveClass(/count-stale/);
  await expect(page.locator('.tab[data-view="today"] [data-count]')).toHaveText('1');
  await expect(page.locator('.tab[data-view="today"] [data-count]')).not.toHaveClass(/count-stale/);
  await expect(page.locator('#counters-note button')).toHaveText('Tentar novamente');
  if (SHOTS) await page.locator('.freshness').screenshot({ path: path.join(SHOTS, 'contadores-falha-buscas.png') });
  searchesFail = false;
  await page.locator('#counters-note button').click();
  await expect(page.locator('#counters-note')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('.tab[data-view="searches"] [data-count]')).not.toHaveClass(/count-stale/);
});

test('três abas, duas ocultas: só a visível atualiza; ao trocar, outra assume; nada sobreposto', async ({ browser }) => {
  const context = await browser.newContext();
  const pages = await Promise.all([0, 1, 2].map(() => context.newPage()));
  const visibility = ['visible', 'hidden', 'hidden'];
  const logs = [];
  for (let index = 0; index < 3; index += 1) logs.push(await preparePage(pages[index], { visibility: visibility[index], refreshMs: 1000, slowToday: 1600 }));
  for (const page of pages) await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  for (const page of pages) await expect(page.locator('#app-view')).toBeVisible();
  await sleep(2500); // boot loads (opening a tab is an operator action) settle
  const auto = (log, from) => log.filter((entry) => entry.path === '/api/panel/today' && entry.search.startsWith('?sort=') && entry.at >= from).length;
  const window1 = Date.now();
  await sleep(9000);
  const counts = logs.map(({ log }) => auto(log, window1));
  expect(counts[1], 'aba oculta B não consulta').toBe(0);
  expect(counts[2], 'aba oculta C não consulta').toBe(0);
  expect(counts[0], `aba visível: ${counts[0]}`).toBeGreaterThanOrEqual(3);
  // Slow answers (1.6 s) with a 1 s interval: still one at a time.
  expect(logs[0].peak()).toBe(1);
  // A goes to the background, C comes to the front: C takes over, A stops.
  await pages[2].evaluate(() => window.__setVisibility('visible'));
  await pages[0].evaluate(() => window.__setVisibility('hidden'));
  await sleep(1500);
  const window2 = Date.now();
  await sleep(8000);
  const after = logs.map(({ log }) => auto(log, window2));
  expect(after[0], 'a antiga líder parou').toBe(0);
  expect(after[1]).toBe(0);
  expect(after[2], `C assumiu: ${after[2]}`).toBeGreaterThanOrEqual(3);
  // Three tabs never triple the queries: the total equals one tab's worth.
  expect(after[0] + after[1] + after[2]).toBe(after[2]);
  console.log('Consultas automáticas por aba (9 s e 8 s):', JSON.stringify({ antes: counts, depois: after }));
  await context.close();
});

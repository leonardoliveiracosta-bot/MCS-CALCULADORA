'use strict';

// #276 + #277 juntos, no navegador real com os handlers reais contra o banco simulado (todas as migrações):
//  - atualização automática com a ficha aberta: a mensagem nova aparece, o rascunho da resposta e a anotação digitada ficam
//  - salvar e trocar de aba antes da resposta: a ficha antiga não reabre por cima da aba escolhida
//  - atualização automática na lista rolada com um caso novo no topo: os casos não somem e o caso de cima não sai do lugar
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/integracao-navegacao.spec.js
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(150000);

const id = (n) => `6f400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const CASES = 24, FIRST = id(100);
const ficha = (n, hoursAgo) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(n + 1)}','preview','Cliente ${n}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(n)}','preview','${id(n + 1)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now() - interval '3 days',now());`,
  `insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,confirmed_at,created_at) values('preview','${id(n + 1)}','+1305555${String(n).padStart(4, '0')}','+1305555${String(n).padStart(4, '0')}',true,true,now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(n + 2)}','preview','WHATSAPP','${id(n + 1)}','nav-${n}','RESOLVED',false,now(),now(),now(),now());`,
  message(n, n + 3, `Quero um carro (${n})`, hoursAgo)
].join('\n');
function message(n, mid, body, hoursAgo) {
  return `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(mid)}','preview','${id(n + 2)}','WHATSAPP','CUSTOMER','${body}','${body.toLowerCase()}',now() - interval '${hoursAgo} hours','nav-${mid}',1,'WHATSAPP_WEBHOOK',now());
insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(mid)}','${id(n)}','IMPORT',now());`;
}
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...Array.from({ length: CASES }, (_, index) => ficha(100 + index * 10, 2 + index))
].join('\n');

let backend;
const handlers = {}, delays = {};
async function call(handler, request) {
  const url = new URL(request.url());
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  await handler({ method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined }, res);
  return res;
}
test.beforeAll(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AUTO_REPLY_ENABLED']) delete process.env[key];
  globalThis.fetch = backend.fetch;
  for (const name of ['session', 'today', 'lead', 'records', 'entry', 'triage', 'whatsapp', 'pendencias', 'client-context', 'reply', 'boot']) handlers['/api/panel/' + name] = require('../api/panel/' + name);
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

async function start(page) {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    const wait = delays[request.method() + ' ' + url.pathname];
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (handlers[url.pathname]) { const res = await call(handlers[url.pathname], request); return json(res.payload, res.statusCode); }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator(`#today-list .attend-row[data-journey-id="${FIRST}"]`)).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#today-list .attend-row')).toHaveCount(CASES, { timeout: 30000 });
  await page.waitForFunction(() => window.__mcsRefresh && window.__mcsRefresh.scheduler, null, { timeout: 30000 });
  return errors;
}
const runRefresh = (page) => page.evaluate(() => window.__mcsRefresh.scheduler.runNow());

test('ficha aberta: atualização automática traz a mensagem nova e não apaga o rascunho nem a anotação digitada', async ({ page }) => {
  const errors = await start(page);
  await page.locator(`#today-list .attend-row[data-journey-id="${FIRST}"] .attend-channel`).click();
  const detail = page.locator('#record-detail');
  const draft = detail.getByRole('textbox', { name: 'O que você quer transmitir' });
  await expect(draft).toBeVisible({ timeout: 30000 });
  await draft.fill('Rascunho que não pode sumir');
  await detail.locator('.lead-quick-actions').getByRole('button', { name: 'Anotações' }).click();
  await detail.locator('.lead-quick-note-text').fill('Anotação ainda não inserida');
  await backend.db.exec(message(100, 99, 'Mensagem nova chegou agora', 0));
  await runRefresh(page);
  await expect(detail.locator('.lead-thread')).toContainText('Mensagem nova chegou agora', { timeout: 30000 });
  await expect(draft).toHaveValue('Rascunho que não pode sumir');
  await expect(detail.locator('.lead-quick-note-text')).toHaveValue('Anotação ainda não inserida');
  await expect(page.locator('#detail-panel')).toBeVisible();
  expect(errors).toEqual([]);
});

test('salvar e trocar de aba antes da resposta: a ficha antiga não reabre por cima', async ({ page }) => {
  const errors = await start(page);
  const second = id(110);
  await page.locator(`#today-list .attend-row[data-journey-id="${second}"] .attend-channel`).click();
  const detail = page.locator('#record-detail');
  await expect(detail.locator('.lead-quick')).toBeVisible({ timeout: 30000 });
  await detail.locator('.lead-quick-actions').getByRole('button', { name: 'Anotações' }).click();
  await detail.locator('.lead-quick-note-text').fill('Salvando devagar');
  delays['POST /api/panel/lead'] = 3000;
  await detail.getByRole('button', { name: 'Inserir' }).click();
  await page.locator('.tab[data-view="v1"]').click();
  await expect(page.locator('.tab[data-view="v1"]')).toHaveClass(/active/);
  await page.waitForTimeout(6000);
  delete delays['POST /api/panel/lead'];
  await expect(page.locator('#detail-panel')).toBeHidden();
  await expect(page.locator('.tab[data-view="v1"]')).toHaveClass(/active/);
  const saved = (await backend.db.query(`select count(*)::int n from public.lead_notes where journey_id='${second}' and body_text='Salvando devagar'`)).rows[0].n;
  expect(saved).toBe(1);
  expect(errors).toEqual([]);
});

test('lista rolada: atualização automática com caso novo no topo não some com casos nem tira o caso de cima do lugar', async ({ page }) => {
  const errors = await start(page);
  await page.evaluate(() => window.scrollTo(0, 600));
  await page.waitForTimeout(300);
  const before = await page.evaluate(() => { const row = [...document.querySelectorAll('#today-list .attend-row')].find((node) => node.getBoundingClientRect().bottom > 0); return { key: row.dataset.caseKey, top: row.getBoundingClientRect().top }; });
  await backend.db.exec(ficha(900, 0));
  await runRefresh(page);
  await expect(page.locator('#today-list .attend-row')).toHaveCount(CASES + 1, { timeout: 30000 });
  await page.waitForTimeout(500);
  const after = await page.evaluate((key) => { const row = [...document.querySelectorAll('#today-list .attend-row')].find((node) => node.dataset.caseKey === key); return row ? row.getBoundingClientRect().top : null; }, before.key);
  expect(after).not.toBeNull();
  expect(Math.abs(after - before.top)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

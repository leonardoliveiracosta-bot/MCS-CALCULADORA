'use strict';

// Ficha · o nome escrito na calculadora diferente do nome da ficha é só informação no cabeçalho ("Nome na calculadora"),
// sem "Confirmar vínculo". Caso real 4NRJ5: Alic na calculadora, Mirzet no WhatsApp. Caminho comum (mesmo nome): nenhuma
// linha a mais. No navegador real, com os handlers reais contra o banco simulado (todas as migrações).
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/nome-calculadora.spec.js
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `6e300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OTHER = id(10), SAME = id(20);
const run = (ref, nome) => `insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados) values(now() - interval '1 hour','49512','MI',30000,'cash','${JSON.stringify({ quando: new Date().toISOString(), sid: 's-' + ref, ref, evento: 'whatsapp', logical_mode: 'VALOR', marca: 'Porsche', modelo: 'Cayenne', lance: 30000, nome })}');`;
const ficha = (n, name, ref, phone) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(n + 1)}','preview','${name}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${id(n)}','preview','${id(n + 1)}','${ref}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now() - interval '2 hours',now());`,
  `insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,confirmed_at,created_at) values('preview','${id(n + 1)}','${phone}','${phone}',true,true,now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(n + 2)}','preview','WHATSAPP','${id(n + 1)}','nome-${n}','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n + 3)}','preview','${id(n + 2)}','WHATSAPP','CUSTOMER','Ref: ${ref}','ref: ${ref.toLowerCase()}',now() - interval '1 hour','nome-${n}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(n + 3)}','${id(n)}','CALC_ROUTE',now());`
];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  ...ficha(10, 'Mirzet', '4NRJ5', '+16166344376'), run('4NRJ5', 'Alic'),
  ...ficha(20, 'Ana Souza', 'QWRT7', '+13055550177'), run('QWRT7', 'Ana Souza')
].join('\n');

let backend;
const handlers = {};
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
  for (const name of ['session', 'today', 'lead', 'records', 'entry', 'triage', 'whatsapp', 'pendencias', 'client-context']) handlers['/api/panel/' + name] = require('../api/panel/' + name);
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

async function openFicha(page, journeyId) {
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (handlers[url.pathname]) { const res = await call(handlers[url.pathname], request); return json(res.payload, res.statusCode); }
    return json({ items: [], orders: [], groups: [], chats: [], reviews: [], requests: [], review: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  const row = page.locator(`#today-list .attend-row[data-journey-id="${journeyId}"]`).first();
  await expect(row).toBeVisible({ timeout: 30000 });
  await row.locator('.attend-channel').click();
  const identity = page.locator('#record-detail .lead-head-name');
  await expect(identity).toBeVisible({ timeout: 30000 });
  return identity;
}

test('nome diferente na calculadora (4NRJ5): ficha mostra "Nome na calculadora: Alic", sem Confirmar vínculo', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const identity = await openFicha(page, OTHER);
  await expect(identity.locator('h2')).toContainText('Mirzet — Ref 4NRJ5');
  await expect(identity.locator('.lead-calc-name')).toHaveText('Nome na calculadora: Alic');
  await expect(page.locator('body')).not.toContainText('Confirmar vínculo');
  expect(errors).toEqual([]);
});

test('caminho comum: mesmo nome na calculadora e na ficha, nenhuma linha a mais', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const identity = await openFicha(page, SAME);
  await expect(identity.locator('h2')).toContainText('Ana Souza — Ref QWRT7');
  await expect(identity.locator('.lead-calc-name')).toHaveCount(0);
  expect(errors).toEqual([]);
});

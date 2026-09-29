'use strict';

// "Carro ou faixa" por modo no navegador, com os handlers reais do painel (api/panel/records.js e
// api/panel/actions.js) rodando contra um banco PGlite local com todas as migrações. Nada sai da
// máquina: Supabase, Anthropic, OpenAI e WhatsApp são recusados e a recusa é registrada.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/marcacao-modo.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.MODO_SHOTS || '';
test.setTimeout(120000);

const ACTOR = '68000000-0000-4000-8000-000000000001';
const TWO = '68000000-0000-4000-8000-000000000010';
const ONE = '68000000-0000-4000-8000-000000000020';
const MSG = { carro: '68000000-0000-4000-8000-000000000091', valor: '68000000-0000-4000-8000-000000000092', semModo: '68000000-0000-4000-8000-000000000093', unico: '68000000-0000-4000-8000-000000000094' };

const seed = `
insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);
insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values
  ('68000000-0000-4000-8000-000000000011','preview','Cliente Dois Modos','WHATSAPP_DIRECT',now(),now()),
  ('68000000-0000-4000-8000-000000000021','preview','Cliente Sem Modo','WHATSAPP_DIRECT',now(),now());
insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,vehicle_text,created_at,updated_at) values
  ('${TWO}','preview','68000000-0000-4000-8000-000000000011','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{"logical_modes":["CARRO","VALOR"]}',null,now(),now()),
  ('${ONE}','preview','68000000-0000-4000-8000-000000000021','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{"wishlists":[{"make":"Kia","model":"Soul"}]}','Kia Soul',now(),now());
insert into public.journey_checklist(environment,journey_id,point_number,point_label,status,created_at,updated_at)
  select 'preview', j, n, 'Ponto '||n, 'OPEN', now(), now() from (values ('${TWO}'::uuid),('${ONE}'::uuid)) v(j), generate_series(1,6) n;
insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values
  ('68000000-0000-4000-8000-000000000031','preview','WHATSAPP','68000000-0000-4000-8000-000000000011','sim-1','RESOLVED',false,now(),now(),now(),now()),
  ('68000000-0000-4000-8000-000000000032','preview','WHATSAPP','68000000-0000-4000-8000-000000000021','sim-2','RESOLVED',false,now(),now(),now(),now());
insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values
  ('${MSG.carro}','preview','68000000-0000-4000-8000-000000000031','WHATSAPP','CUSTOMER','Quero um Scion tC de 2012 a 2014','quero um scion tc',now()-interval '30 minutes','s1',1,'IMPORT',now()),
  ('${MSG.valor}','preview','68000000-0000-4000-8000-000000000031','WHATSAPP','CUSTOMER','Meu lance vai até 20 mil num Saab 9-3','meu lance saab',now()-interval '20 minutes','s2',1,'IMPORT',now()),
  ('${MSG.semModo}','preview','68000000-0000-4000-8000-000000000031','WHATSAPP','CUSTOMER','Pode ser qualquer um desses dois','pode ser qualquer um',now()-interval '10 minutes','s3',1,'IMPORT',now()),
  ('${MSG.unico}','preview','68000000-0000-4000-8000-000000000032','WHATSAPP','CUSTOMER','Quero um Honda Civic','quero um honda civic',now()-interval '5 minutes','s4',1,'IMPORT',now());
insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values
  ('preview','${MSG.carro}','${TWO}','IMPORT',now()),('preview','${MSG.valor}','${TWO}','IMPORT',now()),('preview','${MSG.semModo}','${TWO}','IMPORT',now()),('preview','${MSG.unico}','${ONE}','IMPORT',now());
`;

let backend, handlers;
test.beforeAll(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: BASE, SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
  delete process.env.ANTHROPIC_API_KEY; delete process.env.OPENAI_API_KEY;
  globalThis.fetch = backend.fetch;
  handlers = { '/api/panel/records': require('../api/panel/records'), '/api/panel/actions': require('../api/panel/actions'), '/api/panel/lead': require('../api/panel/lead'), '/api/panel/messages': require('../api/panel/messages') };
});
test.afterAll(async () => { if (backend) await backend.db.close(); });

async function run(handler, request) {
  const url = new URL(request.url());
  const res = { statusCode: 200, headers: {}, payload: null, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() { return null; } };
  const req = { method: request.method(), url: url.pathname + url.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(url.searchParams), body: request.postData() ? JSON.parse(request.postData()) : undefined };
  await handler(req, res);
  if (res.statusCode >= 400 && process.env.MODO_DEBUG) console.log('HANDLER', url.pathname, res.statusCode, JSON.stringify(res.payload));
  return res;
}

async function openPanel(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-simulado', refreshToken: 'refresh', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-simulada' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (handlers[url.pathname]) { const res = await run(handlers[url.pathname], request); return json(res.payload, res.statusCode); }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], requests: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
}

async function openFicha(page, name) {
  await page.locator('[data-view="clients"]').click();
  await page.locator('#clients-list').getByText(name, { exact: true }).first().click();
  await expect(page.locator('#record-detail')).toContainText(name, { timeout: 30000 });
  await expect(page.locator('#record-detail details.message-menu').first()).toBeAttached({ timeout: 30000 });
}

async function mark(page, text, { make, model, yearMin, yearMax, minMiles, maxMiles, mode }) {
  const message = page.locator('#record-detail article.lead-message').filter({ hasText: text }).last();
  const menu = message.locator('details.message-menu');
  await menu.locator('summary').click();
  const row = menu.locator('.wishlist-row').first();
  await row.locator('input[placeholder="Marca"]').fill(make);
  await row.locator('input[placeholder="Modelo"]').fill(model);
  if (yearMin) await row.locator('input[placeholder="Ano de"]').fill(String(yearMin));
  if (yearMax) await row.locator('input[placeholder="Ano até"]').fill(String(yearMax));
  if (minMiles) await row.locator('input[placeholder="Milhas de"]').fill(String(minMiles));
  if (maxMiles) await row.locator('input[placeholder="Milhas até"]').fill(String(maxMiles));
  if (mode !== undefined) await menu.locator('select.wishlist-mode').selectOption(mode);
  const save = menu.getByRole('button', { name: 'Carro ou faixa' });
  // Existing desktop layout: the message menu is wider than the conversation column, whose left
  // part clips the start of the button. The operator clicks the visible end ("...faixa"); so does
  // the test (the clipping is reported separately, it is not part of this change).
  const box = await save.boundingBox();
  await save.click({ position: { x: box.width - 8, y: box.height / 2 } });
  return menu;
}

const journey = async (id) => (await backend.db.query('select criteria_json, vehicle_text from public.journeys where id=$1', [id])).rows[0];
const GENERIC = ['wishlist', 'wishlists', 'wishlistOverride', 'confirmedWishlists'];

test('ficha com dois modos: CARRO só em CARRO, VALOR só em VALOR, resumo dos dois e recusa sem modo', async ({ page }) => {
  await openPanel(page, Number(process.env.MODO_WIDTH || 1280));
  await openFicha(page, 'Cliente Dois Modos');

  await mark(page, 'Scion tC de 2012', { make: 'Scion', model: 'tC', yearMin: 2012, yearMax: 2014, minMiles: 1000, maxMiles: 90000, mode: 'CARRO' });
  await expect.poll(async () => (await journey(TWO)).criteria_json.mode_overrides?.CARRO?.wishlists?.[0]?.model).toBe('tC');
  let state = await journey(TWO);
  expect(state.criteria_json.mode_overrides.VALOR).toBeUndefined();
  expect(GENERIC.filter((key) => key in state.criteria_json)).toEqual([]);
  expect(state.vehicle_text).toBe('Por ano e milhagem: 2012–2014 Scion tC');

  await mark(page, 'Saab 9-3', { make: 'Saab', model: '9-3', mode: 'VALOR' });
  await expect.poll(async () => (await journey(TWO)).criteria_json.mode_overrides?.VALOR?.wishlists?.[0]?.model).toBe('9-3');
  state = await journey(TWO);
  expect(state.criteria_json.mode_overrides.CARRO.wishlists.map((wish) => wish.model)).toEqual(['tC']);
  expect(state.criteria_json.mode_overrides.VALOR.wishlists.map((wish) => wish.model)).toEqual(['9-3']);
  expect(GENERIC.filter((key) => key in state.criteria_json)).toEqual([]);
  expect(state.vehicle_text).toBe('Por valor: Saab 9-3 · Por ano e milhagem: 2012–2014 Scion tC');

  // Sem escolher a busca: recusado com a mensagem do painel e nada gravado.
  const before = { state: await journey(TWO), decl: (await backend.db.query('select count(*)::int n from public.journey_declarations')).rows[0].n, marks: (await backend.db.query('select count(*)::int n from public.message_fact_marks')).rows[0].n };
  const menu = await mark(page, 'qualquer um desses', { make: 'Saab', model: '9-3', mode: '' });
  await expect(menu).toContainText('escolha para qual é a mudança');
  expect(await journey(TWO)).toEqual(before.state);
  expect((await backend.db.query('select count(*)::int n from public.journey_declarations')).rows[0].n).toBe(before.decl);
  expect((await backend.db.query('select count(*)::int n from public.message_fact_marks')).rows[0].n).toBe(before.marks);
  if (SHOTS) await page.locator('#record-detail').screenshot({ path: path.join(SHOTS, `ficha-dois-modos-recusa-${page.viewportSize().width}.png`) });

  // O resumo aparece na lista de CLIENTES.
  await page.locator('[data-view="clients"]').click();
  const card = page.locator('#clients-list').locator('article, .item-card').filter({ hasText: 'Cliente Dois Modos' }).first();
  await expect(card).toContainText('Por valor: Saab 9-3 · Por ano e milhagem: 2012–2014 Scion tC');
  if (SHOTS) await card.screenshot({ path: path.join(SHOTS, `clientes-resumo-${page.viewportSize().width}.png`) });
  expect(backend.refused.filter((url) => /anthropic|openai|supabase\.co|graph\.facebook|360dialog/.test(url))).toEqual([]);
});

test('ficha sem modo: marcação sem modo continua como antes e 390 px sem rolagem lateral', async ({ page }) => {
  await openPanel(page, 390);
  await openFicha(page, 'Cliente Sem Modo');
  await mark(page, 'Honda Civic', { make: 'Honda', model: 'Civic' });
  await expect.poll(async () => (await journey(ONE)).criteria_json.wishlists?.[0]?.model).toBe('Civic');
  const state = await journey(ONE);
  expect(state.criteria_json.wishlist.wishlists[0].model).toBe('Civic');
  expect(state.criteria_json.wishlistOverride).toBe(true);
  expect(state.criteria_json.mode_overrides).toBeUndefined();
  expect(state.vehicle_text).toBe('Honda Civic');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS) await page.locator('#record-detail').screenshot({ path: path.join(SHOTS, 'ficha-sem-modo-390.png') });
  // Nothing outside this machine was ever called by the panel handlers.
  expect(backend.calls.every((call) => call.path.startsWith('/rest/v1/') || call.path === '/auth/v1/user')).toBe(true);
  expect(backend.refused).toEqual([]);
});

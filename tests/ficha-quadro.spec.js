'use strict';

// Ficha · cabeçalho da ligação com o Resultado rápido dentro (um cartão só) e a opção Anotações: escrever, Inserir e a
// anotação aparece ali mesmo. No navegador real, com os handlers reais contra o banco simulado (todas as migrações).
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/ficha-quadro.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
const SHOTS = process.env.PANEL_SHOTS_DIR || '';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `6d200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const JOURNEY = id(10);
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${id(1)}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(11)}','preview','Cliente Quadro','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,reference_code,source,stage,status,criteria_json,created_at,updated_at) values('${JOURNEY}','preview','${id(11)}','QD2CR','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now() - interval '2 days',now());`,
  `insert into public.contact_phones(environment,contact_id,phone_e164,phone_raw,is_current,is_primary,confirmed_at,created_at) values('preview','${id(11)}','+13055550177','+13055550177',true,true,now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(12)}','preview','WHATSAPP','${id(11)}','quadro-1','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(13)}','preview','${id(12)}','WHATSAPP','CUSTOMER','Quero um carro','x',now() - interval '5 hours','q1',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(13)}','${JOURNEY}','IMPORT',now());`
].join('\n');

let backend;
const handlers = {};
async function run(handler, request) {
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

for (const width of [1280, 390]) {
  test(`${width}px · Resultado rápido dentro do cabeçalho, Anotações insere ali mesmo e o TODOS mostra o resultado`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    await page.setViewportSize({ width, height: 900 });
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
    await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
    const row = page.locator(`#today-list .attend-row[data-journey-id="${JOURNEY}"]`);
    await expect(row.locator('.attend-wait')).toBeVisible({ timeout: 30000 });
    await row.locator('.attend-channel').click();
    const card = page.locator('#record-detail .lead-quick').locator('xpath=..');
    await expect(page.locator('#record-detail .lead-quick')).toBeVisible({ timeout: 30000 });
    // One card: the header (name, phone) and the result buttons are in the same section; no "RESULTADO RÁPIDO" section apart.
    await expect(card).toContainText('CABEÇALHO DA LIGAÇÃO');
    await expect(card.locator('.lead-call')).toHaveCount(1);
    await expect(page.locator('#record-detail')).not.toContainText('RESULTADO RÁPIDO');
    await expect(card.locator('.lead-quick-actions > button')).toHaveText(['Atendeu', 'Não atendeu', 'Conversa presencial', 'Vai pagar o depósito', 'Pediu para ligar depois', 'Anotações']);
    // Badges and "Não é lead" / "Excluir" on the same line (computer); the return date and the note open only when asked.
    if (width === 1280) {
      const [badgesBox, actionsBox] = await Promise.all([card.locator('.lead-head-meta > .lead-badges').boundingBox(), card.locator('.lead-head-actions').boundingBox()]);
      expect(Math.abs(badgesBox.y - actionsBox.y)).toBeLessThan(24);
    }
    await expect(card.locator('.lead-quick input[type="datetime-local"]')).toBeHidden();
    await expect(card.locator('.lead-quick-note-text')).toBeHidden();
    // The result buttons sit inside the header card, right under the badges (not further down the ficha).
    const boxes = await page.evaluate(() => { const quick = document.querySelector('#record-detail .lead-quick'); const head = quick.closest('section.lead-card'); const r = (node) => { const box = node.getBoundingClientRect(); return { top: Math.round(box.top), bottom: Math.round(box.bottom) }; }; return { head: r(head), quick: r(quick), label: head.querySelector('.lead-label').textContent, meta: r(head.querySelector('.lead-head-meta')) }; });
        expect(boxes.label).toBe('1 — CABEÇALHO DA LIGAÇÃO');
    expect(boxes.quick.top).toBeGreaterThanOrEqual(boxes.meta.bottom);
    expect(boxes.quick.bottom).toBeLessThanOrEqual(boxes.head.bottom);
    expect(boxes.quick.top - boxes.meta.bottom).toBeLessThan(40);
    if (SHOTS) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(SHOTS, `ficha-quadro-${width}.png`) }); }
    // Anotações: write, Inserir, and the note shows right there (saved; nothing else is touched).
    await card.getByRole('button', { name: 'Anotações' }).click();
    await card.locator('.lead-quick-note-text').fill(`Ligou pedindo SUV até 30 mil (${width})`);
    await card.getByRole('button', { name: 'Inserir' }).click();
    await expect(page.locator('#record-detail .lead-quick-notes')).toContainText(`Ligou pedindo SUV até 30 mil (${width})`, { timeout: 30000 });
    const saved = (await backend.db.query(`select body_text from public.lead_notes where journey_id='${JOURNEY}' order by created_at`).catch(() => ({ rows: null }))).rows;
    if (saved) expect(saved.map((one) => one.body_text)).toContain(`Ligou pedindo SUV até 30 mil (${width})`);
    if (SHOTS) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: path.join(SHOTS, `ficha-quadro-nota-${width}.png`) }); }
    // "Pediu para ligar depois" opens the date; Atendeu marks the case and TODOS shows it in bold.
    await page.locator('#record-detail .lead-quick-actions').getByRole('button', { name: 'Pediu para ligar depois' }).click();
    await expect(page.locator('#record-detail .lead-quick input[type="datetime-local"]')).toBeVisible();
    await page.locator('#record-detail .lead-quick-actions').getByRole('button', { name: 'Atendeu', exact: true }).click();
    await expect(page.locator('.undo-toast')).toContainText('Resultado registrado', { timeout: 30000 });
    await page.locator('#detail-back').click();
    await expect(row.locator('.attend-wait strong')).toHaveText('Atendeu', { timeout: 30000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

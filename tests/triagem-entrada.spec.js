'use strict';

// Triagem no ATENDIMENTO (antiga ENTRADA) no navegador, com /api/** simulado e dados fictícios:
// REVISAR aparece como motivo do caso em "Depende de você", "Fora do funil comercial" lista o que saiu, e corrigir, manter
// pendente e desfazer mandam só a decisão para o servidor. Nenhuma chamada da OpenAI. Desktop e 390 px.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/triagem-entrada.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
const SHOTS = process.env.VISUAL_SHOTS || '';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const uuid = (n) => `6d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const LABELS = { PRE_COMPRA_MCS: 'Pré-compra MCS', POS_VENDA: 'Pós-venda', PESSOAL: 'Pessoal', OUTRO_NEGOCIO: 'Outro negócio', NAO_CLIENTE: 'Não é cliente', REVISAR: 'Revisar' };
const item = (n, name, category, decision, extra = {}) => ({ id: uuid(n), chatId: uuid(n + 1), journeyId: uuid(n + 2), source: 'AI', category, label: LABELS[category], decision, reason: 'Motivo curto', errorCode: null, model: 'gpt-6-luna', createdAt: new Date().toISOString(), name, evidence: ['Trecho da conversa'], ...extra });
const TRIAGE = {
  state: 'DESLIGADA', ruleVersion: 'triagem-v1', labels: LABELS,
  review: [item(10, 'Contato Ambíguo', 'REVISAR', 'PENDENTE', { reason: 'Contexto insuficiente', evidence: ['Oi, tudo bem?'] }), item(20, 'Contato Sem Resposta', 'REVISAR', 'PENDENTE', { reason: '', errorCode: 'OPENAI_TIMEOUT', evidence: [] })],
  out: [item(30, 'Cliente Pós-venda', 'POS_VENDA', 'FORA_DO_FUNIL', { reason: 'Problema com carro já comprado', evidence: ['O carro chegou com o documento errado'] }), item(40, 'Amigo Pessoal', 'PESSOAL', 'FORA_DO_FUNIL', { source: 'MANUAL', reason: 'Decisão manual', model: null })]
};

async function open(page, width) {
  const posts = [];
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/triage') {
      if (route.request().method() === 'POST') { posts.push(JSON.parse(route.request().postData())); return json({ applied: true }); }
      return json(TRIAGE);
    }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], suggestions: [], errors: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  // ATENDIMENTO opens first: the triage decisions are reasons of their cases.
  await expect(page.locator('#today-list .triage-item').first()).toBeVisible({ timeout: 30000 });
  return posts;
}

for (const width of [1280, 390]) {
  test(`${width}px · REVISAR em "Depende de você", fora do funil recolhido, estado desligado e sem rolagem lateral`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    await open(page, width);
    const review = page.locator('#today-list .triage-item');
    await expect(review).toHaveCount(2);
    await expect(review.first()).toContainText('Contato Ambíguo');
    await expect(review.first()).toContainText('IA · Contexto insuficiente');
    await expect(review.first()).toContainText('Oi, tudo bem?');
    await expect(review.nth(1)).toContainText('Leitura automática falhou, decida manualmente');
    // Each REVISAR is its own case (different fichas), with the reason first.
    await expect(page.locator('#today-list .case-card')).toHaveCount(2);
    await expect(page.locator('#today-list .case-card').first()).toContainText('Classificar a conversa (pré-compra ou fora do funil)');
    await expect(page.locator('#triage-state')).toHaveText('Triagem automática desligada: as conversas novas seguem o fluxo normal');
    await expect(page.locator('#triage-out-count')).toHaveText('2');
    await expect(page.locator('#triage-out-list')).toBeHidden();
    await page.locator('#triage-out summary').click();
    const out = page.locator('#triage-out-list .triage-item');
    await expect(out).toHaveCount(2);
    await expect(out.first()).toContainText('Problema com carro já comprado');
    // Undo only for manual decisions.
    await expect(out.first().getByRole('button', { name: 'Desfazer' })).toHaveCount(0);
    await expect(out.nth(1).getByRole('button', { name: 'Desfazer' })).toHaveCount(1);
    await expect(out.nth(1).locator('.triage-reason')).toHaveText('Decisão manual');
    await expect(out.first().getByLabel('Corrigir a classificação').locator('option', { hasText: 'Pré-compra MCS' })).toHaveCount(0);
    // The ATENDIMENTO badge counts the cases that depend on you (the REVISAR ones here).
    await expect(page.locator('[data-count="today"]')).toHaveText('2');
    await expect(page.locator('[data-attend-bucket="depende"] .chip-count')).toHaveText('2');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `entrada-triagem-${width}.png`), fullPage: width !== 390 });
    expect(errors).toEqual([]);
  });
}

test('é pré-compra, corrigir, manter pendente e desfazer mandam só a decisão ao servidor', async ({ page }) => {
  const posts = await open(page, 1280);
  const first = page.locator('#today-list .triage-item').first();
  await first.getByRole('button', { name: 'É pré-compra' }).click();
  await expect.poll(() => posts.length).toBe(1);
  await page.locator('#triage-out summary').click();
  const post = page.locator('#triage-out-list .triage-item').first();
  await post.getByLabel('Corrigir a classificação').selectOption('REVISAR');
  await post.getByRole('button', { name: 'Corrigir' }).click();
  await expect.poll(() => posts.length).toBe(2);
  await page.locator('#triage-out-list .triage-item').nth(1).getByRole('button', { name: 'Desfazer' }).click();
  await expect.poll(() => posts.length).toBe(3);
  expect(posts).toEqual([
    { action: 'set', chatId: uuid(11), category: 'PRE_COMPRA_MCS' },
    { action: 'set', chatId: uuid(31), category: 'REVISAR' },
    { action: 'undo', triageId: uuid(40) }
  ]);
});

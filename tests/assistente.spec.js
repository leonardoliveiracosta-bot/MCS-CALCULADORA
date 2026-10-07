'use strict';

// Assistente do painel no navegador real (servidor do assistente simulado): abre ao lado no
// computador e de baixo para cima no iPhone sem sair da tela; responde; "Não funcionou" leva o
// último clique; nada executa sem Autorizar; com Autorizar executa pelo caminho do botão normal;
// Desfazer volta; dado desatualizado não executa e pede nova proposta; OpenAI fora do ar não trava.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/assistente.spec.js
const { test, expect } = require('@playwright/test');
const { fichaLead } = require('./abrir-ficha-opcoes');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const JOURNEY = '7f000000-0000-4000-8000-000000000001', MATCH = '7f000000-0000-4000-8000-000000000002';
async function openPanel(page, { width = 1366, height = 900, assistant }) {
  const calls = { assistant: [], options: [], lead: [] };
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/assistant') {
      const body = request.method() === 'POST' ? JSON.parse(request.postData() || '{}') : { action: 'list' };
      calls.assistant.push(body);
      const out = await assistant(body, calls);
      return json(out.payload || out, out.status || 200);
    }
    if (url.pathname === '/api/panel/manheim-options' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}'); calls.options.push(body);
      if (calls.staleSelect) return json({ error: 'MANHEIM_SALE_ENDED' }, 409);
      return json({ matchId: body.matchId, status: body.action === 'select' ? 'SELECTED' : 'AVAILABLE', selectedCount: 1 });
    }
    if (url.pathname === '/api/panel/lead' && url.searchParams.get('id')) { calls.lead.push(url.searchParams.get('id')); return json(fichaLead(url)); }
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {}, v1: { tapped: [], waiting: [], expired: [] }, v2: { bid: [], waiting: [], expired: [] } });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
  return calls;
}
const proposalOf = (acao, linha, grava, params) => ({ reply: 'Posso fazer isso.', proposal: { acao, linha, grava, params } });

test('computador: abre ao lado sem sair da tela, responde, Autorizar executa e Não registra a recusa', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const calls = await openPanel(page, { assistant: (body) => {
    if (body.action === 'chat' && /ficha/.test(body.message)) return proposalOf('abrir_ficha', 'Abrir ficha · Maria Souza (Ref ABCDE)', false, { journeyId: JOURNEY });
    if (body.action === 'chat' && /aba/.test(body.message)) return proposalOf('abrir_aba', 'Abrir a aba V1', false, { view: 'v1' });
    if (body.action === 'chat') return { reply: 'A Maria tem lance de $30.000.', proposal: null };
    return { ok: true };
  } });
  await page.locator('[data-view="searches"]').click();
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  await expect(panel).toBeVisible();
  await expect(page.locator('#searches-panel')).toBeVisible();
  const box = await panel.boundingBox();
  expect(box.x).toBeGreaterThan(600);
  await panel.locator('textarea').fill('qual o lance da Maria?');
  await panel.locator('textarea').press('Enter');
  await expect(panel.locator('.assistant-msg.assistant').last()).toHaveText('A Maria tem lance de $30.000.');
  const sent = calls.assistant.find((c) => c.action === 'chat');
  expect(sent.context.view).toBe('searches');
  // Proposal: nothing runs before Autorizar.
  await panel.locator('textarea').fill('abre a ficha da Maria');
  await panel.locator('textarea').press('Enter');
  const card = panel.locator('.assistant-proposal').last();
  await expect(card.locator('.assistant-proposal-line')).toHaveText('Abrir ficha · Maria Souza (Ref ABCDE)');
  await expect(card.getByRole('button', { name: 'Autorizar', exact: true })).toHaveClass(/screen/);
  expect(calls.lead).toEqual([]);
  await card.getByRole('button', { name: 'Autorizar', exact: true }).click();
  await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => calls.lead.includes(JOURNEY)).toBe(true);
  await expect.poll(() => calls.assistant.some((c) => c.action === 'event' && c.type === 'AUTORIZADA' && c.acao === 'abrir_ficha')).toBe(true);
  // "Não" records the refusal and runs nothing.
  await panel.locator('textarea').fill('abre a aba v1');
  await panel.locator('textarea').press('Enter');
  await expect(panel.locator('.assistant-proposal')).toHaveCount(2);
  const second = panel.locator('.assistant-proposal').last();
  await second.getByRole('button', { name: 'Não' }).click();
  await expect.poll(() => calls.assistant.some((c) => c.action === 'event' && c.type === 'RECUSADA' && c.acao === 'abrir_aba')).toBe(true);
  await expect(page.locator('#v1-panel')).toBeHidden();
  // Alt+A closes it.
  await page.keyboard.press('Alt+a');
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test('ação que grava: botão laranja, executa pelo caminho normal, Desfazer volta; dado desatualizado não executa', async ({ page }) => {
  const calls = await openPanel(page, { assistant: (body) => body.action === 'chat'
    ? proposalOf('selecionar_carro', 'Selecionar carro · Maria Souza (Ref ABCDE) · 2022 Jeep Wrangler Rubicon · VIN final 000123', true, { matchId: MATCH })
    : { ok: true } });
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  await panel.locator('textarea').fill('seleciona o wrangler');
  await panel.locator('textarea').press('Enter');
  const card = panel.locator('.assistant-proposal').last();
  const go = card.getByRole('button', { name: 'Autorizar e gravar' });
  await expect(go).toHaveClass(/write/);
  await go.click();
  await expect.poll(() => calls.options.map((o) => o.action).join()).toBe('select');
  expect(calls.options[0].matchId).toBe(MATCH);
  await expect(card.getByRole('button', { name: 'Desfazer' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Autorizar e gravar' })).toBeHidden();
  await card.getByRole('button', { name: 'Desfazer' }).click();
  await expect.poll(() => calls.options.map((o) => o.action).join()).toBe('select,remove');
  // Stale data: nothing runs and the assistant is asked for a new proposal.
  calls.staleSelect = true;
  await panel.locator('textarea').fill('seleciona de novo');
  await panel.locator('textarea').press('Enter');
  await expect(panel.locator('.assistant-proposal')).toHaveCount(2);
  const before = calls.assistant.filter((c) => c.action === 'chat').length;
  await panel.locator('.assistant-proposal').last().getByRole('button', { name: 'Autorizar e gravar' }).click();
  await expect(panel.locator('.assistant-proposal').nth(1)).toContainText('Os dados mudaram');
  await expect.poll(() => calls.assistant.filter((c) => c.action === 'chat').length).toBeGreaterThan(before);
});

test('iPhone: abre de baixo para cima; "Não funcionou" em um toque leva o último clique; OpenAI fora do ar não trava', async ({ page }) => {
  const calls = await openPanel(page, { width: 390, height: 844, assistant: (body) => body.action === 'report'
    ? { diagnosis: { categoria: 'DEFEITO_TELA' }, reply: 'Clique sem nenhuma resposta depois: provável defeito de tela', proposal: { acao: 'registrar_chamado', linha: 'Registrar chamado · clique sem resposta', grava: true, params: { note: 'clique sem resposta', context: body.context } } }
    : body.action === 'chat' ? { reply: 'Assistente indisponível agora', proposal: null, unavailable: true } : { ok: true } });
  await page.locator('[data-view="v1"]').first().click();
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  const box = await panel.boundingBox();
  expect(Math.round(box.width)).toBe(390);
  expect(Math.round(box.y + box.height)).toBe(844);
  // Legível no fundo escuro: texto claro nos botões discretos (Fechar e Não funcionou).
  const lightness = (locator) => locator.evaluate((node) => { const [r, g, b] = getComputedStyle(node).color.match(/\d+/g).map(Number); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; });
  expect(await lightness(panel.getByRole('button', { name: 'Não funcionou' }))).toBeGreaterThan(0.7);
  expect(await lightness(panel.getByRole('button', { name: 'Fechar' }))).toBeGreaterThan(0.7);
  await panel.getByRole('button', { name: 'Não funcionou' }).click();
  await expect(panel.locator('.assistant-msg.assistant').last()).toContainText('provável defeito de tela');
  await expect(panel.locator('.assistant-proposal').last()).toContainText('Registrar chamado');
  const report = calls.assistant.find((c) => c.action === 'report');
  const lastClick = report.context.actions.filter((a) => a.kind === 'click').pop();
  expect(lastClick.action).toBe('v1');
  await panel.locator('textarea').fill('oi');
  await panel.locator('textarea').press('Enter');
  await expect(panel.locator('.assistant-msg.assistant').last()).toHaveText('Assistente indisponível agora');
  await panel.getByRole('button', { name: 'Fechar' }).click();
  await page.locator('[data-view="today"]').first().click();
  await expect(page.locator('#today-panel')).toBeVisible();
});

test('Configurações: "Seus chamados" e "Copiar chamados abertos" no formato combinado', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  await openPanel(page, { assistant: (body) => body.action === 'list' ? { incidents: [
    { id: 'i1', fingerprint: 'v1|ficha-open|DEFEITO_TELA', severity: 'P1', status: 'ABERTO', count: 3, last_seen_at: '2026-10-05T22:00:00Z', last_version: '20261027af2', context: { view: 'v1', actions: [{ kind: 'click', action: 'ficha-open', label: 'Abrir ficha', view: 'v1' }] }, diagnosis: { categoria: 'DEFEITO_TELA', texto: 'Clique sem nenhuma resposta depois: provável defeito de tela' } },
    { id: 'i2', fingerprint: 'searches|v1-generate|TECNICO', severity: 'P0', status: 'CORRIGIDO', count: 1, last_seen_at: '2026-10-04T22:00:00Z', pr_url: 'https://github.com/x/y/pull/9', context: {}, diagnosis: { categoria: 'TECNICO' } }
  ] } : { ok: true } });
  await page.locator('[data-view="settings"]').first().click();
  const card = page.locator('#assistant-incidents');
  await expect(card).toContainText('Seus chamados');
  await expect(card.locator('.assistant-incident')).toHaveCount(2);
  await expect(card.locator('.assistant-incident').first()).toContainText('P1');
  await card.getByRole('button', { name: 'Copiar chamados abertos' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toBe('V1 · Abrir ficha · abrir a ficha do cliente · Clique sem nenhuma resposta depois: provável defeito de tela · — · — · 20261027af2 · 3 vezes · P1 · DEFEITO_TELA');
});

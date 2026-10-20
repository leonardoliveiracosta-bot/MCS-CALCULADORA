'use strict';

// Novo assistente no navegador real (servidor do assistente simulado): aba lateral fixa à direita no computador
// e tela cheia no celular; "Vendo agora"; atalhos; passos em linhas curtas; listas com Ref e telefone que abrem a
// ficha; cartão de confirmação que só executa no clique (uma vez); anexos; conversa mantida ao trocar de aba;
// "Não funcionou" registra; "Seus chamados" em Configurações.
// Run: PANEL_VISUAL_LOCAL=1 PLAYWRIGHT_BROWSERS_PATH=/tmp/claude-0/pwb npx playwright test tests/assistente.spec.js
const { test, expect } = require('@playwright/test');
const { fichaLead } = require('./abrir-ficha-opcoes');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const JOURNEY = '7f000000-0000-4000-8000-000000000001';
const ndjson = (lines) => lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
async function openPanel(page, { width = 1366, height = 900, assistant }) {
  const calls = { assistant: [], lead: [] };
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
      if (body.action === 'chat') return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: ndjson([...(out.steps || []).map((text) => ({ type: 'step', text })), { type: 'final', blocks: [], ...out }]) });
      return json(out, out.status || 200);
    }
    if (url.pathname === '/api/panel/lead' && url.searchParams.get('id')) { calls.lead.push(url.searchParams.get('id')); return json(fichaLead(url)); }
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {}, v1: { tapped: [], waiting: [], expired: [] }, v2: { bid: [], waiting: [], expired: [] } });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60000 });
  return calls;
}

test('computador: aba lateral à direita, atalhos, passos curtos e lista com Ref e telefone que abre a ficha', async ({ page }) => {
  const calls = await openPanel(page, { assistant: (body) => body.action === 'chat'
    ? { steps: ['Li Atendimento · 31 conversas'], reply: '1 lead esperando você:', blocks: [{ type: 'leads', title: null, items: [{ journeyId: JOURNEY, line: 'R893Z · (954) 478-5595', detail: 'Mercedes-Benz GLE 2024–2027', badge: '18 h', tone: 'vermelho' }] }] }
    : { ok: true } });
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  const box = await panel.boundingBox();
  expect(Math.round(box.x + box.width)).toBe(1366);
  expect(Math.round(box.width)).toBe(400);
  await expect(panel.locator('.assistant-ctx')).toContainText('Vendo agora: TODOS');
  await expect(panel.locator('.assistant-ai').first()).toHaveText('Oi Leo, o que você precisa?');
  await expect(panel.locator('.assistant-chip')).toHaveText(['Quem está sem resposta?', 'Resumo de hoje', 'Organizar Sem Ref', 'Quem está pronto para ligar?', 'Pedidos sem busca no Manheim']);
  await panel.getByRole('button', { name: 'Quem está sem resposta?' }).click();
  await expect(panel.locator('.assistant-tool').filter({ hasText: 'Li Atendimento · 31 conversas' })).toBeVisible();
  const row = panel.locator('.assistant-row').first();
  await expect(row).toContainText('R893Z');
  await expect(row).toContainText('(954) 478-5595');
  await expect(row.locator('.assistant-badge')).toHaveText('18 h');
  const chat = calls.assistant.find((c) => c.action === 'chat');
  expect(chat.context.view).toBe('today');
  await row.click();
  await expect.poll(() => calls.lead.length).toBeGreaterThan(0);
  expect(calls.lead[0]).toBe(JOURNEY);
});

test('cartão de ação: nada executa antes do clique; Confirmar executa uma vez (clique duplo não repete); Cancelar não executa', async ({ page }) => {
  let turn = 0;
  const calls = await openPanel(page, { assistant: (body) => {
    if (body.action === 'chat') { turn += 1; return { reply: 'Confira e confirme no cartão.', blocks: [{ type: 'proposal', id: 'prop-' + turn, kind: 'v1', title: 'Vou fazer · precisa do seu ok', lines: ['Montar a V1 de R893Z · (954) 478-5595', '3 carros', 'Nada é enviado ao cliente'], button: 'Confirmar', files: [] }] }; }
    if (body.action === 'confirm') return { ok: true, text: 'V1 montada', link: '/v/NEW', linkLabel: 'Abrir para revisar' };
    if (body.action === 'cancel') return { ok: true, text: 'Cancelado · nada foi feito' };
    return { ok: true };
  } });
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  await panel.locator('textarea').fill('monta a V1 do R893Z com os 3 GLE do lote');
  await panel.locator('textarea').press('Enter');
  const card = panel.locator('.assistant-confirm').first();
  await expect(card).toContainText('Vou fazer · precisa do seu ok');
  await expect(card).toContainText('R893Z · (954) 478-5595');
  expect(calls.assistant.filter((c) => c.action === 'confirm')).toHaveLength(0);
  await card.getByRole('button', { name: 'Confirmar' }).dblclick();
  await expect(panel.locator('.assistant-ok').first()).toContainText('V1 montada');
  await expect(panel.locator('.assistant-ok a').first()).toHaveAttribute('href', '/v/NEW');
  expect(calls.assistant.filter((c) => c.action === 'confirm')).toHaveLength(1);
  await panel.locator('textarea').fill('de novo');
  await panel.locator('textarea').press('Enter');
  const second = panel.locator('.assistant-confirm').nth(1);
  await second.getByRole('button', { name: 'Cancelar' }).click();
  await expect(panel.locator('.assistant-tool').filter({ hasText: 'Cancelado · nada foi feito' })).toBeVisible();
  expect(calls.assistant.filter((c) => c.action === 'confirm')).toHaveLength(1);
});

test('anexo pelo clipe vai junto da mensagem; a conversa continua ao trocar de aba', async ({ page }) => {
  const calls = await openPanel(page, { assistant: (body) => body.action === 'chat' ? { steps: ['Li o print · achei telefone e Ref'], reply: 'É do ZFVX4.' } : { ok: true } });
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  await panel.locator('input[type="file"]').setInputFiles({ name: 'print-sms.txt', mimeType: 'text/plain', buffer: Buffer.from('SMS de +1 407 000 0000 Ref ZFVX4') });
  await expect(panel.locator('.assistant-tray .assistant-att')).toContainText('print-sms.txt');
  await panel.locator('textarea').fill('coloca isso no lead certo');
  await panel.locator('textarea').press('Enter');
  await expect(panel.locator('.assistant-ai').last()).toHaveText('É do ZFVX4.');
  const chat = calls.assistant.find((c) => c.action === 'chat');
  expect(chat.attachments).toHaveLength(1);
  expect(Buffer.from(chat.attachments[0].base64, 'base64').toString()).toContain('ZFVX4');
  expect(chat.context.attachments[0]).toMatchObject({ index: 1, name: 'print-sms.txt' });
  await page.locator('[data-view="v1"]').first().click();
  await expect(panel.locator('.assistant-ctx')).toContainText('Vendo agora: V1');
  await expect(panel.locator('.assistant-ai').last()).toHaveText('É do ZFVX4.');
  await panel.getByRole('button', { name: 'Nova conversa' }).click();
  await expect(panel.locator('.assistant-ai')).toHaveText(['Oi Leo, o que você precisa?']);
});

test('celular: tela cheia; "Não funcionou" registra levando o último clique; assistente fora do ar não trava', async ({ page }) => {
  const calls = await openPanel(page, { width: 390, height: 844, assistant: (body) => body.action === 'report'
    ? { reply: 'Registrei o que deu errado (P1) · Clique sem nenhuma resposta depois: provável defeito de tela' }
    : body.action === 'chat' ? { reply: 'Assistente indisponível agora · tente de novo', unavailable: true } : { ok: true } });
  await page.locator('[data-view="v1"]').first().click();
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  const box = await panel.boundingBox();
  expect(Math.round(box.width)).toBe(390);
  expect(Math.round(box.height)).toBe(844);
  await panel.getByRole('button', { name: 'Não funcionou' }).click();
  await expect(panel.locator('.assistant-ai').last()).toContainText('Registrei o que deu errado');
  const report = calls.assistant.find((c) => c.action === 'report');
  expect(report.context.actions.filter((a) => a.kind === 'click').pop().action).toBe('v1');
  await panel.locator('textarea').fill('oi');
  await panel.locator('textarea').press('Enter');
  await expect(panel.locator('.assistant-ai').last()).toHaveText('Assistente indisponível agora · tente de novo');
  await panel.getByRole('button', { name: 'Fechar' }).click();
  await expect(panel).toBeHidden();
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
  await expect(card.locator('.assistant-incident')).toHaveCount(1); // o filtro começa em "Abertos"
  await card.getByRole('button', { name: 'Copiar chamados abertos' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toBe('V1 · Abrir ficha · abrir a ficha do cliente · Clique sem nenhuma resposta depois: provável defeito de tela · — · — · 20261027af2 · 3 vezes · P1 · DEFEITO_TELA');
});

test('teste de botões: roda num quadro escondido; toda gravação vai em modo simulação; a tela e a sessão do Leo não mudam', async ({ page }) => {
  const writes = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET' && request.frame() !== page.mainFrame()) writes.push({ path: url.pathname, dry: request.headers()['x-mcs-dry-run'] || null });
  });
  let chats = 0;
  const calls = await openPanel(page, { assistant: (body) => {
    if (body.action !== 'chat') return { ok: true };
    chats += 1;
    return chats === 1 ? { steps: ['Li os erros do servidor das últimas 24 h'], reply: 'Vou testar os botões.', clientTask: 'audit_buttons', report: true } : { reply: 'Achei 0 problemas.', report: true };
  } });
  // As preferências e a sessão do Leo (sem os carimbos de tempo que a própria página principal renova sozinha).
  const stored = () => page.evaluate(() => JSON.stringify(Object.entries(localStorage).sort().map(([key, value]) => {
    if (key === 'mcs_panel_refresh_leader') return [key, '(relógio da página)'];
    if (key === 'mcs_panel_session') { const session = JSON.parse(value); return [key, session.accessToken + '|' + session.refreshToken]; }
    return [key, value];
  })));
  const before = await stored();
  await page.locator('#mcs-assistant-fab').click();
  const panel = page.locator('#mcs-assistant');
  await panel.locator('textarea').fill('tem algo quebrado? testa os botões');
  await panel.locator('textarea').press('Enter');
  await expect(panel.locator('.assistant-tool').filter({ hasText: /Testei \d+ botões em modo teste · nada foi enviado/ })).toBeVisible({ timeout: 110000 });
  await expect(panel.locator('.assistant-ai').last()).toHaveText('Achei 0 problemas.');
  const followUp = calls.assistant.filter((c) => c.action === 'chat')[1];
  expect(followUp.auditResults.testados).toBeGreaterThan(5);
  expect(writes.filter((w) => w.path !== '/api/panel/boot').every((w) => w.dry === '1')).toBe(true);
  expect(page.locator('iframe')).toHaveCount(0);
  expect(await stored()).toBe(before);
  await expect(panel.getByRole('button', { name: 'Gerar relatório para corrigir' }).first()).toBeVisible();
});

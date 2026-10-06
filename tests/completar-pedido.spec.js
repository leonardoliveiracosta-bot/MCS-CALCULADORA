'use strict';
const { test, expect } = require('@playwright/test');
const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
const DAY = 86400000;
const id = (n) => `7d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = (days) => new Date(Date.now() - days * DAY).toISOString();
const ordinary = (n, days, pending) => ({ kind: 'JOURNEY', id: id(n), name: 'Lead normal ' + n, phones: [{ phone_e164: '+1305555000' + n, is_primary: true }], sortAt: at(days), lastCustomerAt: at(days), awaitingReply: pending,
  group: { key: pending ? 'NAO_ATENDIDO' : 'ATENDIDO', origin: { key: 'MENSAGEM:WHATSAPP', label: 'Mensagem', financing: false }, unattended: pending ? { reason: 'NO_RESPONSE', since: at(days), waitedMs: days * DAY, timeLabel: `WhatsApp há ${days} dias · sem resposta` } : null } });
const contexts = {
  [id(3)]: { name: 'Pedido sem resposta', internalCode: '2L2TD', contact: { phones: ['+13055550123'] }, refState: 'SEM_REF', listMessage: { at: at(5), direction: 'CUSTOMER', channel: 'SMS' }, conversation: { lastAt: at(5) } },
  [id(4)]: { name: 'Pedido aguardando', internalCode: 'XP72R', contact: { phones: ['+13055550124'] }, refState: 'SEM_REF', listMessage: { at: at(10), direction: 'MCS', channel: 'WHATSAPP' }, conversation: { lastAt: at(10) } },
  [id(5)]: { name: 'SMS sem data', internalCode: 'SQLRQ', contact: { phones: ['+13055550125'] }, refState: 'SEM_REF', listMessage: { at: null, direction: 'CUSTOMER', channel: 'SMS' }, conversation: { lastAt: at(5) } }
};

async function open(page) {
  contexts[id(3)].listMessage = { at: at(5), direction: 'CUSTOMER', channel: 'SMS' };
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 }));
    localStorage.setItem('mcs_today_ref_filter', 'all');
    window.__opened = []; window.open = (url) => { window.__opened.push(String(url)); return null; };
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') {
      const normal = [ordinary(1, 20, true), ordinary(2, 1, false)];
      if (url.searchParams.get('sort') === 'recent') normal.reverse();
      return json({ items: normal, meta: {} });
    }
    if (url.pathname === '/api/panel/pesquisas') return json({ items: [3, 4, 5].map((n) => ({ key: 'pedido' + n, state: 'PRECISA_DETALHE', person: { journeyId: id(n), name: contexts[id(n)].name }, missing: ['make', 'model'], lacksText: 'Falta carro' })) });
    if (url.pathname === '/api/panel/client-context') return json({ journeys: contexts });
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], suggestions: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#today-list .attend-row')).toHaveCount(5, { timeout: 30000 });
  await expect(page.locator('#today-list .attend-row[data-journey-id="' + id(3) + '"] .attend-phone')).toHaveAttribute('href', 'https://wa.me/13055550123');
  return errors;
}

test('Completar pedido: telefone, identificação, canal e de quem é a vez; demais campos e contagens preservados', async ({ page }) => {
  const errors = await open(page);
  const incoming = page.locator('#today-list .attend-row[data-journey-id="' + id(3) + '"]');
  await expect(incoming).toHaveAttribute('data-bucket', 'completar');
  await expect(incoming.locator('.attend-wait')).toContainText('5 dias · sem resposta');
  await expect(incoming.locator('.attend-wait')).toContainText('SMS');
  await expect(incoming.locator('.attend-dot-mid')).toHaveCount(1);
  await expect(incoming.locator('.attend-client')).toContainText('Sem Ref');
  await expect(incoming.locator('.attend-client')).toContainText('Código 2L2TD · interno');
  await expect(incoming.locator('.attend-car')).toHaveText('—');
  await expect(incoming.locator('.attend-order')).toHaveText('—');
  await expect(incoming.locator('.attend-lacks .attend-chip')).toHaveText(['Make', 'Model']);
  const outgoing = page.locator('#today-list .attend-row[data-journey-id="' + id(4) + '"]');
  await expect(outgoing.locator('.attend-wait')).toContainText('Aguardando o cliente · há 10 dias');
  await expect(outgoing.locator('.attend-wait')).toContainText('WhatsApp');
  await expect(outgoing.locator('.attend-dot')).toHaveCount(0);
  const undated = page.locator('#today-list .attend-row[data-journey-id="' + id(5) + '"]');
  await expect(undated.locator('.attend-wait')).toHaveText('Sem respostaSMS · data original desconhecida');
  await expect(undated.locator('.attend-dot')).toHaveCount(0);
  await expect(page.locator('[data-count="today"]')).toHaveText('5');
  await incoming.locator('.attend-phone').click();
  expect((await page.evaluate(() => window.__opened)).join(' ')).toMatch(/13055550123/);
  await expect(page.locator('#detail-panel')).toBeHidden();
  await page.locator('#attend-search').fill('13055550123');
  await expect(page.locator('#today-list .attend-row')).toHaveCount(1);
  await page.locator('#attend-search').fill('2L2TD');
  await expect(page.locator('#today-list .attend-row')).toHaveCount(1);
  // A normal refresh rereads the conversation; a reply no longer leaves a stale "sem resposta".
  contexts[id(3)].listMessage = { at: at(1), direction: 'MCS', channel: 'SMS' };
  await page.locator('#attend-search').fill('');
  await page.selectOption('#today-sort', 'recent');
  await expect(incoming.locator('.attend-wait')).toContainText('Aguardando o cliente · há 24 h');
  await expect(incoming.locator('.attend-dot')).toHaveCount(0);
  await expect(incoming).toHaveAttribute('data-bucket', 'completar');
  expect(errors).toEqual([]);
});

test('Completar pedido: intercala na ordem normal, sem alterar a ordem relativa dos outros leads', async ({ page }) => {
  const errors = await open(page), rows = page.locator('#today-list .attend-row');
  const ids = () => rows.evaluateAll((all) => all.map((row) => row.dataset.journeyId));
  await expect.poll(ids).toEqual([id(1), id(3), id(5), id(2), id(4)]);
  await page.selectOption('#today-sort', 'recent');
  await expect.poll(ids).toEqual([id(2), id(3), id(4), id(1), id(5)]);
  await page.selectOption('#today-sort', 'oldest');
  await expect.poll(ids).toEqual([id(1), id(4), id(3), id(2), id(5)]);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

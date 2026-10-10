'use strict';

// ATENDIMENTO · clique no cabeçalho ordena a lista por aquela coluna (crescente, depois decrescente, depois volta ao
// Ordenar). Com paginação o servidor ordena a lista inteira (aqui com as regras reais de panel-attend-page); sem
// paginação o navegador ordena. Sem clique nada muda: a ordem é a do Ordenar e o pedido não leva coluna.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/atendimento-colunas.spec.js
const { test, expect } = require('@playwright/test');
const pageRules = require('../panel-attend-page');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `7f300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const HOUR = 3600000;
const valor = (vehicleText, budgetCents) => ({ modes: ['VALOR'], perMode: { VALOR: { vehicleText, budgetCents } } });
const carro = (vehicleText, yearsText, mileageText) => ({ modes: ['CARRO'], perMode: { CARRO: { vehicleText, yearsText, mileageText } } });
const waiting = (channel, hours, text) => ({ key: 'NAO_ATENDIDO', label: 'Não atendidos', origin: { key: 'MENSAGEM:' + channel.toUpperCase(), label: 'Mensagem' }, unattended: { reason: 'NO_RESPONSE', reasonText: 'Mensagem do cliente sem resposta', since: iso(hours), waitedMs: hours * HOUR, waitedText: text, timeLabel: `${channel} há ${text} · sem resposta` } });
const served = (originKey) => ({ key: 'ATENDIDO', label: 'Atendidos', origin: originKey ? { key: originKey, label: 'Origem' } : null, unattended: null });
const person = (n, group, facts, ref, extra = {}) => ({
  kind: 'JOURNEY', id: id(n), name: 'Pessoa ' + n, contact: { display_name: 'Pessoa ' + n },
  phones: [{ phone_e164: '+1305555' + String(1000 + n * 37).slice(-4), is_primary: true }],
  sortAt: iso(n), lastCustomerAt: iso(n), group, cardFacts: facts, hasCalcRef: Boolean(ref), calcRef: ref || null, ...extra
});
const ITEMS = [
  person(1, waiting('WhatsApp', 30, '30 h'), { ...valor('Honda Civic', 1500000), zipText: '33101 — Miami, FL' }, 'KQ7RZ'),
  person(2, served('CALCULADORA:SITE'), { ...carro('Toyota RAV4', '2019 a 2022', 'até 60.000'), zipText: '10001 — New York, NY' }, 'AB3CD'),
  person(3, waiting('SMS', 48, '2 dias'), { ...valor('BMW X5', 4000000), zipText: '90001 — Los Angeles, CA' }, null),
  person(4, served('MENSAGEM:WHATSAPP'), {}, null),
  person(5, waiting('WhatsApp', 0.1, '5 min'), { ...carro('Audi Q5', '2015 a 2018', 'até 120.000'), zipText: '75001 — Addison, TX' }, 'ZZ9YX'),
  person(6, served('CALCULADORA:SITE'), { ...valor('Ford F-150', 800000), zipText: '30301 — Atlanta, GA' }, 'MM2NN')
];
const LABELS = { espera: 'Espera', canal: 'Canal', ref: 'Ref', telefone: 'Telefone', carro: 'Carro', valor: 'Valor', ano: 'Ano', milha: 'Milha', origem: 'Origem', estado: 'Estado' };
const CELLS = { espera: '.attend-wait', canal: '.attend-channel', ref: '.attend-ref', telefone: '.attend-tel', carro: '.attend-car', valor: '.attend-value', ano: '.attend-year', milha: '.attend-miles', origem: '.attend-origin', estado: '.attend-state' };

// O que a tela mostra, em número quando a coluna é número; null quando a célula está em branco.
function shownValue(key, text) {
  const value = String(text || '').trim();
  if (key === 'espera') { const found = /^(\d+)\s*(min|h|dias?)\b/.exec(value); return found ? Number(found[1]) * (found[2] === 'min' ? 60000 : found[2] === 'h' ? HOUR : 24 * HOUR) : null; }
  if (!value) return null;
  if (key === 'valor') return Number(value.replace(/\D/g, '')) / 100;
  if (key === 'ano' || key === 'milha') return Number((/\d[\d.,]*/.exec(value) || ['0'])[0].replace(/\D/g, ''));
  if (key === 'telefone') return value.replace(/\D/g, '');
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase('pt-BR');
}
function expectSorted(key, dir, texts) {
  const values = texts.map((text) => shownValue(key, text));
  const filled = values.filter((value) => value !== null);
  expect(filled.length, key).toBeGreaterThanOrEqual(2);
  expect(values.slice(filled.length).every((value) => value === null), key + ': vazios no fim').toBe(true);
  const cmp = (a, b) => typeof a === 'number' ? a - b : String(a).localeCompare(String(b), 'pt-BR', { numeric: true });
  const sorted = filled.slice().sort((a, b) => cmp(a, b) * (dir === 'desc' ? -1 : 1));
  expect(filled, `${key} ${dir}`).toEqual(sorted);
}

async function open(page, { paged }) {
  const bootColumns = [], todayCalls = [];
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/today') { todayCalls.push(url.search); return json({ meta: { dataUpdatedAt: new Date().toISOString() }, items: ITEMS }); }
    if (paged && url.pathname === '/api/panel/boot') {
      const input = request.postDataJSON();
      if (input.part !== 'main' || !input.page) return json({ part: input.part, parts: {} });
      bootColumns.push(input.page.column);
      // As regras reais do servidor (as mesmas de api/panel/boot.js): lista inteira, coluna, depois a página.
      const sort = input.sort || 'ready', column = pageRules.columnOf(input.page.column), now = Date.now();
      const model = pageRules.modelOf({ items: ITEMS, discardedJourneys: [] }, { chats: [], reviews: [] }, {}, {}, { items: [] }, sort, now);
      const selected = pageRules.select(model, new Map(), { sort, ref: 'all', stat: null, query: '', v1JourneyIds: [], now, column });
      const rows = selected.order.slice(0, 30);
      const pageBody = { ...selected, order: undefined, key: JSON.stringify(column ? [sort, 'all', null, '', column] : [sort, 'all', null, '']), total: selected.order.length, limit: 30, v1Today: 0, identities: {},
        rows: rows.map((row) => ({ ...row, entry: { ...row.entry, item: undefined, itemCaseKey: row.entry.item ? row.entry.key : null } })) };
      const today = { meta: { dataUpdatedAt: new Date().toISOString() }, items: rows.map((row) => row.entry.item).filter(Boolean), page: pageBody };
      return json({ part: 'main', generatedAt: new Date().toISOString(), parts: { today: { ok: true, hash: 't' + bootColumns.length, body: today }, entry: { ok: true, hash: 'e', body: { chats: [], reviews: [] } }, triage: { ok: true, hash: 'r', body: {} }, whatsapp: { ok: true, hash: 'w', body: {} } } });
    }
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], signals: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#today-list .attend-row')).toHaveCount(ITEMS.length, { timeout: 30000 });
  return { bootColumns, todayCalls, errors };
}
const order = (page) => page.locator('#today-list .attend-row').evaluateAll((rows) => rows.map((row) => row.dataset.journeyId));
const column = (page, key) => page.locator('#today-list .attend-row ' + CELLS[key]).allTextContents();
const header = (page, key) => page.locator(`.attend-head [data-attend-col="${key}"]`);

for (const paged of [true, false]) {
  test(`cabeçalho ordena cada coluna, inverte e volta ao Ordenar (${paged ? 'paginada, no servidor' : 'sem paginação, no navegador'})`, async ({ page }) => {
    const seen = await open(page, { paged });
    const initial = await order(page);
    // Caminho comum: sem clique, nenhuma coluna vai ao servidor e nenhuma seta aparece.
    if (paged) expect(seen.bootColumns.every((value) => value === undefined)).toBe(true);
    await expect(page.locator('.attend-head [data-dir]')).toHaveCount(0);
    for (const key of Object.keys(LABELS)) {
      await expect(header(page, key)).toHaveText(LABELS[key]);
      await header(page, key).click();
      await expect(header(page, key)).toHaveAttribute('data-dir', 'asc');
      await expect.poll(async () => { try { expectSorted(key, 'asc', await column(page, key)); return true; } catch { return false; } }, { timeout: 15000 }).toBe(true);
      expectSorted(key, 'asc', await column(page, key));
      await header(page, key).click();
      await expect(header(page, key)).toHaveAttribute('data-dir', 'desc');
      await expect.poll(async () => { try { expectSorted(key, 'desc', await column(page, key)); return true; } catch { return false; } }, { timeout: 15000 }).toBe(true);
      await header(page, key).click();
      await expect(page.locator('.attend-head [data-dir]')).toHaveCount(0);
      await expect.poll(() => order(page), { timeout: 15000 }).toEqual(initial);
    }
    if (paged) expect(seen.bootColumns).toContain('valor:desc');
    expect(seen.errors).toEqual([]);
  });
}

test('trocar o Ordenar desliga a coluna clicada', async ({ page }) => {
  const seen = await open(page, { paged: true });
  await header(page, 'valor').click();
  await expect(header(page, 'valor')).toHaveAttribute('data-dir', 'asc');
  await expect.poll(async () => (await column(page, 'valor'))[0]).toContain('8.000');
  await page.selectOption('#today-sort', 'recent');
  await expect(page.locator('.attend-head [data-dir]')).toHaveCount(0);
  await expect.poll(() => seen.bootColumns.at(-1)).toBe(undefined);
  // "Mais recentes": a pessoa 1 (mensagem mais nova) primeiro, como antes.
  await expect.poll(async () => (await order(page))[0], { timeout: 15000 }).toBe(id(1));
  expect(seen.errors).toEqual([]);
});

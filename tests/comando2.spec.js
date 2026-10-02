'use strict';

// Comando 2 no navegador, com /api/** simulado e dados fictícios (nada vai ao banco, nada é enviado):
// "É sobre carro" grava a correção e mostra "Desfazer"; CLIENTES mostra a origem em chip, números
// clicáveis com complemento, contagens que batem e cartões em lotes. Desktop e 390 px.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/comando2.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const uuid = (n) => `7d000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const origin = (group, sub, financing = false) => {
  const labels = { CALCULADORA: 'Veio pela calculadora', MENSAGEM: 'Veio por mensagem', VITRINE: 'Veio pela vitrine' };
  const subs = { WHATSAPP: 'Via WhatsApp', SMS: 'Via SMS', V1: 'V1', V2: 'V2' };
  return { group, sub, key: group + ':' + sub, groupLabel: labels[group], subLabel: subs[sub], label: labels[group] + ' · ' + subs[sub], financing };
};
const unattended = { reason: 'NO_RESPONSE', reasonText: 'Mensagem do cliente sem resposta', waitedText: '26 h', waitedMs: 26 * 3600000, missing: 'Resposta à última mensagem do cliente', next: 'Responder o cliente', since: hoursAgo(26) };
const client = (n, name, groupKey, originValue, extra = {}) => ({
  id: uuid(n), contact: { display_name: name, is_lead: true }, display_name: name, stage: 'RESPONDIDO', status: 'ATIVO', enabled: true, heat: 'WARM', isLead: true,
  situation: groupKey === 'NAO_ATENDIDO' ? 'NO_RESPONSE' : 'IN_PROGRESS', checklistSummary: { completed: 2 }, lastRealMessageAt: hoursAgo(26),
  group: { key: groupKey, label: groupKey === 'NAO_ATENDIDO' ? 'Não atendidos' : groupKey === 'FORA_DO_ASSUNTO' ? 'Fora do assunto' : 'Atendidos', origin: originValue, unattended: groupKey === 'NAO_ATENDIDO' ? unattended : null, hasCalculator: originValue.group === 'CALCULADORA', calcMode: extra.calcMode || null, offTopic: groupKey === 'FORA_DO_ASSUNTO', offTopicSource: groupKey === 'FORA_DO_ASSUNTO' ? 'AI' : null },
  ...extra
});
const PAGE1 = [client(10, 'Ana Financiamento', 'NAO_ATENDIDO', origin('MENSAGEM', 'WHATSAPP', true)), client(20, 'Bruno Calculadora', 'ATENDIDO', origin('CALCULADORA', 'SMS'), { calcMode: 'CARRO' })];
const PAGE2 = [client(30, 'Carla Vitrine', 'ATENDIDO', origin('VITRINE', 'V2'), { searchModes: ['VALOR'] })];
const COUNTS = { periodLeads: 4, allLeads: 5, shownLeads: 3, nonLeads: 0, situations: { NO_RESPONSE: 1, MCS_PENDING: 0, CUSTOMER_PENDING: 0, IN_PROGRESS: 2, CLOSED: 0, NONE: 0 }, sections: { NAO_ATENDIDO: 1, ATENDIDO: 2, FORA_DO_ASSUNTO: 0, NAO_LEAD: 0 }, areas: { NAO_ATENDIDO: { SEM_REF: 1 }, ATENDIDO: { CALC_CARRO: 1, SEM_REF: 1 } } };
const OFF_TOPIC = { chatId: uuid(41), journeyId: uuid(40), name: 'Amiga Aniversário', source: 'AI', reason: 'Conversa pessoal', overrideId: null,
  group: { key: 'FORA_DO_ASSUNTO', label: 'Fora do assunto', origin: origin('MENSAGEM', 'WHATSAPP'), unattended: null, hasCalculator: false, offTopic: true, offTopicSource: 'AI' }, lastCustomerMessage: { id: uuid(42), text: 'Feliz aniversário!', at: hoursAgo(3) } };

async function open(page, width) {
  const state = { posts: [], records: [], offTopicCorrected: false };
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })); });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    const method = route.request().method();
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/triage') {
      if (method === 'POST') {
        const body = JSON.parse(route.request().postData());
        state.posts.push(body);
        if (body.action === 'topic') { state.offTopicCorrected = true; return json({ ids: [uuid(99)] }); }
        if (body.action === 'topic_undo') { state.offTopicCorrected = false; return json({ undone: 1 }); }
        return json({ applied: true });
      }
      return json({ state: 'DESLIGADA', ruleVersion: 'triagem-v2', labels: {}, review: [], out: [], offTopic: state.offTopicCorrected ? [] : [OFF_TOPIC] });
    }
    if (url.pathname === '/api/panel/records' && !url.searchParams.get('id')) {
      state.records.push(url.search);
      const page = Number(url.searchParams.get('page') || 1);
      const situation = url.searchParams.get('situation') || 'all';
      const items = situation === 'NO_RESPONSE' ? PAGE1.slice(0, 1) : page === 2 ? PAGE2 : PAGE1;
      return json({ items, page, pageSize: 2, total: situation === 'NO_RESPONSE' ? 1 : 3, hasMore: situation === 'all' && page === 1, counts: COUNTS, pending: {}, meta: {} });
    }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], suggestions: [], errors: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  return state;
}

for (const width of [1280, 390]) {
  test(`${width}px · "É sobre carro" grava a correção, tira do grupo e o "Desfazer" devolve`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    const state = await open(page, width);
    // "Fora do assunto" is folded at the end of ATENDIMENTO (the old ENTRADA is part of it).
    await expect(page.locator('#today-panel #topic-out-count')).toHaveText('1', { timeout: 30000 });
    await expect(page.locator('#topic-out')).toContainText('Na dúvida a conversa fica no fluxo principal');
    await expect(page.locator('#topic-out')).toContainText("'É sobre carro' corrige e fica guardado");
    await page.locator('#topic-out summary').click();
    const row = page.locator('#topic-out-list .topic-item');
    await expect(row).toContainText('Amiga Aniversário');
    await row.getByRole('button', { name: 'É sobre carro' }).click();
    await expect.poll(() => state.posts.map((body) => body.action)).toContain('topic');
    expect(state.posts.find((body) => body.action === 'topic')).toMatchObject({ chatId: uuid(41), aboutCar: true });
    await expect(page.locator('#topic-out-count')).toHaveText('0');
    const undo = page.getByRole('button', { name: 'Desfazer' }).first();
    await expect(undo).toBeVisible();
    await undo.click();
    await expect.poll(() => state.posts.map((body) => body.action)).toContain('topic_undo');
    expect(state.posts.find((body) => body.action === 'topic_undo').ids).toEqual([uuid(99)]);
    await expect(page.locator('#topic-out-count')).toHaveText('1');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });

  test(`${width}px · CLIENTES: origem em chip, números clicáveis com complemento, contagens iguais e cartões em lotes`, async ({ page }) => {
    const errors = [];
    page.on('pageerror', (failure) => errors.push(failure.message));
    const state = await open(page, width);
    await page.locator('[data-view="clients"]').click();
    const list = page.locator('#clients-list');
    await expect(list.locator('.client-card')).toHaveCount(2, { timeout: 30000 });
    // Origin chip: group · channel, plus the Financiamento tag inside "Veio por mensagem".
    const first = list.locator('.client-card').first();
    await expect(first.locator('.origin-chip')).toContainText('Veio por mensagem · Via WhatsApp');
    await expect(first).toContainText('Financiamento');
    await expect(list.locator('.client-card').nth(1).locator('.origin-chip')).toContainText('Veio pela calculadora · Via SMS');
    await expect(list.locator('.origin-chip', { hasText: /^Direto$/ })).toHaveCount(0);
    // Unattended: reason, waiting time, what is missing and the next action on the card.
    await expect(first).toContainText('Mensagem do cliente sem resposta');
    await expect(first).toContainText('26 h');
    await expect(first).toContainText('Responder o cliente');
    // The same numbers everywhere: badge, "N de N clientes" and the sections.
    await expect(page.locator('[data-count="clients"]').first()).toHaveText('4');
    await expect(page.locator('#clients-period-note')).toContainText('3 de 4 clientes nesta lista · 1 fora dos filtros');
    await expect(list.locator('[data-group="NAO_ATENDIDO"] .contact-group-count')).toHaveText('1');
    await expect(list.locator('[data-group="ATENDIDO"] .contact-group-count')).toHaveText('2');
    // The two calculator types and the direct conversations in their own areas (not just a tag).
    await expect(list.locator('[data-group="NAO_ATENDIDO"] section.contact-area[data-area="SEM_REF"] .contact-area-label')).toHaveText('Conversas sem Ref');
    await expect(list.locator('[data-group="NAO_ATENDIDO"] section.contact-area[data-area="SEM_REF"]')).toContainText('Ana Financiamento');
    await expect(list.locator('[data-group="ATENDIDO"] section.contact-area[data-area="CALC_CARRO"] .contact-area-label')).toHaveText('Calculadora · Por carro');
    await expect(list.locator('[data-group="ATENDIDO"] section.contact-area[data-area="CALC_CARRO"]')).toContainText('Bruno Calculadora');
    // Every number of the situation bar is a button with its complement.
    const noResponse = page.locator('#clients-stats [data-situation="NO_RESPONSE"]');
    await expect(noResponse).toContainText('1');
    await expect(noResponse).toContainText('2 nos outros');
    // Cards in batches: the rest comes with "Mostrar mais" (or when the end of the list shows up).
    const more = list.locator('.clients-more');
    if (await more.count()) await more.click().catch(() => {});
    await expect(list.locator('.client-card')).toHaveCount(3);
    await expect(list.locator('[data-group="ATENDIDO"] section.contact-area[data-area="SEM_REF"]')).toContainText('Carla Vitrine');
    await expect(list.locator('[data-group="ATENDIDO"] section.contact-area[data-area="SEM_REF"] .origin-chip')).toContainText('Veio pela vitrine · V2');
    expect(state.records.some((search) => /page=2/.test(search))).toBe(true);
    // Clicking a number opens its list.
    await noResponse.click();
    await expect.poll(() => state.records.some((search) => /situation=NO_RESPONSE/.test(search))).toBe(true);
    await expect(list.locator('.client-card')).toHaveCount(1);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

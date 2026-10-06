'use strict';

// Organização do painel no navegador real, com /api/** simulado e dados fictícios (nada é gravado
// nem enviado): ATENDIMENTO com um caso por pessoa e os motivos reunidos; BUSCAR CARROS com os dois
// tipos de calculadora, uma pessoa com os dois tipos, conversa direta completa e incompleta, o pedido
// repetido pela leitura da IA como evidência, resultado separado do andamento e contagens do mesmo
// conjunto da lista; volta da ficha com filtro e posição. Computador (1280) e celular (390).
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/organizacao.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
const SHOTS = process.env.VISUAL_SHOTS || '';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const id = (n) => `7e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const later = (hours) => new Date(Date.now() + hours * 3600000).toISOString();
const group = (key, extra = {}) => ({ key, label: key === 'NAO_ATENDIDO' ? 'Não atendidos' : 'Atendidos', origin: { key: 'MENSAGEM:WHATSAPP', label: 'Veio por mensagem · Via WhatsApp', financing: false }, unattended: null, hasCalculator: false, calcMode: null, ...extra });
const calcGroup = (key, mode, extra = {}) => group(key, { origin: { key: 'CALCULADORA:WHATSAPP', label: 'Veio pela calculadora · Via WhatsApp', financing: false }, hasCalculator: true, calcMode: mode, ...extra });
const journey = (n, name, extra) => ({ kind: 'JOURNEY', id: id(n), name, contact: { display_name: name }, phones: [{ phone_e164: '+1305555010' + n, is_primary: true }], next_action_text: null, next_action_at: null, ...extra });

const TODAY = { meta: { dataUpdatedAt: new Date().toISOString() }, items: [
  // Calculadora por valor, o cliente escreveu por último.
  journey(1, 'Ana Valor', { referenceCode: 'AVAL2', awaitingReply: true, lastCustomerMessage: { id: id(101), text: 'Tem algum X5 até 30 mil?', at: iso(3) }, lastCustomerAt: iso(3),
    group: calcGroup('NAO_ATENDIDO', 'VALOR', { unattended: { reasonText: 'Mensagem do cliente sem resposta', waitedText: '3 h', missing: 'Resposta', next: 'Responder o cliente' } }) }),
  // A mesma pessoa pelo pedido da calculadora (um caso só com a ficha).
  { kind: 'CALCULATOR_ORDER', id: 'ref:AVAL2', key: 'ref:AVAL2', ref: 'AVAL2', journeyId: id(1), contactName: 'Ana Valor', logicalModes: ['VALOR'], group: calcGroup('ATENDIDO', 'VALOR') },
  // Os dois tipos de calculadora, próxima ação marcada para depois.
  journey(2, 'Bruno Ambos', { referenceCode: 'BAMB3', next_action_text: 'Ligar com opções', next_action_at: later(48), group: calcGroup('ATENDIDO', 'CARRO') }),
  // Conversa direta incompleta, você respondeu por último.
  journey(3, 'Carla Direta', { group: group('ATENDIDO') }),
  // Conversa direta completa, o cliente escreveu por último.
  journey(4, 'Davi Direto', { awaitingReply: true, searchModes: ['CARRO'], lastCustomerMessage: { id: id(104), text: 'Quero um Civic 2020', at: iso(1) }, lastCustomerAt: iso(1), group: group('NAO_ATENDIDO', { unattended: { reasonText: 'Mensagem do cliente sem resposta', waitedText: '1 h', missing: 'Resposta', next: 'Responder o cliente' } }) })
] };
const WHATSAPP = { lastEventAt: iso(0.1), lastInboundAt: iso(0.2), lastEchoAt: iso(0.3), errors: [], ignored: [], itemErrors: [], phoneReviews: [],
  suggestions: [{ id: id(201), source_journey_id: id(1), phone_e164: '+13055550101', target_ref: 'AVAL2', refConfirmed: true, sourceName: 'Ana Valor' }] };
const TRIAGE = { state: 'DESLIGADA', review: [{ id: id(301), chatId: id(302), journeyId: null, source: 'AI', category: 'REVISAR', label: 'Revisar', decision: 'PENDENTE', reason: 'Contexto insuficiente', name: 'Contato Novo', evidence: ['Oi'] }], out: [], offTopic: [] };
const person = (n, name) => ({ journeyId: id(n), name, ref: null });
const PESQUISAS = { upload: { id: 'u1', uploadedAt: iso(5) }, extraction: 'SIMULADA', mergedReadings: 1, items: [
  { key: `ficha:journey:${id(1)}:VALOR`, groupKey: 'c:VALOR:a', source: 'CALCULADORA', searchMode: 'VALOR', state: 'COM_OPCOES', optionCount: 2, criteriaText: 'BMW X5 · lance US$ 30,000', person: person(1, 'Ana Valor'), evidence: [] },
  { key: `ficha:journey:${id(2)}:VALOR`, groupKey: 'c:VALOR:b', source: 'CALCULADORA', searchMode: 'VALOR', state: 'SEM_OPCAO', optionCount: 0, criteriaText: 'Audi Q5 · lance US$ 25,000', person: person(2, 'Bruno Ambos'), evidence: [] },
  // The ficha request with its same AI reading folded in as evidence (one request, not two).
  { key: `ficha:journey:${id(2)}:CARRO`, groupKey: 'c:CARRO:c', source: 'CALCULADORA', searchMode: 'CARRO', state: 'COM_OPCOES', optionCount: 1, criteriaText: 'Mercedes-Benz G63 · 2020 a 2026 · 10,000 a 60,000 milhas', person: person(2, 'Bruno Ambos'), evidence: [],
    aiEvidence: [{ key: 'conversa:r1', criteriaText: 'Mercedes-Benz G63 · 2020 a 2026 · 10,000 a 60,000 milhas', confirmed: false, versions: 2, evidence: [{ at: iso(30), text: 'G63 2020 to 2026' }] }] },
  { key: 'conversa:r2', groupKey: 'c:CARRO:d', source: 'CONVERSA', searchMode: 'CARRO', state: 'FALTA_BUSCAR', criteriaText: 'Honda Civic · 2020 · até 50,000 milhas', person: person(4, 'Davi Direto'), evidence: [] },
  { key: 'conversa:r3', groupKey: 'x:conversa:r3:e', source: 'CONVERSA', searchMode: null, state: 'PRECISA_DETALHE', lacksText: 'Falta ano e milhagem', criteriaText: 'Toyota RAV4', person: person(3, 'Carla Direta'), evidence: [] },
  { key: `ficha:journey:${id(1)}:REVIEW`, groupKey: 'x:f:f', source: 'FICHA', searchMode: null, state: 'PRECISA_REVISAO', typeUnknown: true, reviewReason: 'Tipo de busca não definido no pedido: escolha por valor ou por carro', criteriaText: 'BMW X3 · até US$ 20,000', person: person(1, 'Ana Valor'), evidence: [] }
] };
const SEARCHES = { countsByMode: {}, items: [
  { key: id(2) + ':CARRO', journeyId: id(2), mode: 'CARRO', name: 'Bruno Ambos', stage: 'MISSING', stageSource: null, stageLabel: '🔍 Busca não salva no Manheim', exactSearch: 'G63', days: 0, matchCount: 1 },
  { key: id(2) + ':VALOR', journeyId: id(2), mode: 'VALOR', name: 'Bruno Ambos', stage: 'SAVED', stageSource: 'MARK', stageLabel: '💾 Busca salva no Manheim', exactSearch: 'Q5', days: 1, matchCount: 0 }
] };
const LEAD = { ref: null, hasCalculatorRef: false, order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [], zip: '', timezone: 'America/New_York', goodHour: true, payment: null, plate: null, florida: true, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [], record: null };

async function open(page, width) {
  const posts = [];
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (route.request().method() === 'POST') { const body = JSON.parse(route.request().postData() || '{}'); posts.push({ path: url.pathname, body }); if (url.pathname === '/api/panel/pesquisas') return json({ reasons: {} }); return json({ ok: true }); }
    const map = { '/api/panel/config': { url: base + '/supabase-simulado', publishableKey: 'publica-teste' }, '/api/panel/session': { email: 'teste@example.test', role: 'admin', mustChangePassword: false },
      '/api/panel/today': TODAY, '/api/panel/whatsapp': WHATSAPP, '/api/panel/triage': TRIAGE, '/api/panel/pesquisas': PESQUISAS, '/api/panel/searches': SEARCHES, '/api/panel/lead': LEAD,
      '/api/panel/vitrine-requests': { requests: [], signals: [] }, '/api/panel/entry': { chats: [], reviews: [], contacts: [], journeys: [], printReviews: [], failedPrints: [] },
      '/api/panel/manheim-searches': { groups: [], review: [] } };
    if (map[url.pathname]) return json(map[url.pathname]);
    return json({ items: [], orders: [], demands: [], matches: [], groups: [], chats: [], reviews: [], review: [], counts: { periodLeads: 0, situations: {}, sections: {} }, requests: [], meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#today-list .case-card').first()).toBeVisible({ timeout: 30000 });
  return posts;
}
const noOverflow = async (page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

for (const width of [1280, 390]) {
  test(`${width}px · ATENDIMENTO: um caso por pessoa, motivos reunidos, filtros e contagem iguais à lista`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    const posts = await open(page, width);
    await expect(page.locator('nav [data-view]')).toHaveText([/^TODOS/, /^V1/, /^V2/, /BUSCAR CARROS/, /ENVIAR OPÇÕES/, /IMPORTAÇÕES/]);
    await expect(page.locator('nav [data-view="today"]')).toHaveAttribute('aria-current', 'page');
    // ATENDIMENTO em lista: every case in one list (the bucket pills were removed), one row per case.
    const list = page.locator('#today-list');
    await expect(page.locator('[data-attend-bucket]')).toHaveCount(0);
    await expect(list.locator('.case-card')).toHaveCount(5, { timeout: 30000 });
    await expect(page.locator('[data-count="today"]')).toHaveText('5');
    // Ana appears once (ficha + calculator order + link suggestion are one case), with every reason.
    const ana = list.locator('.case-card', { hasText: 'Ana Valor' });
    await expect(ana).toHaveCount(1);
    // The waiting time only comes with its channel ("WhatsApp há 3 h · sem resposta"); without one, "Sem resposta".
    await expect(ana.locator('.attend-wait')).toContainText('Sem resposta');
    await expect(ana.locator('.attend-wait')).toContainText('Confirmar vínculo');
    await expect(ana.locator('.case-decisions')).toContainText('Ligar pedido à ficha');
    await expect(ana.locator('.origin-chip')).toHaveCount(0);
    await expect(ana.locator('.attend-car .attend-l2')).toHaveCount(1);
    // No gold button any more: the whole row opens what it opened.
    await expect(ana.locator('.today-primary')).toHaveCount(0);
    // The rest of the card is one click away (never lost).
    await expect(ana.locator('.case-more')).toHaveCount(1);
    // The same statuses as before, in the Espera column.
    const bruno = list.locator('.case-card', { hasText: 'Bruno Ambos' });
    await expect(bruno.locator('.attend-wait')).toContainText('Agendado');
    const carla = list.locator('.case-card', { hasText: 'Carla Direta' });
    await expect(carla).toHaveCount(1);
    // The incomplete direct request shows what is missing (after the requests load), in "Falta p/ buscar".
    await expect(carla.locator('.attend-lacks')).toContainText('Ano', { timeout: 30000 });
    await expect(carla.locator('.attend-lacks')).toContainText('Milhagem');
    await noOverflow(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `atendimento-${width}.png`), fullPage: width !== 390 });
    // Open a ficha by its row and come back: same list, same place.
    const reply = list.locator('.case-card', { hasText: 'Davi Direto' }).locator('.attend-car');
    await reply.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => window.scrollY);
    // The list is compact: at 1280px all five rows fit without scrolling; on the phone it scrolls.
    if (width === 390) expect(before).toBeGreaterThan(0);
    await reply.click();
    await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 30000 });
    await page.locator('#detail-back').click();
    await expect(page.locator('#today-panel')).toBeVisible();
    await expect(list.locator('.case-card')).toHaveCount(5);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
    // Nothing was sent.
    // Nothing was sent (reading saved translations is a read, not a message).
    expect(posts.filter((post) => /reply|v1-send|whatsapp/.test(post.path) || (post.path === '/api/panel/suggestions' && post.body.action !== 'cached')).map((post) => post.path + ' ' + post.body.action)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test(`${width}px · BUSCAR CARROS: dois tipos em colunas, pessoa com os dois, leitura da IA como evidência, resultado separado do andamento`, async ({ page }) => {
    const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
    await open(page, width);
    await page.locator('nav [data-view="requests"]').click();
    const valor = page.locator('#requests-valor'), carro = page.locator('#requests-carro');
    await expect(valor.locator('.request-card')).toHaveCount(2, { timeout: 30000 });
    await expect(carro.locator('.request-card')).toHaveCount(2);
    // One person with both types: one request in each column and one ficha.
    await expect(valor.locator('.request-card', { hasText: 'Bruno Ambos' })).toHaveCount(1);
    await expect(carro.locator('.request-card', { hasText: 'Bruno Ambos' })).toHaveCount(1);
    await expect(page.locator('#requests-totals')).toContainText('4 pedidos de 3 pessoas');
    await expect(page.locator('#requests-totals')).toContainText('1 incompletos em Atendimento');
    await expect(page.locator('.tab[data-view="requests"] [data-count]')).toHaveText('4');
    // The AI reading of the same request is evidence, labelled as not confirmed.
    const g63 = carro.locator('.request-card', { hasText: 'G63' });
    await expect(g63.locator('.request-ai-evidence > summary')).toContainText('Leitura da conversa pela IA (não confirmada) · mesmos critérios · 2 versões');
    // Result in the batch apart from the work stage; never "Falta buscar" next to valid options.
    await expect(g63).toContainText(/opç(ão|ões) no lote/);
    await expect(g63).toContainText('Salvar busca no Manheim');
    await expect(page.locator('#requests-panel')).not.toContainText('Falta buscar');
    await expect(carro.locator('.request-card', { hasText: 'Davi Direto' })).toContainText('Resultado no lote: AINDA NÃO COMPARADO COM O LOTE');
    // Direct incomplete stays in ATENDIMENTO; unknown type goes to review (never to "por valor").
    await expect(page.locator('#requests-list')).not.toContainText('Toyota RAV4');
    await expect(page.locator('#requests-incomplete-note')).toContainText('1 pedido incompleto');
    await expect(valor).not.toContainText('BMW X3');
    await page.locator('#buscas-review > summary').click();
    await expect(page.locator('#requests-review')).toContainText('Tipo de busca não definido no pedido');
    // Chips count the same set as the columns.
    await expect(page.locator('[data-request-state="ALL"] span')).toHaveText('4');
    await page.locator('[data-request-state="COM_OPCOES"]').click();
    await expect(page.locator('#requests-list .request-card')).toHaveCount(2);
    // Equal columns on the computer; separate blocks on the phone.
    const [left, right] = await Promise.all(['#search-col-valor', '#search-col-carro'].map((selector) => page.locator(selector).boundingBox()));
    if (width >= 1000) { expect(Math.abs(left.width - right.width)).toBeLessThan(2); expect(left.y).toBe(right.y); }
    else expect(right.y).toBeGreaterThan(left.y + left.height - 1);
    await noOverflow(page);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `buscar-carros-${width}.png`), fullPage: width !== 390 });
    expect(errors).toEqual([]);
  });
}

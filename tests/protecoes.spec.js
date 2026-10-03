'use strict';

// Painel no navegador, com /api/** simulado e dados fictícios (nada é gravado nem enviado):
//  - IMPORTAÇÕES: Ref do print à vista, quatro estados, "já resolvidos"
//  - ATENDIMENTO: conversas sem Ref num bloco só, por assunto; filtro de assunto; fonte indisponível dita na tela
//  - CLIENTES: exportação completa, uma por vez, falha dita; volta da ficha com as páginas carregadas
//  - FICHA: resposta atrasada de outra ficha não desenha por cima
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/protecoes.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(90000);

const uid = (n) => `7f000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hoursAgo = (hours) => new Date(Date.now() - hours * 3600000).toISOString();
const origin = (group, sub) => ({ group, sub, key: `${group}:${sub}`, groupLabel: group, subLabel: sub, label: `${group === 'CALCULADORA' ? 'Veio pela calculadora' : 'Veio por mensagem'} · ${sub === 'SMS' ? 'Via SMS' : 'Via WhatsApp'}`, financing: false });
const subject = (key, label) => ({ key, label, source: 'CLAUDE', state: 'OK', reason: 'lido' });
const person = (n, name, subjectValue, extra = {}) => ({ kind: 'JOURNEY', id: uid(n), journeyId: uid(n), name, contact: { display_name: name }, phones: [{ phone_e164: `+1305555${String(1000 + n)}`, is_primary: true }], awaitingReply: false,
  group: { key: 'ATENDIDO', label: 'Atendidos', origin: origin('MENSAGEM', 'WHATSAPP'), unattended: null, hasCalculator: false, subject: subjectValue }, ...extra });

async function open(page, handlers = {}) {
  const calls = [];
  await page.addInitScript(() => { localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })); });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push({ path: url.pathname, search: url.search, method: route.request().method() });
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    const handler = handlers[url.pathname];
    if (handler) { const out = await handler({ url, json, route, calls }); if (out !== undefined) return out; return; }
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], suggestions: [], errors: [], counts: {}, page: { total: 0 }, requests: [], meta: {} });
  });
  return calls;
}

test('IMPORTAÇÕES mostra a Ref do print, diferencia os estados e lista os já resolvidos', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  await open(page, { '/api/panel/entry': ({ json }) => json({ chats: [], reviews: [], printReviews: [], contacts: [], journeys: [], chatAliases: [], senderAliases: [],
    failedPrints: [
      { id: uid(1), filename: 'IMG_9241.jpeg', createdAt: hoursAgo(2), errorCode: null, state: 'LIDO_FALTA_IDENTIFICAR', pendingReason: null, refMatch: { journeyId: uid(50), name: 'Harman Harman' }, name: 'Herman Harman', phone: null, ref: 'CG8LN', message: 'Hello! I just sent a vehicle search request', translation: '' },
      { id: uid(2), filename: 'IMG_9254.png', createdAt: hoursAgo(30), errorCode: 'AI_DAILY_LIMIT', state: 'NAO_LIDO', pendingReason: null, refMatch: null, name: null, phone: null, ref: null, message: '', translation: '' },
      { id: uid(3), filename: 'IMG_9300.png', createdAt: hoursAgo(3), errorCode: null, state: 'LIDO_FALTA_IDENTIFICAR', pendingReason: null, refMatch: null, name: 'Nina', phone: null, ref: 'QWRT7', message: 'Hi', translation: '' }
    ],
    printResolved: [
      { id: uid(4), filename: 'IMG_9243.png', at: hoursAgo(5), state: 'JA_VINCULADO', ref: 'CG8LN', journeyId: uid(50), clientName: 'Harman Harman', journeyRef: 'CG8LN' },
      { id: uid(5), filename: 'IMG_9262.png', at: hoursAgo(5), state: 'REGISTRO_REPETIDO', ref: null, journeyId: uid(51), clientName: 'Maria', journeyRef: null }
    ] }) });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  await page.locator('[data-view="imports"]').click();
  const cards = page.locator('#imports-review-queue .failed-print');
  await expect(cards).toHaveCount(3, { timeout: 30000 });
  const known = cards.filter({ hasText: 'Herman Harman' });
  await expect(known).toContainText('Ref do print: CG8LN');
  await expect(known).toContainText('já pertence à ficha de Harman Harman');
  await expect(known).not.toContainText('Não existe cliente');
  await expect(cards.filter({ hasText: 'IMG_9254' })).toContainText('Não foi possível ler');
  await expect(cards.filter({ hasText: 'IMG_9254' })).toContainText('tenta de novo sozinho');
  const unknownRef = cards.filter({ hasText: 'Nina' });
  await expect(unknownRef).toContainText('Ref do print: QWRT7');
  await expect(unknownRef).toContainText('ainda não pertence a nenhuma ficha aberta');
  const resolved = page.locator('#imports-review-queue details.resolved-prints');
  await expect(resolved).toContainText('Prints já resolvidos nos últimos 14 dias (2)');
  await resolved.locator('summary').click();
  await expect(resolved).toContainText('Já vinculado · Ref CG8LN · Harman Harman');
  await expect(resolved).toContainText('Registro repetido');
  expect(errors).toEqual([]);
});

test('ATENDIMENTO: conversas sem Ref num bloco só por assunto, filtro de assunto e fonte indisponível dita', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const items = [
    person(1, 'Ana Financia', subject('FINANCIAMENTO', 'Financiamento')),
    person(2, 'Bruno Carro', subject('PEDIDO_CARRO', 'Pedido de carro')),
    person(3, 'Carla Oi', subject('SO_CUMPRIMENTO', 'Só cumprimentou')),
    person(4, 'Davi Outro', subject('OUTROS', 'Outros assuntos')),
    person(5, 'Eva Nova', { key: 'NAO_IDENTIFICADO', label: 'Ainda não identificado', source: null, state: 'PENDENTE', reason: null }),
    person(6, 'Fábio Calc', subject('FINANCIAMENTO', 'Financiamento'), { group: { key: 'ATENDIDO', label: 'Atendidos', origin: origin('CALCULADORA', 'SMS'), unattended: null, hasCalculator: true, calcMode: null, subject: subject('FINANCIAMENTO', 'Financiamento') } })
  ];
  await open(page, { '/api/panel/today': ({ json }) => json({ items, degraded: ['assunto e identidade'], meta: {} }) });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('#attend-filters [data-attend-bucket="todos"]').click({ timeout: 30000 });
  // One grid, no section headers: the order is kept (conversations without Ref by subject) and each card carries its area.
  await expect(page.locator('#today-list .contact-group-flat')).toHaveCount(1, { timeout: 30000 });
  await expect(page.locator('#today-list .contact-area-head, #today-list .contact-subject-head')).toHaveCount(0);
  const semRef = page.locator('#today-list .today-card[data-area="SEM_REF"]');
  await expect(semRef).toHaveCount(5);
  expect(await semRef.evaluateAll((cards) => cards.map((card) => card.dataset.subject))).toEqual(['FINANCIAMENTO', 'PEDIDO_CARRO', 'SO_CUMPRIMENTO', 'OUTROS', 'NAO_IDENTIFICADO']);
  // origin Calculadora with subject Financiamento stays in the calculator area; the lean card says which calculator, not the subject
  const calc = page.locator('#today-list .today-card[data-area="CALC_SEM_TIPO"]');
  await expect(calc).toContainText('Fábio Calc');
  await expect(calc.locator('.case-calculator')).toHaveCount(1);
  await expect(calc.locator('.subject-chip')).toHaveCount(0);
  await expect(page.locator('#triage-state')).toContainText('assunto e identidade (desatualizado)');
  // the subject filter narrows the list and says so when empty
  await page.locator('#today-subject').selectOption('SO_CUMPRIMENTO');
  await expect(page.locator('#today-list .today-card')).toHaveCount(1);
  await expect(page.locator('#today-list')).toContainText('Carla Oi');
  expect(errors).toEqual([]);
});

const CLIENT_BASE = (n, name) => ({ id: uid(n), contact: { display_name: name, is_lead: true }, display_name: name, stage: 'RESPONDIDO', status: 'ATIVO', enabled: true, heat: 'WARM', isLead: true, situation: 'IN_PROGRESS', checklistSummary: { completed: 1 }, lastRealMessageAt: hoursAgo(5),
  group: { key: 'ATENDIDO', label: 'Atendidos', origin: origin('MENSAGEM', 'WHATSAPP'), unattended: null, hasCalculator: false, subject: subject('OUTROS', 'Outros assuntos') } });
const ALL = Array.from({ length: 7 }, (_, index) => CLIENT_BASE(100 + index, `Cliente ${index + 1}`));

function recordsHandler(state, { pageSize = 3 } = {}) {
  return async ({ url, json }) => {
    if (url.searchParams.get('id')) return json({});
    if (url.searchParams.get('export') === '1') await new Promise((resolve) => setTimeout(resolve, 400));
    state.records.push(url.search);
    // the server may cap the page: the export keeps asking until there is no more
    const size = url.searchParams.get('export') === '1' ? Math.min(Number(url.searchParams.get('pageSize')), pageSize) : pageSize;
    const pageNumber = Number(url.searchParams.get('page') || 1);
    const items = ALL.slice((pageNumber - 1) * size, pageNumber * size);
    return json({ items, page: pageNumber, pageSize: size, total: ALL.length, hasMore: pageNumber * size < ALL.length, counts: { periodLeads: 7, allLeads: 7, shownLeads: 7, nonLeads: 0, situations: { IN_PROGRESS: 7 }, sections: { ATENDIDO: 7 }, areas: { ATENDIDO: { SEM_REF: 7 } } }, pending: {}, meta: {} });
  };
}

test('CLIENTES: a exportação traz todas as páginas, é uma por vez e mostra a falha', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const state = { records: [], fail: false };
  const inner = recordsHandler(state);
  await open(page, { '/api/panel/records': (context) => { if (state.fail && context.url.searchParams.get('export') === '1' && context.url.searchParams.get('page') === '2') return context.json({ error: 'EXPORT_TEST_FAIL' }, 400); return inner(context); } });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="clients"]').click({ timeout: 30000 });
  await expect(page.locator('#clients-list .client-card').first()).toBeVisible({ timeout: 30000 });
  const download = page.locator('#clients-download');
  const waiting = page.waitForEvent('download');
  await download.click();
  await expect(download).toBeDisabled();
  await download.click({ force: true }).catch(() => {});
  const file = await waiting;
  const stream = await file.createReadStream();
  const chunks = []; for await (const chunk of stream) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  for (let index = 1; index <= 7; index += 1) expect(text).toContain(`Cliente ${index}`);
  expect(state.records.filter((search) => /export=1/.test(search)).length, 'três páginas de 3, 3 e 1').toBe(3);
  await expect(download).toBeEnabled();
  expect(state.records.filter((search) => /export=1/.test(search) && /[?&]page=1(&|$)/.test(search)).length, 'o segundo clique durante a exportação não pediu de novo').toBe(1);
  // a failure on a middle page is said, nothing is downloaded, and the button comes back
  state.fail = true;
  await download.click();
  await expect(page.locator('.export-error')).toContainText('Não foi possível baixar a planilha', { timeout: 30000 });
  await expect(download).toBeEnabled();
  expect(errors).toEqual([]);
});

test('FICHA: resposta atrasada de outra ficha não desenha por cima da ficha aberta', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const lead = (name) => ({ ref: 'ABC23', hasCalculatorRef: false, order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [], zip: '', state: null, city: null, timezone: 'America/New_York',
    goodHour: true, payment: 'cash', paymentKnown: null, deadlineKnown: null, zipKnown: false, plate: 'transf', florida: true, maxBidCents: null, totalCeilingCents: null, bid: null, costs: null, score: null, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [],
    record: { id: uid(1), stage: 'RESPONDIDO', status: 'ATIVO', enabled: true, contact: { display_name: name }, phones: [], attachments: [], returns: [], conversation: [], units: [] } });
  const release = {};
  await open(page, { '/api/panel/lead': async ({ url, json }) => {
    const id = url.searchParams.get('id');
    if (id === uid(1)) await new Promise((resolve) => { release.first = resolve; });
    return json(lead(id === uid(1) ? 'PESSOA ANTIGA' : 'PESSOA NOVA'));
  } });
  await page.goto(base + '/painel/#ficha/' + uid(1), { waitUntil: 'domcontentloaded' });
  await expect.poll(() => Boolean(release.first), { timeout: 30000 }).toBe(true);
  // opens another ficha while the first answer is still on its way
  await page.evaluate((id) => { location.hash = '#ficha/' + id; }, uid(2));
  await expect(page.locator('#record-detail')).toContainText('PESSOA NOVA', { timeout: 30000 });
  release.first();
  await page.waitForTimeout(800);
  await expect(page.locator('#record-detail')).toContainText('PESSOA NOVA');
  await expect(page.locator('#record-detail')).not.toContainText('PESSOA ANTIGA');
  expect(errors).toEqual([]);
});

test('CLIENTES: ao voltar da ficha as páginas carregadas e a posição voltam, além dos primeiros itens', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const state = { records: [] };
  const lead = { ref: 'ABC23', hasCalculatorRef: false, order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [], zip: '', state: null, city: null, timezone: 'America/New_York',
    goodHour: true, payment: 'cash', paymentKnown: null, deadlineKnown: null, zipKnown: false, plate: 'transf', florida: true, maxBidCents: null, totalCeilingCents: null, bid: null, costs: null, score: null, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [],
    record: { id: uid(106), stage: 'RESPONDIDO', status: 'ATIVO', enabled: true, contact: { display_name: 'Cliente 7' }, phones: [], attachments: [], returns: [], conversation: [], units: [] } };
  const inner = recordsHandler(state, { pageSize: 3 });
  await open(page, { '/api/panel/records': (context) => inner(context), '/api/panel/lead': ({ json }) => json(lead) });
  await page.setViewportSize({ width: 1000, height: 500 });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="clients"]').click({ timeout: 30000 });
  const cards = page.locator('#clients-list .client-card');
  await expect(cards).toHaveCount(3, { timeout: 30000 });
  while ((await cards.count()) < 7) { await page.locator('#clients-list .clients-more').click(); await page.waitForTimeout(300); }
  await expect(cards).toHaveCount(7);
  const last = page.locator(`#clients-list .client-card[data-journey-id="${uid(106)}"]`);
  await last.scrollIntoViewIfNeeded();
  await last.locator('button', { hasText: 'Abrir ficha' }).click();
  await expect(page.locator('#record-detail')).toContainText('Cliente 7', { timeout: 30000 });
  await page.goBack();
  // every page that was loaded is back, and the person who was on screen is in view
  await expect(page.locator('#clients-list .client-card')).toHaveCount(7, { timeout: 30000 });
  await expect(last).toBeInViewport({ timeout: 30000 });
  expect(errors).toEqual([]);
});

// A 1x1 PNG: the page reduces it to a JPEG before sending, like any photo.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const V2_LIST = (photoCountA) => ({ v2: [
  { vitrineId: uid(201), customerName: 'Alana', referenceCode: '9BN8J', link: 'https://example.test/v2a', cars: [{ carId: uid(211), vehicle: 'Porsche Macan', photoCount: photoCountA }] },
  { vitrineId: uid(202), customerName: 'Bia', referenceCode: 'CMYH6', link: 'https://example.test/v2b', cars: [{ carId: uid(212), vehicle: 'BMW X3', photoCount: 0 }] }
] });

test('FOTOS V2: destino e arquivos ficam fixos durante o envio; resultado incerto confere o gravado antes de reenviar', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  const state = { uploads: [], photoCountA: 0, mode: 'slow' };
  await open(page, {
    '/api/panel/vitrines': ({ json }) => json(V2_LIST(state.photoCountA)),
    '/api/panel/vitrine-photos': async ({ url, json, route }) => {
      state.uploads.push({ vitrineId: url.searchParams.get('vitrineId'), carId: url.searchParams.get('carId') });
      if (state.mode === 'slow') { await new Promise((resolve) => setTimeout(resolve, 900)); state.photoCountA += 1; return json({ ok: true }); }
      // uncertain: the photo IS saved but the answer never arrives
      state.photoCountA += 1;
      return route.abort('failed');
    }
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="imports"]').click({ timeout: 30000 });
  const select = page.locator('#import-v2-select');
  await expect(select.locator('option')).toHaveCount(3, { timeout: 30000 });
  await select.selectOption(`${uid(201)}|${uid(211)}`);
  const file = (name) => ({ name, mimeType: 'image/png', buffer: PNG });
  await page.locator('#import-v2-file').setInputFiles([file('a.png'), file('b.png')]);
  await expect(page.locator('#import-v2-send')).toContainText('Enviar 2 foto(s)', { timeout: 30000 });
  await page.locator('#import-v2-send').click();
  await page.locator('.inline-confirm button', { hasText: 'Salvar fotos' }).click();
  // while it uploads the destination and the files cannot be changed
  await expect(select).toBeDisabled();
  await expect(page.locator('#import-v2-file')).toBeDisabled();
  await expect(page.locator('#import-v2-status')).toContainText('2 foto(s) enviada(s)', { timeout: 30000 });
  expect(state.uploads).toEqual([{ vitrineId: uid(201), carId: uid(211) }, { vitrineId: uid(201), carId: uid(211) }]);
  await expect(select).toBeEnabled();
  // uncertain answer: 2 photos queued, the first one is saved but the answer is lost
  state.mode = 'uncertain'; state.uploads.length = 0;
  await select.selectOption(`${uid(201)}|${uid(211)}`);
  await page.locator('#import-v2-file').setInputFiles([file('c.png'), file('d.png')]);
  await expect(page.locator('#import-v2-send')).toContainText('Enviar 2 foto(s)', { timeout: 30000 });
  await page.locator('#import-v2-send').click();
  await page.locator('.inline-confirm button', { hasText: 'Salvar fotos' }).click();
  await expect(page.locator('#import-v2-status')).toContainText('Conferido: 1 foto(s) já estavam gravadas', { timeout: 30000 });
  await expect(page.locator('#import-v2-send')).toContainText('Enviar 1 foto(s)');
  expect(state.uploads.length, 'só a primeira foi enviada antes da conferência').toBe(1);
  expect(errors).toEqual([]);
});

test('ATENDIMENTO: recusa automática de sugestão tem "Desfazer recusa" visível (suggestion_restore)', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  let restored = null, rejected = [{ id: uid(70), phone: '+13055550000', suggestedRef: 'FMLNA', writtenRefs: ['WSR3X'], at: hoursAgo(1), sourceName: 'Ivan' }];
  await open(page, { '/api/panel/whatsapp': async ({ json, route }) => {
    if (route.request().method() === 'POST') { restored = JSON.parse(route.request().postData()); rejected = []; return json({ restored: true }); }
    return json({ suggestions: [], phoneReviews: [], errors: [], itemErrors: [], ignored: [], autoRejected: rejected });
  } });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  const box = page.locator('#whatsapp-auto-rejected');
  await expect(box).toBeVisible({ timeout: 30000 });
  await box.locator('summary').click();
  await expect(box).toContainText('FMLNA');
  await expect(box).toContainText('WSR3X');
  await box.getByRole('button', { name: 'Desfazer recusa' }).click();
  await expect.poll(() => restored && restored.action).toBe('suggestion_restore');
  expect(restored.id).toBe(uid(70));
  expect(errors).toEqual([]);
});

test('IMPORTAÇÕES: mensagem da calculadora na fila mostra motivo, evidência e candidatas lado a lado', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  let posted = null;
  await open(page, {
    '/api/panel/entry': ({ json }) => json({ chats: [], reviews: [], printReviews: [], failedPrints: [], printResolved: [], contacts: [], journeys: [], chatAliases: [], senderAliases: [],
      calcQueue: [{ messageId: uid(80), reason: 'FILA_VARIAS_FICHAS', reasonText: 'O telefone tem mais de uma ficha: escolha a ficha (nada foi escolhido sozinho)', refState: 'REF_ILEGIVEL', ref: null, evidence: { name: 'Bruno Lima', vehicle: 'Dodge Challenger' }, channel: 'SMS', text: 'Hello! I just ran a simulation on the My Car Scout calculator\nRef: -----',
        candidates: [{ journeyId: uid(81), name: 'Bruno Lima', ref: 'AB2CD', vehicle: 'Honda Civic' }, { journeyId: uid(82), name: 'Bruno Lima', ref: null, vehicle: 'Dodge Challenger' }] }] }),
    '/api/panel/calc-route': async ({ json, route }) => { posted = JSON.parse(route.request().postData()); return json({ linked: true }); }
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  await page.locator('[data-view="imports"]').click();
  const card = page.locator('#imports-review-queue .calc-queue');
  await expect(card).toHaveCount(1, { timeout: 30000 });
  await expect(card).toContainText('mais de uma ficha');
  await expect(card).toContainText('Ref ilegível na origem');
  await expect(card.locator('.calc-candidate')).toHaveCount(2);
  await card.locator('.calc-candidate').nth(1).getByRole('button', { name: 'Ligar a esta ficha' }).click();
  await expect.poll(() => posted && posted.journeyId).toBe(uid(82));
  expect(posted.action).toBe('link');
  expect(errors).toEqual([]);
});

test('ATENDIMENTO: candidata a fora da MCS aparece com motivo e frase, e só sai com a confirmação', async ({ page }) => {
  const errors = []; page.on('pageerror', (failure) => errors.push(failure.message));
  let posted = null;
  await open(page, { '/api/panel/triage': async ({ json, route }) => {
    if (route.request().method() === 'POST') { posted = JSON.parse(route.request().postData()); return json({ journeyId: uid(90), review: 'CONFIRMADO', triageIds: [uid(91)] }); }
    return json({ state: 'DESLIGADA', review: [], out: [], offTopic: [], offMcs: [{ journeyId: uid(90), name: 'Primo Zé', category: 'PESSOAL', label: 'Assunto pessoal', reason: 'Conversa de família sobre uma festa', quote: 'a festa da vovó é sábado' }] });
  } });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 30000 });
  const card = page.locator('.offmcs-item');
  await expect(card).toHaveCount(1, { timeout: 30000 });
  await expect(card).toContainText('Conversa de família sobre uma festa');
  await expect(card).toContainText('a festa da vovó é sábado');
  expect(posted).toBe(null);
  await page.locator('#today-list .case-card', { has: card }).first().locator('.case-more > summary').click();
  await card.getByRole('button', { name: 'Confirmar fora da MCS' }).click();
  await expect.poll(() => posted && posted.action).toBe('offmcs_confirm');
  expect(posted.journeyId).toBe(uid(90));
  expect(errors).toEqual([]);
});

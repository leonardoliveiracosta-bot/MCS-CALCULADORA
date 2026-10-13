'use strict';

// ENVIAR OPÇÕES: tocar no cartão da fila abre "Opções do cliente" (não a ficha). Topo com nome, REF, telefone
// e cidade; o que o cliente pediu; uma lista só, com as abas Lane/Run, Buy Now / Make Offer e Informação
// incompleta (as mesmas páginas de manheim-options que alimentam o PDF e a V1 da ficha) e o Ordenar com 6
// opções; barra com "X de 10 selecionados", Baixar PDF, Montar V2 (só depois do toque na V1) e Gerar V1.
// O número do cartão da fila é o total das abas. Buy Now mostra até quando vale, nunca "leilão" no passado.
// /api/** simulado.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/opcoes-cliente.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const HOUR = 3600000;
const ago = (hours) => new Date(Date.now() - hours * HOUR).toISOString();
const ahead = (hours) => new Date(Date.now() + hours * HOUR).toISOString();
const id = (n) => `6e300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n, name, ref, phone) => ({
  id: id(n), reference_code: ref, status: 'ATIVO', stage: 'RESPONDIDO', enabled: true, name, contact: { display_name: name },
  phones: [{ phone_e164: phone, is_primary: true, is_current: true }], created_at: ago(48),
  simulations: [{ occurredAt: ago(30), zip: '72012 — Beebe, AR' }], contactAt: ago(n), contactMedium: 'WHATSAPP', contactChannel: 'WHATSAPP', latestMessage: { direction: 'CUSTOMER', occurred_at_utc: ago(n) }
});
const JJ = person(1, 'JJ', 'AMQV5', '+18705941027');
const TAP = person(2, 'Tina Tocou', 'TAP22', '+13055550102');
const wish = [{ make: 'Jeep', model: 'Grand Cherokee L', yearMin: 2020, yearMax: 2023, minMiles: 0, maxMiles: 135000 }];
const demand = (who, offer) => ({ key: `journey:${who.id}:CARRO`, mode: 'CARRO', targetType: 'JOURNEY', journeyId: who.id, ref: null, name: who.name, wishes: wish, issues: [], matchCount: offer.lane + offer.offLane + offer.incomplete, compared: true, offer: { selected: 0, selectedIds: [], max: 10, ...offer } });
const manheim = {
  items: [JJ, TAP], orders: [], targets: [], uploads: [], undoAvailable: true,
  demands: [demand(JJ, { lane: 114, offLane: 13, incomplete: 0 }), demand(TAP, { lane: 2, offLane: 0, incomplete: 0 })],
  review: [], upload: { id: id(90), vehicle_count: 500, matched_vehicle_count: 129, uploaded_at: ago(2), current_lead_count: 2 },
  counts: { VALOR: { demands: 0, served: 0, matches: 0 }, CARRO: { demands: 2, served: 2, matches: 129 }, total: { people: 2, served: 2, matches: 129, review: 0 } }, meta: {}
};
// Tina tapped a car of her V1: Montar V2 is on for her (the same picker of the V1 tab).
const funnel = { v1: { tapped: [{ vitrineId: id(70), vitrineCarId: id(71), requestId: id(72), journeyId: TAP.id, referenceCode: 'TAP22', name: TAP.name, phone: '+13055550102', car: '2022 Jeep Grand Cherokee L', vin: '1C4RJKBG0N8000001', vitrineCars: [{ vitrineCarId: id(71), car: '2022 Jeep Grand Cherokee L', vin: '1C4RJKBG0N8000001', tapAt: ago(3) }], sentAt: ago(20), tapAt: ago(3) }], waiting: [], expired: [] }, v2: { bid: [], waiting: [], expired: [] }, counts: { v1Action: 1, v2Action: 0 } };
const laneCar = (n) => ({ id: id(1000 + n), match_kind: 'BATE', match_reason: 'Ano e milhas', vehicle_json: { parsed: { vin: 'LANE' + String(n).padStart(13, '0'), year: 2023, make: 'Jeep', model: 'Grand Cherokee L', trim: 'Limited', miles: 20000 + n, location: 'TN - Manheim Nashville', startsAt: ahead(24), lane: '3', run: String(n) } }, offer: { status: 'AVAILABLE', mmrCents: 2720000, defaultPct: 2.5, finalCents: 2788000 } });
// The Buy Now of the JJ case: listed on 02/10 17:00 and open until 08/10 09:00 (Florida).
const buyNow = { id: id(2001), match_kind: 'BATE', match_reason: 'Ano e milhas', vehicle_json: { parsed: { vin: 'BUYN0000000000001', year: 2023, make: 'Jeep', model: 'Grand Cherokee L', trim: 'Limited', miles: 23171, location: 'PA - Manheim Pennsylvania', startsAt: ago(100), saleDate: ago(100), endsAt: ahead(40), lane: '', run: '', buyNowPrice: '28001' } }, offer: { status: 'AVAILABLE', mmrCents: 2670000, defaultPct: 2.5, finalCents: 2736750 } };

test.describe('toque real no celular e seleção ao voltar', () => {
  test.use({ hasTouch: true, isMobile: true });
  test('toque abre e fecha o carro; ordenar, voltar e reabrir preserva a seleção', async ({ page }) => {
    const calls={pages:[],posts:[]},errors=[];page.on('pageerror',e=>errors.push(e.message));
    await openPanel(page,{width:390,calls});
    const client=page.locator('#options-queue .options-queue-card',{hasText:'JJ'}).locator('.options-queue-name');
    await client.tap();
    const screen=page.locator('#options-client'),row=screen.locator('.oc-row').first(),detail=screen.locator('.oc-detail').first(),count=screen.locator('.oc-count');
    await expect(row).toBeVisible();await row.locator('.oc-car').tap();await expect(detail).toBeVisible();
    await row.locator('.oc-car').tap();await expect(detail).toBeHidden();
    await row.locator('input[type="checkbox"]').tap();await expect(count).toHaveText('1 de 10 selecionados');
    expect(calls.posts).toHaveLength(1);
    await screen.locator('.oc-sort').selectOption('year_desc');await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    await expect(count).toHaveText('1 de 10 selecionados');await screen.getByRole('button',{name:'← Voltar'}).tap();
    await client.tap();await expect(count).toHaveText('1 de 10 selecionados');await expect(row.locator('input[type="checkbox"]')).toBeChecked();
    expect(calls.posts).toHaveLength(1);expect(errors).toEqual([]);
  });
});

async function openPanel(page, { width = 1366, calls }) {
  calls.selected = calls.selected || new Set();
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => { localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })); localStorage.removeItem('mcs_options_client_sort'); });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const json = (payload) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
    if (url.pathname === '/api/panel/config') return json({ url: base + '/supabase-simulado', publishableKey: 'publica-teste' });
    if (url.pathname === '/api/panel/session') return json({ email: 'teste@example.test', role: 'admin', mustChangePassword: false });
    if (url.pathname === '/api/panel/reply') {
      const body = JSON.parse(request.postData() || '{}'); (calls.replies ||= []).push(body);
      if (body.action === 'window') return json(calls.sms ? { channel: 'SMS', allowed: false, name: JJ.name, phone: '+18705941027' } : { allowed: true, openUntil: ahead(3), name: JJ.name, phone: '+18705941027', whatsappBase: 'https://wa.me/18705941027' });
      if (body.action === 'translate') return json({ en: 'Here are the options.', pt_back: 'Aqui estão as opções.' });
      if (body.action === 'sms_sent') return json({ recorded: true, messageId: id(900) });
      if (body.action === 'sms_undo') return json({ undone: true });
      return json({ ok: true, simulated: true });
    }
    if (url.pathname === '/api/panel/records' && url.searchParams.get('view') === 'manheim') {
      (calls.records ||= []).push(Object.fromEntries(url.searchParams));
      if (calls.recordsGate && url.searchParams.get('queue') === '1') await calls.recordsGate;
      const current = structuredClone(manheim);
      if(calls.people)current.items=calls.people;
      Object.assign(current.demands[0].offer, { selected: calls.selected.size, selectedIds: [...calls.selected] });
      return json(current);
    }
    if (url.pathname === '/api/panel/vitrine-funnel') {
      if(url.searchParams.get('queue')==='1') {
        calls.queueFunnel=(calls.queueFunnel||0)+1;
        if(calls.queueFunnelGate)await calls.queueFunnelGate;
        return json({journeys:[TAP.id],refs:['TAP22']});
      }
      if (!url.searchParams.has('summary')) calls.funnel = (calls.funnel || 0) + 1;
      if (calls.funnelGate && !url.searchParams.has('summary')) await calls.funnelGate;
      return json(funnel);
    }
    if (url.pathname === '/api/panel/manheim-searches') {
      calls.savedReads = (calls.savedReads || 0) + 1;
      return json({ groups: [{ key: 'CARRO:Jeep', mode: 'CARRO', make: 'Jeep', model: 'Grand Cherokee L', searches: 1, yearFrom: 2020, yearTo: 2023, milesFrom: 0, milesTo: 135000, leads: 2, percent: 100, clients: [], created: false }], review: [] });
    }
    if (url.pathname === '/api/panel/manheim-options' && request.method() === 'GET') {
      calls.pages.push(Object.fromEntries(url.searchParams));
      const group = url.searchParams.get('group'), offset = Number(url.searchParams.get('cursor') || 0), limit = Number(url.searchParams.get('limit'));
      const all = group === 'LANE' ? Array.from({ length: 114 }, (_, n) => laneCar(n)) : group === 'OFFLANE' ? [buyNow] : [];
      const options = all.slice(offset, offset + limit).map(original => {
        const car = structuredClone(original);
        const members = car.vehicle_json.parsed.memberMatchIds || [car.id];
        if (members.some(id => calls.selected.has(id))) car.offer.status = 'SELECTED';
        return car;
      });
      return json({ key: url.searchParams.get('key'), group, options, total: all.length, nextCursor: offset + limit < all.length ? String(offset + limit) : null, uploadedAt: ago(2) });
    }
    if (url.pathname === '/api/panel/manheim-options' && request.method() === 'POST') {
      // The panel's own background sync goes to the same route: only the selection actions are recorded.
      const body = JSON.parse(request.postData() || '{}'); if (['select', 'remove'].includes(body.action)) calls.posts.push(body);
      if (body.action === 'select') calls.selected.add(body.matchId);
      if (body.action === 'remove') calls.selected.delete(body.matchId);
      return json({ matchId: body.matchId, status: body.action === 'select' ? 'SELECTED' : 'AVAILABLE', manual: body.action === 'select' && Boolean(body.reason), manualReason: body.reason || null, manualPct: null, finalCents: 2788000, note: null, selectedCount: calls.selected.size });
    }
    if (url.pathname === '/api/panel/option-link' && request.method() === 'GET') return json(calls.opens || { exists: false, opens: 0, lastOpenAt: null });
    if (url.pathname === '/api/panel/option-link' && request.method() === 'POST') { calls.links = (calls.links || []).concat(JSON.parse(request.postData() || '{}')); return json({ code: 'c'.repeat(43), path: '/o/' + 'c'.repeat(43) }); }
    if (url.pathname === '/api/panel/lead' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() || '{}'); calls.lead = (calls.lead || []).concat(body);
      if (body.action === 'quick') { const at = new Date().toISOString(); calls.events = [{ event_type: 'QUICK_' + body.type, occurred_at: at }]; calls.results = { journeys: { ...(calls.results?.journeys || {}), [JJ.id]: { type: body.type, at } }, refs: {} }; }
      return json({ eventId: id(500), undoUntil: ahead(0.003), journeyId: JJ.id, duplicate: false });
    }
    if (url.pathname === '/api/panel/lead' && url.searchParams.get('lastResults') === '1') { calls.resultReads = (calls.resultReads || 0) + 1; return json(calls.results || { journeys: {}, refs: {} }); }
    if (url.pathname === '/api/panel/lead') return json({ ref: 'AMQV5', record: { id: JJ.id, stage: 'RESPONDIDO', contact: { display_name: 'JJ' }, phones: [], attachments: [], returns: [], conversation: [], units: [] }, order: null, notes: [], events: calls.events || [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [], calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [] });
    return json({ items: [], orders: [], matches: [], groups: [], chats: [], reviews: [], requests: [], demands: [], v1: {}, v2: {}, meta: {} });
  });
  await page.goto(base + '/painel/', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-view="searches"]').click();
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(calls.people?.length || 2, { timeout: 30000 });
}

test('fila com 800 clientes conserva linhas, filtro, ordem e clique, sem carregar o funil completo',async({page})=>{
  const calls={pages:[],posts:[],people:[JJ,TAP,...Array.from({length:798},(_,n)=>person(n+3,'Cliente '+(n+3),'REF'+(n+3),'+15550000000'))]};
  await openPanel(page,{calls});
  await expect(page.locator('#options-queue-count')).toContainText('800 na fila');
  await expect(page.locator('#options-queue')).toHaveAttribute('data-opening-timing',/"people":800/);
  expect(calls.funnel || 0).toBe(0);
  await page.locator('#options-queue-search').fill('Tina Tocou');
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(1);
  await expect(page.locator('#options-queue .options-queue-card')).toHaveAttribute('title',/V1 já enviada/);
  await page.locator('#options-queue-search').fill('');
  await page.locator('#options-queue-sort').selectOption('oldest');
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(800);
  await expect(page.locator('#options-queue .options-queue-name').first()).toHaveText('Cliente 800');
  await page.locator('#options-queue-search').fill('JJ');
  await page.locator('#options-queue .options-queue-card').getByRole('button',{name:'Ver opções',exact:true}).click();
  await expect(page.locator('#options-client .oc-row').first()).toBeVisible();
  expect(calls.funnel).toBe(1);
  expect(calls.posts).toHaveLength(0);
});

test('abertura: fila usa só os estados; V1/V2 completo só ao abrir cliente e compartilha a leitura', async ({ page }) => {
  let releaseRecords, releaseFunnel;
  const calls = { pages: [], posts: [], recordsGate: new Promise((resolve) => { releaseRecords = resolve; }), funnelGate: new Promise((resolve) => { releaseFunnel = resolve; }) };
  const opening = openPanel(page, { calls });
  try {
    await expect.poll(() => calls.records?.filter((r) => r.queue === '1').length || 0).toBe(1);
    await expect.poll(() => calls.queueFunnel || 0).toBe(1);
    expect(calls.funnel || 0).toBe(0);
    expect(calls.records.some((r) => r.queue === '1')).toBe(true);
    releaseRecords();
    await opening;
    const card = page.locator('#options-queue .options-queue-card', { hasText: 'JJ' });
    expect(calls.funnel || 0).toBe(0);
    await expect(page.locator('#options-queue .options-queue-card',{hasText:'Tina Tocou'})).toHaveAttribute('title',/V1 já enviada/);
    await card.locator('.options-queue-name').click();
    await expect.poll(() => calls.funnel || 0).toBe(1);
    await expect(page.locator('#options-client')).toContainText('Carregando as opções');
  } finally { releaseRecords(); releaseFunnel(); }
  await expect(page.locator('#options-client .oc-row').first()).toBeVisible();
  await page.locator('#options-client').getByRole('button',{name:'← Voltar'}).click();
  await page.locator('#options-queue .options-queue-card', {hasText:'Tina Tocou'}).locator('.options-queue-name').click();
  await expect(page.locator('#options-client .oc-act').getByRole('button',{name:'Montar V2',exact:true})).toBeEnabled();
  expect(calls.queueFunnel).toBe(1);
  expect(calls.funnel).toBe(1);
});

test('buscas salvas: nenhuma leitura com bloco fechado; abrir e reabrir conserva conteúdo e cache', async ({ page }) => {
  const calls = { pages: [], posts: [] };
  await openPanel(page, { calls });
  expect(calls.savedReads || 0).toBe(0);
  const box = page.locator('#buscas-saved-box');
  await box.locator('summary').click();
  await expect(box.locator('.saved-search-line')).toHaveCount(1);
  await expect(box).toContainText('Jeep Grand Cherokee L');
  expect(calls.savedReads).toBe(1);
  await box.locator('summary').click();
  await box.locator('summary').click();
  await expect(box.locator('.saved-search-line')).toHaveCount(1);
  expect(calls.savedReads).toBe(1);
  await expect(page.locator('#options-queue .options-queue-card')).toHaveCount(2);
});

for (const sms of [false, true]) test(`ENVIAR OPÇÕES: caixa ${sms ? 'SMS' : 'WhatsApp'} separada da V1, sem perder carros ou rascunho`, async ({ page }) => {
  const calls = { pages: [], posts: [], sms };
  await openPanel(page, { calls });
  const client = page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).locator('.options-queue-name');
  await client.click();
  const screen = page.locator('#options-client'), box = screen.locator('.reply-composer');
  await expect(box).toBeVisible();
  await screen.locator('.oc-row').first().locator('input[type="checkbox"]').check();
  await box.locator('textarea').first().fill('Aqui estão as opções.');
  await box.getByRole('button', { name: 'Traduzir', exact: true }).click();
  await expect(box.locator('.reply-en')).toHaveValue('Here are the options.');
  await expect(box.getByRole(sms ? 'link' : 'button', { name: sms ? 'Enviar por SMS' : 'Enviar pelo painel', exact: true })).toBeVisible();
  await expect(screen.locator('.oc-act').getByRole('button', { name: 'Gerar V1 e abrir no WhatsApp', exact: true })).toBeEnabled();
  await screen.getByRole('button', { name: '← Voltar' }).click();
  await client.click();
  await expect(box.locator('textarea').first()).toHaveValue('Aqui estão as opções.');
  await expect(box.locator('.reply-en')).toHaveValue('Here are the options.');
  await expect(screen.locator('.oc-count')).toHaveText('1 de 10 selecionados');
  expect(calls.posts).toHaveLength(1);
  expect(calls.replies.filter((b) => b.action === 'send')).toHaveLength(0);
});

// A link (or a text already in English) goes exactly as typed: no translation call, the same send and confirmation.
for (const sms of [false, true]) test(`Responder pelo painel: "Enviar sem traduzir" (${sms ? 'SMS' : 'WhatsApp'}) manda o texto como foi escrito`, async ({ page }) => {
  const calls = { pages: [], posts: [], sms };
  await openPanel(page, { calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).locator('.options-queue-name').click();
  const box = page.locator('#options-client .reply-composer');
  const link = 'https://www.mycarscout.net/o/' + 'c'.repeat(43);
  await box.locator('textarea').first().fill(link);
  // The usual path is still there, as it was.
  await expect(box.getByRole('button', { name: 'Traduzir', exact: true })).toBeEnabled();
  await box.getByRole('button', { name: 'Enviar sem traduzir', exact: true }).click();
  await expect(box.locator('.reply-en')).toHaveValue(link);
  await expect(box).toContainText('Vai para o cliente (como você escreveu)');
  await expect(box.getByText('Conferência (volta para o português)')).toBeHidden();
  expect(calls.replies.filter((b) => b.action === 'translate')).toHaveLength(0);
  if (sms) {
    await expect(box.getByRole('link', { name: 'Enviar por SMS', exact: true })).toHaveAttribute('href', new RegExp(encodeURIComponent(link).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return;
  }
  await box.getByRole('button', { name: 'Enviar pelo painel', exact: true }).click();
  await box.getByRole('button', { name: 'Confirmar envio', exact: true }).click();
  await expect.poll(() => calls.replies.filter((b) => b.action === 'send').length).toBe(1);
  expect(calls.replies.find((b) => b.action === 'send').textEn).toBe(link);
});

// SMS goes out from the phone: the tap is recorded in the conversation as sent by MCS, with Desfazer.
test('Enviar por SMS: registra na conversa como SMS enviado, com Desfazer', async ({ page }) => {
  const calls = { pages: [], posts: [], sms: true };
  await openPanel(page, { calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).locator('.options-queue-name').click();
  const box = page.locator('#options-client .reply-composer');
  await box.locator('textarea').first().fill('Here are your options');
  await box.getByRole('button', { name: 'Enviar sem traduzir', exact: true }).click();
  await box.getByRole('link', { name: 'Enviar por SMS', exact: true }).click();
  await expect(box.locator('.sms-recorded')).toContainText('Registrado na conversa como SMS enviado');
  const recorded = calls.replies.filter((b) => b.action === 'sms_sent');
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ journeyId: JJ.id, text: 'Here are your options' });
  await page.locator('.wa-handoff-dialog').getByRole('button', { name: 'Fechar' }).click();
  await box.getByRole('button', { name: 'Desfazer (não enviei)' }).click();
  await expect(box.locator('.sms-recorded')).toHaveText('Registro desfeito');
  expect(calls.replies.filter((b) => b.action === 'sms_undo')[0]).toMatchObject({ journeyId: JJ.id, messageId: id(900) });
});

// The link of all options: once it exists, the screen says whether the client opened it (like the V1 tabs).
test('Link de opções: mostra se o cliente abriu; sem link, nada muda', async ({ page }) => {
  const calls = { pages: [], posts: [] };
  await openPanel(page, { calls });
  const client = page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).locator('.options-queue-name');
  await client.click();
  const ask = page.locator('#options-client .oc-ask');
  await expect(ask.locator('.oc-fact')).toHaveCount(4);
  await page.locator('#options-client').getByRole('button', { name: '← Voltar' }).click();
  calls.opens = { exists: true, opens: 2, lastOpenAt: '2026-10-11T01:30:00Z' };
  await client.click();
  await expect(ask.locator('.oc-fact')).toHaveCount(5);
  await expect(ask.locator('.oc-fact').last()).toContainText('Link de opções');
  await expect(ask.locator('.oc-fact').last()).toContainText('aberto 2× · último 10/10/2026');
});

test('Opções do cliente: abre ao tocar no cartão, uma lista só, seleção e as três ações', async ({ page }) => {
  const errors = [], calls = { pages: [], posts: [] };
  page.on('pageerror', (failure) => errors.push(failure.message));
  await openPanel(page, { calls });
  const card = page.locator('#options-queue .options-queue-card', { hasText: 'JJ' });
  // The line's Opções column is the total of the screen's tabs (114 + 13); the summary stays as its tooltip.
  await expect(card.locator('.options-queue-reason')).toHaveText('127');
  await expect(card.locator('.options-queue-reason')).toHaveAttribute('title', '1 pedido · 127 carros aguardando');
  await card.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  // Common path: one tap opens the client's screen, never the ficha.
  await card.locator('.options-queue-name').click();
  const screen = page.locator('#options-client');
  await expect(screen).toBeVisible();
  await expect(page.locator('#options-queue')).toBeHidden();
  await expect(page.locator('#detail-panel')).toBeHidden();
  await expect(screen.locator('.oc-name')).toContainText('JJ');
  await expect(screen.locator('.oc-ref')).toHaveText('REF AMQV5');
  await expect(screen.locator('.oc-phone')).toHaveAttribute('href', 'tel:+18705941027');
  await expect(screen.locator('.oc-place')).toHaveText('72012 · Beebe · AR');
  await expect(screen.locator('.oc-ask')).toContainText('Jeep Grand Cherokee L · 2020 a 2023');
  await expect(screen.locator('.oc-ask')).toContainText('Find One For Me · por carro');
  await expect(screen.locator('.oc-ask')).toContainText('Lance máximo');
  await expect(screen.locator('.oc-ask')).toContainText('V1: nenhuma · V2: nenhuma');
  await expect(screen.locator('.oc-bar .oc-tab')).toHaveText(['Lane/Run (114)', 'Buy Now / Make Offer (13)', 'Informação incompleta (0)']);
  // The 6 orders; default: fewer miles first.
  await expect(screen.locator('.oc-sort option')).toHaveText(['Ano maior primeiro', 'Ano menor primeiro', 'Milhas menor primeiro', 'Milhas maior primeiro', 'MMR maior primeiro', 'MMR menor primeiro', 'Padrão (CR)']);
  await expect(screen.locator('.oc-sort')).toHaveValue('miles_asc');
  const rows = screen.locator('.oc-list .oc-row');
  await expect(rows).toHaveCount(25);
  expect(calls.pages[0]).toMatchObject({ key: `journey:${JJ.id}:CARRO`, group: 'LANE', sort: 'miles_asc', limit: '25' });
  await expect(rows.first()).toContainText('2023 Jeep Grand Cherokee L Limited');
  await expect(rows.first()).toContainText('20.000 milhas');
  await expect(rows.first()).toContainText('TN - Manheim Nashville');
  await expect(rows.first()).toContainText('(Flórida)');
  await expect(rows.first()).toContainText('Atende ao pedido');
  await expect(screen.locator('.oc-more')).toContainText('+ 89 carros');
  await screen.getByRole('button', { name: 'Ver mais' }).click();
  await expect(rows).toHaveCount(50);
  // Selecting is one click on the box (the ficha's server action); the counter and the actions follow.
  const act = screen.locator('.oc-act');
  await expect(act.locator('.oc-count')).toHaveText('0 de 10 selecionados');
  await expect(act.getByRole('button', { name: 'Baixar PDF' })).toBeDisabled();
  await expect(act.getByRole('button', { name: 'Gerar V1 e abrir no WhatsApp' })).toBeDisabled();
  await rows.first().locator('input[type="checkbox"]').check();
  await expect(act.locator('.oc-count')).toHaveText('1 de 10 selecionados');
  expect(calls.posts[0]).toMatchObject({ action: 'select', matchId: id(1000) });
  await expect(rows.first()).toHaveClass(/sel/);
  await expect(act.getByRole('button', { name: 'Baixar PDF' })).toBeEnabled();
  await expect(act.getByRole('button', { name: 'Gerar V1 e abrir no WhatsApp' })).toBeEnabled();
  // JJ never tapped a V1 car: Montar V2 stays off, with the reason.
  await expect(act.getByRole('button', { name: 'Montar V2' })).toBeDisabled();
  await expect(act).toContainText('O Montar V2 fica liberado quando o cliente tocar em um carro da V1.');
  // Tapping the line opens the car with everything the ficha had: price (% and US$), note, "Por que este carro", Manter fora.
  await rows.first().locator('.oc-car').click();
  const opened = screen.locator('.oc-list .oc-item').first().locator('.oc-detail');
  await expect(opened).toBeVisible();
  for (const text of ['Ajustado (%)', 'Valor para o cliente (US$)', 'Por que este carro (o cliente vê na V1)']) await expect(opened).toContainText(text);
  await expect(opened.getByRole('button', { name: 'Manter fora' })).toBeVisible();
  await expect(opened.locator('.offer-note')).toBeVisible();
  await expect(rows.first().locator('.oc-client-price')).toContainText('Cliente');
  await rows.first().locator('.oc-car').click();
  await expect(opened).toBeHidden();
  // A new order starts the list again from the server.
  await screen.locator('.oc-sort').selectOption('year_desc');
  await expect.poll(() => calls.pages.at(-1).sort).toBe('year_desc');
  // Buy Now: says until when it is open, never a past "leilão"; off Lane/Run a car goes in with the reason.
  await screen.locator('.oc-bar .oc-tab', { hasText: 'Buy Now' }).click();
  await expect.poll(() => calls.pages.at(-1).group).toBe('OFFLANE');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Buy Now até');
  await expect(rows.first()).toContainText('PA - Manheim Pennsylvania');
  // The box opens the car with the reason field (manual inclusion) and stays unchecked until the car goes in.
  const items = screen.locator('.oc-list .oc-item');
  await rows.first().locator('input[type="checkbox"]').click();
  await expect(rows.first().locator('input[type="checkbox"]')).not.toBeChecked();
  await expect(items.first().locator('.oc-detail')).toBeVisible();
  await items.first().locator('.oc-detail .offer-reason').fill('Único com menos de 25 mil milhas');
  await items.first().getByRole('button', { name: 'Incluir manualmente' }).click();
  await expect(rows.first().locator('input[type="checkbox"]')).toBeChecked();
  expect(calls.posts.at(-1)).toMatchObject({ action: 'select', matchId: id(2001), reason: 'Único com menos de 25 mil milhas' });
  // The selected cars open from the counter, with Remover todos.
  await act.locator('.oc-count').click();
  await expect(act.locator('.offer-picked')).toBeVisible();
  // Voltar: the queue, at the same point.
  await screen.getByRole('button', { name: '← Voltar' }).click();
  await expect(page.locator('#options-queue')).toBeVisible();
  await expect(screen).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolled);
  // The full ficha opens from its small link.
  await card.locator('.options-queue-name').click();
  await screen.getByRole('button', { name: 'Abrir ficha completa' }).click();
  await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 30000 });
  expect(errors).toEqual([]);
});

test('Opções do cliente: Montar V2 liberado depois do toque na V1; no celular a linha vira cartão', async ({ page }) => {
  const errors = [], calls = { pages: [], posts: [] };
  page.on('pageerror', (failure) => errors.push(failure.message));
  await openPanel(page, { width: 390, calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'Tina Tocou' }).locator('.options-queue-name').click();
  const screen = page.locator('#options-client');
  await expect(screen.locator('.oc-list .oc-row')).toHaveCount(25);
  await expect(screen.locator('.oc-ask')).toContainText('V1: enviada');
  await expect(screen.locator('.oc-ask')).toContainText('tocou');
  const v2 = screen.getByRole('button', { name: 'Montar V2' });
  await expect(v2).toBeEnabled();
  await v2.click();
  await expect(screen.locator('.v2-picker input')).toBeVisible();
  // Phone width: the header row is gone, each car is a card, nothing scrolls sideways.
  await expect(screen.locator('.oc-head')).toBeHidden();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

test('Copiar link de todas as opções: um toque copia o link do pedido para mandar ao cliente', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const calls = { pages: [], posts: [] };
  await openPanel(page, { calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).click();
  const screen = page.locator('#options-client');
  await expect(screen.locator('.oc-row').first()).toBeVisible({ timeout: 30000 });
  const share = screen.locator('.oc-share');
  await expect(share).toHaveText('Copiar link de todas as opções');
  await share.click();
  await expect(share).toHaveText('Link copiado');
  expect(calls.links).toEqual([{ key: `journey:${JJ.id}:CARRO` }]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(base + '/o/' + 'c'.repeat(43));
  // Nothing else changes on the screen (no new step on the common path).
  await expect(screen.locator('.oc-share-url')).toHaveCount(0);
  await expect(share).toHaveText('Copiar link de todas as opções', { timeout: 5000 });
});

// "Copiar link da V1": the same V1 as "Gerar V1 e abrir no WhatsApp", with the link copied instead of the WhatsApp opening.
test('Copiar link da V1: gera a V1 dos selecionados e copia o link, sem abrir o WhatsApp', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const calls = { pages: [], posts: [] }, created = [], popups = [];
  await openPanel(page, { calls });
  const TOKEN = 'v'.repeat(43);
  await page.route('**/api/panel/vitrines', (route) => { created.push(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token: TOKEN, removed: [] }) }); });
  await page.route('**/api/panel/v1-send', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ link: base + '/v/' + TOKEN, phone: '+18705941027', text: 'Hi JJ' }) }));
  page.on('popup', (popup) => popups.push(popup.url()));
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).click();
  const screen = page.locator('#options-client');
  const rows = screen.locator('.oc-row');
  await expect(rows.first()).toBeVisible({ timeout: 30000 });
  const act = screen.locator('.oc-act');
  const copy = act.getByRole('button', { name: 'Copiar link da V1' });
  await expect(copy).toBeDisabled();
  await rows.first().locator('input[type="checkbox"]').check();
  await expect(copy).toBeEnabled();
  // The SMS path is added; every existing action stays in the same relative order.
  await expect(act.locator('.inline-actions > button')).toHaveText(['Baixar PDF', 'Montar V2', 'Gerar V1 e abrir no WhatsApp', 'Gerar V1 e abrir no SMS', 'Copiar link da V1']);
  await copy.click();
  await expect(act.locator('.ficha-v1-status')).toHaveText('Link da V1 copiado · Cole e envie para o cliente', { timeout: 30000 });
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(base + '/v/' + TOKEN);
  expect(created).toEqual([{ journeyId: JJ.id, matchIds: [id(1000)], demandKey: `journey:${JJ.id}:CARRO` }]);
  expect(popups).toEqual([]);
});

// The same "Copiar link de todas as opções" in the ficha header, next to "Copiar link do cliente" (it stays in Opções do cliente too).
test('ficha: "Copiar link de todas as opções" no cabeçalho copia o link do pedido; com dois pedidos, um botão para cada', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const calls = { pages: [], posts: [] };
  await openPanel(page, { calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).click();
  const screen = page.locator('#options-client');
  await expect(screen.locator('.oc-share')).toHaveText('Copiar link de todas as opções', { timeout: 30000 });
  await screen.getByRole('button', { name: 'Abrir ficha completa' }).click();
  const actions = page.locator('#record-detail .lead-head-actions');
  const button = actions.locator('.lead-options-link');
  await expect(button).toHaveCount(1, { timeout: 30000 });
  await expect(button).toHaveText('Copiar link de todas as opções');
  await button.click();
  await expect(button).toHaveText('Link copiado');
  expect(calls.links).toEqual([{ key: `journey:${JJ.id}:CARRO` }]);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(base + '/o/' + 'c'.repeat(43));
  await expect(button).toHaveText('Copiar link de todas as opções', { timeout: 5000 });
});

test('ficha com pedido POR VALOR e POR CARRO (raro): um botão por pedido, com o nome da busca', async ({ page }) => {
  const extra = { ...demand(JJ, { lane: 3, offLane: 0, incomplete: 0 }), key: `journey:${JJ.id}:VALOR`, mode: 'VALOR' };
  manheim.demands.push(extra);
  try {
    const calls = { pages: [], posts: [] };
    await openPanel(page, { calls });
    await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).first().click();
    await page.locator('#options-client').getByRole('button', { name: 'Abrir ficha completa' }).click();
    const buttons = page.locator('#record-detail .lead-head-actions .lead-options-link');
    await expect(buttons).toHaveText(['Copiar link de todas as opções · por carro', 'Copiar link de todas as opções · por valor'], { timeout: 30000 });
  } finally { manheim.demands.pop(); }
});

// RESULTADO na tela do cliente: a mesma barra da ficha (mesmos botões, mesma chamada). Gravar não recarrega a lista de carros.
test('Opções do cliente: barra RESULTADO da ficha, com "Opções enviadas", sem mexer na lista', async ({ page }) => {
  const errors = [], calls = { pages: [], posts: [] };
  page.on('pageerror', (failure) => errors.push(failure.message));
  await openPanel(page, { calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).locator('.options-queue-name').click();
  const screen = page.locator('#options-client');
  const bar = screen.locator('.oc-result .lead-quick');
  await expect(bar.locator('.lead-quick-label')).toHaveText('Resultado');
  await expect(bar.locator('.lead-quick-actions > button')).toHaveText(['Atendeu', 'Não atendeu', 'Opções enviadas', 'Vai pagar o depósito', 'Pediu para ligar depois', 'Anotações']);
  // Common path of the screen unchanged: who, what was asked and the list, in the same order.
  await expect(screen.locator(':scope > *').first()).toHaveClass(/oc-top/);
  await expect(screen.locator('.oc-list .oc-row')).toHaveCount(25);
  const pagesBefore = calls.pages.length;
  await bar.getByRole('button', { name: 'Opções enviadas' }).click();
  await expect.poll(() => (calls.lead || []).length).toBe(1);
  expect(calls.lead[0]).toMatchObject({ action: 'quick', type: 'IN_PERSON', ref: 'AMQV5', journeyId: JJ.id });
  await expect(page.locator('.undo-toast')).toContainText('Resultado registrado');
  await expect(bar.locator('.lead-quick-actions > button')).toHaveCount(6);
  await expect(screen.locator('.oc-list .oc-row')).toHaveCount(25);
  expect(calls.pages.length).toBe(pagesBefore);
  expect(calls.posts).toHaveLength(0);
  expect(errors).toEqual([]);
});

// RESULTADO: o último botão fica marcado (cinza) e a fila de ENVIAR OPÇÕES mostra o último resultado de cada pessoa, sem
// abrir cliente por cliente. Sem resultado registrado, nada muda: mesma fila, mesmos botões, nenhum marcado.
test('RESULTADO: último marcado em cinza e a fila mostra o que foi feito; sem resultado nada muda', async ({ page }) => {
  const calls = { pages: [], posts: [], results: { journeys: { [TAP.id]: { type: 'ANSWERED', at: ago(1) } }, refs: {} } }, errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openPanel(page, { calls });
  const jj = page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }), tina = page.locator('#options-queue .options-queue-card', { hasText: 'Tina Tocou' });
  await expect(tina.locator('.options-queue-last')).toContainText('✓ Atendeu');
  // Common path: no result yet, the name cell is just the name.
  await expect(jj.locator('.options-queue-last')).toHaveCount(0);
  await expect(jj.locator('.options-queue-name')).toHaveText('JJ');
  await jj.locator('.options-queue-name').click();
  const bar = page.locator('#options-client .lead-quick-actions');
  await expect(bar.locator('button')).toHaveText(['Atendeu', 'Não atendeu', 'Opções enviadas', 'Vai pagar o depósito', 'Pediu para ligar depois', 'Anotações']);
  await expect(bar.locator('button.is-last')).toHaveCount(0);
  await bar.getByRole('button', { name: 'Opções enviadas', exact: true }).click();
  await expect(bar.locator('button.is-last')).toHaveText('Opções enviadas');
  await expect(bar.locator('button.is-last')).toHaveAttribute('aria-pressed', 'true');
  expect(await bar.locator('button.is-last').evaluate((node) => getComputedStyle(node).backgroundColor)).toBe('rgb(227, 227, 230)');
  expect(calls.lead.filter((body) => body.action === 'quick').map((body) => body.type)).toEqual(['IN_PERSON']);
  await page.locator('#options-client').getByRole('button', { name: '← Voltar' }).click();
  await expect(jj.locator('.options-queue-last')).toContainText('✓ Opções enviadas');
  await expect(tina.locator('.options-queue-last')).toContainText('✓ Atendeu');
  expect(errors).toEqual([]);
});

// Opções do cliente traz a mesma Sugestão de resposta e Resposta orientada da ficha; nada é pedido à IA só por abrir.
test('Opções do cliente: Sugestão de resposta e Resposta orientada, sem chamada ao abrir', async ({ page }) => {
  const calls = { pages: [], posts: [] }, suggestions = [];
  page.on('request', (r) => { if (r.url().includes('/api/panel/suggestions')) suggestions.push(r.url()); });
  await openPanel(page, { calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).locator('.options-queue-name').click();
  const reply = page.locator('#options-client .oc-reply');
  await expect(reply.locator('.suggestion-card')).toContainText('SUGESTÃO DE RESPOSTA');
  await expect(reply.locator('.suggestion-card').getByRole('button', { name: 'Sugerir resposta', exact: true })).toBeVisible();
  await expect(reply.locator('.guided-card')).toContainText('RESPOSTA ORIENTADA');
  await expect(reply.locator('.guided-card').getByRole('button', { name: 'Gerar resposta', exact: true })).toBeVisible();
  // The reply composer stays first, as it was.
  await expect(reply.locator('> *').first()).toHaveClass(/reply-composer/);
  expect(suggestions).toEqual([]);
});

// Escrever em português (padrão, igual a antes) ou em espanhol: o cliente recebe inglês; a conferência volta no seu idioma.
test('Responder pelo painel: português é o padrão; espanhol traduz do espanhol e pede nova tradução ao trocar', async ({ page }) => {
  const calls = { pages: [], posts: [] };
  await openPanel(page, { calls });
  await page.locator('#options-queue .options-queue-card', { hasText: 'JJ' }).locator('.options-queue-name').click();
  const box = page.locator('#options-client .reply-composer');
  const from = box.locator('select.reply-from');
  await expect(from).toHaveValue('pt');
  await expect(box).toContainText('Sua mensagem (português)');
  await box.locator('textarea').first().fill('Aqui estão as opções');
  await box.getByRole('button', { name: 'Traduzir', exact: true }).click();
  await expect(box.locator('.reply-en')).toHaveValue('Here are the options.');
  // Common path: the request is exactly as before (no language field).
  expect(calls.replies.filter((b) => b.action === 'translate')).toEqual([{ action: 'translate', text: 'Aqui estão as opções' }]);
  await from.selectOption('es');
  await expect(box).toContainText('Sua mensagem (espanhol)');
  await expect(box.locator('.reply-status')).toContainText('Idioma mudou');
  await box.locator('textarea').first().fill('Aquí están las opciones');
  await box.getByRole('button', { name: 'Traduzir', exact: true }).click();
  await expect.poll(() => calls.replies.filter((b) => b.action === 'translate').length).toBe(2);
  expect(calls.replies.filter((b) => b.action === 'translate')[1]).toEqual({ action: 'translate', text: 'Aquí están las opciones', from: 'es' });
  await expect(box).toContainText('Conferência (volta para o espanhol)');
  // The choice is remembered on this browser; back to Portuguese clears it.
  expect(await page.evaluate(() => localStorage.getItem('mcs_reply_from'))).toBe('es');
  await from.selectOption('pt');
  expect(await page.evaluate(() => localStorage.getItem('mcs_reply_from'))).toBe(null);
});

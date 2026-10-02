'use strict';

// Adendo: grupos de contato (origem, não atendido, fora do assunto), busca em três grupos e motivo
// de "sem carros". Testes puros: nenhuma chamada externa, nenhum envio, nenhuma gravação.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const groups = require('../panel-groups');
const { topicIndex } = require('../panel-topic');
const { wishReason, reasonFor } = require('../search-empty-reason');
const triage = require('../panel-triage');

const NOW = Date.parse('2026-10-01T15:00:00Z');
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600000).toISOString();
const msg = (id, direction, hoursAgo, text = 'oi', extra = {}) => ({ id, direction, body_text: text, occurred_at_utc: iso(hoursAgo), ...extra });
const car = (make, model, year, miles, mmr = 1500000) => ({ make, model, year, miles, mmr_cents: mmr, mmr: mmr / 100, mmrCents: mmr });

const sim = (hoursAgo, extra = {}) => ({ simulations: [{ logicalMode: 'VALOR', occurredAt: iso(hoursAgo), ...extra }] });

test('origem: calculadora, mensagem ou vitrine, cada uma com o canal; "Direto" sozinho nunca aparece', () => {
  const calc = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3), msg('b', 'MCS', 2)], orders: [sim(10)], journey: { source: 'CALCULATOR' } }));
  assert.deepEqual([calc.group, calc.sub, calc.label], ['CALCULADORA', 'WHATSAPP', 'Veio pela calculadora · Via WhatsApp']);
  const calcSms = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3, 'oi', { channel: 'SMS' })], orders: [sim(10)], journey: { source: 'CALCULATOR' } }));
  assert.equal(calcSms.label, 'Veio pela calculadora · Via SMS');
  const message = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3, 'hello')], journey: { source: 'WHATSAPP_DIRECT' } }));
  assert.equal(message.label, 'Veio por mensagem · Via WhatsApp');
  const sms = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3, 'hello', { source_kind: 'SMS_SHORTCUT' })] }));
  assert.equal(sms.label, 'Veio por mensagem · Via SMS');
  const v2 = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3, 'hello')], vitrine: { version: 'V2', at: iso(4) } }));
  assert.equal(v2.label, 'Veio pela vitrine · V2');
  const all = [calc, calcSms, message, sms, v2].map((origin) => origin.label).concat(groups.ORIGIN_OPTIONS.map((option) => option[1]));
  all.forEach((label) => assert.doesNotMatch(label, /^Direto$|· Direto$/));
});

test('origem a) financiamento só pela primeira mensagem ser um dos dois textos do site; etiqueta dentro de "Veio por mensagem"', () => {
  const fin = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 9, 'Hi! I want to finance a car. I can put $5,000 down and pay around $600/month'), msg('b', 'CUSTOMER', 1, 'still there?')] }));
  assert.equal(fin.group, 'MENSAGEM');
  assert.equal(fin.financing, true);
  assert.equal(groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 9, "Hi! I'd like to talk about financing a car with you")] })).financing, true);
  // Financing mentioned later is not the origin: the first message decides.
  assert.equal(groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 9, 'Hello, looking for a Camry'), msg('b', 'CUSTOMER', 1, 'I want to finance a car')] })).financing, false);
  // The filter: everyone by default, the group, the channel and the financing tag.
  const item = { group: { origin: fin } };
  assert.equal(groups.matchesOrigin(item, 'all'), true);
  assert.equal(groups.matchesOrigin(item, 'MENSAGEM'), true);
  assert.equal(groups.matchesOrigin(item, 'MENSAGEM:WHATSAPP'), true);
  assert.equal(groups.matchesOrigin(item, 'MENSAGEM:FINANCIAMENTO'), true);
  assert.equal(groups.matchesOrigin(item, 'CALCULADORA'), false);
  assert.ok(groups.ORIGIN_OPTIONS.some(([value]) => value === 'MENSAGEM:FINANCIAMENTO'));
});

test('origem b) com pedido da calculadora e conversa direta, a calculadora fica (WhatsApp/SMS é canal)', () => {
  const directLater = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 2, 'hello')], orders: [sim(30)], journey: { source: 'WHATSAPP_DIRECT' } }));
  assert.equal(directLater.group, 'CALCULADORA');
  const calcLater = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 30, 'hello')], orders: [sim(2)], journey: { source: 'WHATSAPP_DIRECT' } }));
  assert.equal(calcLater.group, 'CALCULADORA');
  // A calculator ficha whose customer wrote after the order is still calculator (not "both").
  const calcFicha = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 2, 'hello')], orders: [sim(30)], journey: { source: 'CALCULATOR' } }));
  assert.equal(calcFicha.group, 'CALCULADORA');
  const vitrineLater = groups.originOf(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 2, 'hello')], orders: [sim(30)], journey: { source: 'CALCULATOR' }, vitrine: { version: 'V1', at: iso(3) } }));
  assert.equal(vitrineLater.label, 'Veio pela vitrine · V1');
});

test('não atendido: mensagem do cliente sem resposta, com motivo, tempo de espera, o que falta e o próximo passo', () => {
  const facts = groups.factsFor({ messages: [msg('a', 'MCS', 50), msg('b', 'CUSTOMER', 26)], journey: { source: 'WHATSAPP_DIRECT', created_at: iso(60) } });
  const group = groups.classify(facts, NOW);
  assert.equal(group.key, 'NAO_ATENDIDO');
  assert.equal(group.origin.group, 'MENSAGEM');
  assert.equal(group.unattended.reasonText, 'Mensagem do cliente sem resposta');
  assert.equal(group.unattended.waitedText, '26 h');
  assert.match(group.unattended.missing, /Resposta/);
  assert.equal(group.unattended.next, 'Responder o cliente');
  // Automatic messages never count as a reply.
  const auto = groups.factsFor({ messages: [msg('b', 'CUSTOMER', 3), msg('c', 'MCS', 1, 'auto', { is_automatic: true })] });
  assert.equal(groups.classify(auto, NOW).key, 'NAO_ATENDIDO');
});

test('não atendido: nenhuma ação há 7 dias ou mais; c) próxima ação futura, caso encerrado ou tratado não entram', () => {
  const stale = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: { created_at: iso(24 * 10) } });
  const group = groups.classify(stale, NOW);
  assert.equal(group.key, 'NAO_ATENDIDO');
  assert.equal(group.unattended.reason, 'NO_ACTION');
  assert.equal(group.unattended.waitedText, '8 dias');
  const recent = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 6 + 20), msg('b', 'MCS', 24 * 5)] });
  assert.equal(groups.classify(recent, NOW).key, 'ATENDIDO');
  const future = { next_action_at: new Date(NOW + 86400000).toISOString() };
  assert.equal(groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: future }), NOW).key, 'ATENDIDO');
  // c) a customer message that arrived BEFORE the next action was scheduled: attended.
  const scheduledAfter = { ...future, next_action_set_at: iso(4) };
  assert.equal(groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 5)], journey: scheduledAfter }), NOW).key, 'ATENDIDO');
  // A new message AFTER the scheduling, still without a reply: não atendido even before the date.
  const scheduledBefore = { ...future, next_action_set_at: iso(6) };
  const newer = groups.classify(groups.factsFor({ messages: [msg('a', 'MCS', 7), msg('b', 'CUSTOMER', 5)], journey: scheduledBefore }), NOW);
  assert.equal(newer.key, 'NAO_ATENDIDO');
  assert.equal(newer.unattended.reason, 'NO_RESPONSE');
  // Once we reply, it is attended again (the next action is still in the future).
  assert.equal(groups.classify(groups.factsFor({ messages: [msg('b', 'CUSTOMER', 5), msg('c', 'MCS', 1)], journey: scheduledBefore }), NOW).key, 'ATENDIDO');
  const overdue = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: { next_action_at: iso(24), next_action_text: 'Ligar' } });
  assert.match(groups.classify(overdue, NOW).unattended.missing, /venceu: Ligar/);
  const closed = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: { status: 'ENCERRADO' } });
  assert.equal(groups.classify(closed, NOW).key, 'ATENDIDO');
  const treated = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9)], disposition: 'TREATED', dispositionAt: iso(24 * 8) });
  assert.equal(groups.classify(treated, NOW).key, 'ATENDIDO');
});

test('caso concluído nunca fica em Não atendidos (cenário "TESTE FICTICIO PR20 20260925")', () => {
  // The audit case: last customer message on 25/09, ficha closed on 29/09.
  const now = Date.parse('2026-10-02T12:00:00Z');
  const pr20 = groups.factsFor({ messages: [{ id: 'b', direction: 'CUSTOMER', body_text: 'TESTE FICTICIO PR20 20260925', occurred_at_utc: '2026-09-25T14:00:00Z' }],
    journey: { status: 'ENCERRADO', closed_at: '2026-09-29T10:00:00Z', created_at: '2026-09-25T13:00:00Z' } });
  assert.equal(groups.classify(pr20, now).key, 'ATENDIDO');
  // Concluded by the reading (situation CLOSED) too.
  assert.equal(groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 30)], situation: 'CLOSED' }), NOW).key, 'ATENDIDO');
  // The customer wrote again after closing: it is a new message waiting for a reply.
  const reopened = groups.factsFor({ messages: [{ id: 'c', direction: 'CUSTOMER', body_text: 'oi de novo', occurred_at_utc: '2026-09-30T10:00:00Z' }], journey: { status: 'ENCERRADO', closed_at: '2026-09-29T10:00:00Z' } });
  assert.equal(groups.classify(reopened, now).key, 'NAO_ATENDIDO');
});

test('precedência: fora do assunto > não atendido > atendido; cada contato em exatamente um grupo, com rótulo', () => {
  const off = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 1, 'happy birthday')], offTopic: { offTopic: true, source: 'AI' } });
  const group = groups.classify(off, NOW);
  assert.equal(group.key, 'FORA_DO_ASSUNTO');
  assert.equal(group.unattended, null);
  assert.equal(group.label, 'Fora do assunto');
  assert.match(groups.SECTIONS.FORA_DO_ASSUNTO.hint, /Na dúvida a conversa fica no fluxo principal/);
  assert.match(groups.SECTIONS.FORA_DO_ASSUNTO.hint, /'É sobre carro' corrige e fica guardado/);
  const items = [
    { id: 1, group: groups.classify(off, NOW) },
    { id: 2, group: groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 1)] }), NOW) },
    { id: 3, group: groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3), msg('b', 'MCS', 1)], orders: [sim(5)] }), NOW) },
    { id: 4, group: groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3), msg('b', 'MCS', 1)] }), NOW) }
  ];
  const split = groups.split(items);
  const placed = split.flatMap((section) => section.items.map((item) => item.id));
  assert.deepEqual(placed.slice().sort(), [1, 2, 3, 4]);
  assert.equal(new Set(placed).size, placed.length);
  assert.deepEqual(split.map((section) => [section.key, section.items.length]), [['NAO_ATENDIDO', 1], ['ATENDIDO', 2], ['FORA_DO_ASSUNTO', 1]]);
  // Counts agree: the sections add up to the total.
  assert.equal(split.reduce((sum, section) => sum + section.items.length, 0), items.length);
});

test('última mensagem do cliente para o cartão sem pedido da calculadora, a partir do resumo', () => {
  const summary = groups.summaryFromMessages([msg('a', 'CUSTOMER', 5, 'first'), msg('b', 'CUSTOMER', 2, 'latest'), msg('c', 'MCS', 1, 'reply')]);
  const latest = groups.latestCustomerMessage(summary);
  assert.equal(latest.id, 'b');
  assert.equal(latest.text, 'latest');
  assert.equal(summary.first_customer_text, 'first');
  assert.equal(summary.latest_direction, 'MCS');
  assert.equal(groups.latestCustomerMessage(groups.summaryFromMessages([msg('c', 'MCS', 1)])), null);
});

test('fora do assunto: a correção vence a IA, persiste por conversa e nada some', () => {
  const readings = [{ chat_id: 'c1', journey_id: 'j1', about_car: false, reason: 'Conversa pessoal', created_at: iso(10) }, { chat_id: 'c2', journey_id: 'j2', about_car: false, created_at: iso(10) }, { chat_id: 'c3', journey_id: 'j3', about_car: true, created_at: iso(10) }];
  const overrides = [{ id: 'o1', chat_id: 'c2', journey_id: 'j2', about_car: true, created_at: iso(1) }, { id: 'o3', chat_id: 'c3', journey_id: 'j3', about_car: false, created_at: iso(1) }];
  const index = topicIndex(readings, overrides);
  assert.deepEqual(index.chat('c1'), { offTopic: true, source: 'AI', reason: 'Conversa pessoal', overrideId: null, journeyId: 'j1' });
  assert.equal(index.chat('c2').offTopic, false);
  assert.equal(index.chat('c2').source, 'MANUAL');
  assert.equal(index.chat('c3').offTopic, true);
  assert.equal(index.journey('j1').offTopic, true);
  assert.equal(index.journey('j2'), null);
  // A calculator order is always about a car; a ficha with an unread conversation stays in the main flow.
  assert.equal(index.journey('j1', { hasCalculator: true }), null);
  assert.equal(index.journey('j1', { chatIds: ['c9'] }), null);
  assert.equal(index.journey('sem-leitura'), null);
  assert.deepEqual(index.offTopicChats().map((entry) => entry.chatId).sort(), ['c1', 'c3']);
});

test('triagem v2: só um "não é sobre carro" com certeza tira do fluxo; na dúvida fica', () => {
  assert.equal(triage.RULE_VERSION, 'triagem-v2');
  assert.equal(triage.aboutCarOf({ sobre_carro: false, sobre_carro_certeza: 'alta' }), false);
  assert.equal(triage.aboutCarOf({ sobre_carro: false, sobre_carro_certeza: 'baixa' }), true);
  assert.equal(triage.aboutCarOf({ sobre_carro: true, sobre_carro_certeza: 'alta' }), true);
  assert.equal(triage.aboutCarOf({}), null);
  assert.equal(triage.aboutCarOf(null), null);
  const answer = triage.validated({ category: 'PESSOAL', confidence: 'alta', reason: 'Conversa pessoal', evidence_ids: ['a'], sobre_carro: false, sobre_carro_certeza: 'alta' }, [{ id: 'a' }]);
  assert.equal(answer.category, 'PESSOAL');
  assert.equal(answer.aboutCar, false);
  // The whole conversation: the beginning of a long one is never dropped.
  const long = Array.from({ length: 150 }, (_, index) => msg('m' + index, index % 2 ? 'MCS' : 'CUSTOMER', 300 - index, index === 0 ? 'quero um Camry' : 'ok'));
  const evidence = triage.evidenceFor(long);
  assert.equal(evidence.length, 80);
  assert.equal(evidence[0].id, 'm0');
  assert.equal(evidence.at(-1).id, 'm149');
});

test('sem carros: motivo em linguagem simples, do passo mais largo ao mais estreito', () => {
  const cars = [car('Toyota', 'Corolla', 2019, 40000), car('Toyota', 'Camry', 2015, 90000), car('Toyota', 'Camry', 2016, 120000)];
  assert.equal(wishReason({ make: 'Honda', model: 'Civic' }, cars).code, 'NO_MAKE');
  assert.match(wishReason({ make: 'Honda', model: 'Civic' }, cars).text, /não tem nenhum Honda/);
  assert.match(wishReason({ make: 'Toyota', model: 'RAV4' }, cars).text, /mas nenhum RAV4/);
  const years = wishReason({ make: 'Toyota', model: 'Camry', yearMin: 2020, yearMax: 2022 }, cars);
  assert.equal(years.code, 'YEARS');
  assert.match(years.text, /nenhum de 2020 a 2022 \(no lote: 2015 a 2016\)/);
  const miles = wishReason({ make: 'Toyota', model: 'Camry', yearMin: 2015, yearMax: 2016, maxMiles: 60000 }, cars);
  assert.equal(miles.code, 'MILES');
  assert.match(miles.text, /até 60,000 milhas/);
  const value = reasonFor({ key: 'k', targets: [{ mode: 'VALOR', bidCents: 500000, wishes: [{ make: 'Toyota', model: 'Camry' }] }] }, new Map([['toyota', cars]]));
  assert.equal(value.code, 'VALUE');
  assert.match(value.text, /fora da faixa do lance de US\$ 5,000/);
  // The closest wish wins.
  const best = reasonFor({ key: 'k', targets: [{ mode: 'CARRO', wishes: [{ make: 'Honda', model: 'Civic' }, { make: 'Toyota', model: 'Camry', yearMin: 2020, yearMax: 2021 }] }] }, new Map([['toyota', cars], ['honda', []]]));
  assert.equal(best.code, 'YEARS');
  // A car without a valid MMR never counts as present.
  assert.equal(wishReason({ make: 'Toyota', model: 'Camry' }, [car('Toyota', 'Camry', 2019, 1000, null)]).code, 'NO_MAKE');
});

test('áreas: calculadora por valor e por carro separadas; conversa direta incompleta à parte da definida', () => {
  const calc = (mode, hours) => ({ simulations: [{ logicalMode: mode, occurredAt: iso(hours) }] });
  const item = (facts, extra = {}) => ({ group: groups.classify(groups.factsFor(facts), NOW), ...extra });
  const valor = item({ messages: [msg('a', 'CUSTOMER', 3)], orders: [calc('VALOR', 5)] });
  const carro = item({ messages: [msg('a', 'CUSTOMER', 3)], orders: [calc('CARRO', 5)] });
  // The most recent simulation decides (one person, one place).
  const both = item({ messages: [msg('a', 'CUSTOMER', 3)], orders: [{ simulations: [{ logicalMode: 'VALOR', occurredAt: iso(9) }, { logicalMode: 'CARRO', occurredAt: iso(4) }] }] });
  const incompleta = item({ messages: [msg('a', 'CUSTOMER', 3)] });
  const definida = item({ messages: [msg('a', 'CUSTOMER', 3)] }, { searchModes: ['VALOR'] });
  assert.deepEqual([valor, carro, both, incompleta, definida].map(groups.areaOf), ['CALC_VALOR', 'CALC_CARRO', 'CALC_CARRO', 'DIRETA_INCOMPLETA', 'DIRETA_DEFINIDA']);
  const areas = groups.areas([definida, incompleta, carro, valor]);
  assert.deepEqual(areas.map((area) => [area.key, area.items.length]), [['CALC_VALOR', 1], ['CALC_CARRO', 1], ['DIRETA_INCOMPLETA', 1], ['DIRETA_DEFINIDA', 1]]);
  areas.forEach((area) => assert.ok(area.label && area.hint));
  // CLIENTES: same order and the counts of each area per section, from the server.
  const { clientsPage } = require('../api/panel/records');
  const listed = [definida, incompleta, carro, valor].map((entry, index) => ({ id: 'c' + index, isLead: true, lastActivityAt: iso(1), ...entry }));
  const page = clientsPage(listed, { period: 'all' }, NOW);
  assert.deepEqual(page.items.map(groups.areaOf), ['CALC_VALOR', 'CALC_CARRO', 'DIRETA_INCOMPLETA', 'DIRETA_DEFINIDA']);
  assert.deepEqual(page.counts.areas.NAO_ATENDIDO, { CALC_VALOR: 1, CALC_CARRO: 1, DIRETA_INCOMPLETA: 1, DIRETA_DEFINIDA: 1 });
});

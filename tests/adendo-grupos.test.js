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

test('origem: pedido da calculadora vence; o modo da simulação mais recente decide VALOR ou CARRO', () => {
  const facts = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3), msg('b', 'MCS', 2)], orders: [{ simulations: [{ logicalMode: 'VALOR', occurredAt: iso(10) }, { logicalMode: 'CARRO', occurredAt: iso(5) }] }], journey: { source: 'CALCULATOR' } });
  assert.equal(groups.originOf(facts), 'CALC_CARRO');
  const valor = groups.factsFor({ orders: [{ simulations: [{ logicalMode: 'VALOR', occurredAt: iso(5) }] }] });
  assert.equal(groups.originOf(valor), 'CALC_VALOR');
});

test('origem: sem pedido, vale a primeira mensagem (financiamento pela mensagem pronta do site, senão direto)', () => {
  const fin = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 9, "Hi! I want to finance a car. I can put $5,000 down and pay around $600/month"), msg('b', 'CUSTOMER', 1, 'still there?')] });
  assert.equal(groups.originOf(fin), 'FINANCIAMENTO');
  const finDefault = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 9, "Hi! I'd like to talk about financing a car with you")] });
  assert.equal(groups.originOf(finDefault), 'FINANCIAMENTO');
  // Financing mentioned later is not the origin: the first message decides.
  const direct = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 9, 'Hello, looking for a Camry'), msg('b', 'CUSTOMER', 1, 'I want to finance a car')], journey: { source: 'WHATSAPP_DIRECT' } });
  assert.equal(groups.originOf(direct), 'DIRETO');
});

test('origem: contato com as duas origens fica com a mais recente', () => {
  const directLater = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 2, 'hello')], orders: [{ simulations: [{ logicalMode: 'VALOR', occurredAt: iso(30) }] }], journey: { source: 'WHATSAPP_DIRECT' } });
  assert.equal(groups.originOf(directLater), 'DIRETO');
  const calcLater = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 30, 'hello')], orders: [{ simulations: [{ logicalMode: 'VALOR', occurredAt: iso(2) }] }], journey: { source: 'WHATSAPP_DIRECT' } });
  assert.equal(groups.originOf(calcLater), 'CALC_VALOR');
  // A calculator ficha whose customer wrote after the order is still calculator (not "both").
  const calcFicha = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 2, 'hello')], orders: [{ simulations: [{ logicalMode: 'CARRO', occurredAt: iso(30) }] }], journey: { source: 'CALCULATOR' } });
  assert.equal(groups.originOf(calcFicha), 'CALC_CARRO');
});

test('não atendido: mensagem do cliente sem resposta, com o tempo de espera, o que falta e o próximo passo', () => {
  const facts = groups.factsFor({ messages: [msg('a', 'MCS', 50), msg('b', 'CUSTOMER', 26)], journey: { source: 'WHATSAPP_DIRECT', created_at: iso(60) } });
  const group = groups.classify(facts, NOW);
  assert.equal(group.key, 'NAO_ATENDIDO');
  assert.equal(group.origin, 'DIRETO');
  assert.equal(group.unattended.waitedText, '26 h');
  assert.match(group.unattended.missing, /Resposta/);
  assert.equal(group.unattended.next, 'Responder o cliente');
  // Automatic messages never count as a reply.
  const auto = groups.factsFor({ messages: [msg('b', 'CUSTOMER', 3), msg('c', 'MCS', 1, 'auto', { is_automatic: true })] });
  assert.equal(groups.classify(auto, NOW).key, 'NAO_ATENDIDO');
});

test('não atendido: nenhuma ação há 7 dias ou mais; próxima ação futura, caso encerrado ou tratado não entram', () => {
  const stale = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: { created_at: iso(24 * 10) } });
  const group = groups.classify(stale, NOW);
  assert.equal(group.key, 'NAO_ATENDIDO');
  assert.equal(group.unattended.reason, 'NO_ACTION');
  assert.equal(group.unattended.waitedText, '8 dias');
  const recent = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 6 + 20), msg('b', 'MCS', 24 * 5)] });
  assert.notEqual(groups.classify(recent, NOW).key, 'NAO_ATENDIDO');
  const planned = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: { next_action_at: new Date(NOW + 86400000).toISOString() } });
  assert.notEqual(groups.classify(planned, NOW).key, 'NAO_ATENDIDO');
  const overdue = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: { next_action_at: iso(24), next_action_text: 'Ligar' } });
  assert.match(groups.classify(overdue, NOW).unattended.missing, /venceu: Ligar/);
  const closed = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9), msg('b', 'MCS', 24 * 8)], journey: { status: 'ENCERRADO' } });
  assert.notEqual(groups.classify(closed, NOW).key, 'NAO_ATENDIDO');
  const treated = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 24 * 9)], disposition: 'TREATED', dispositionAt: iso(24 * 8) });
  assert.notEqual(groups.classify(treated, NOW).key, 'NAO_ATENDIDO');
});

test('precedência: fora do assunto > não atendido > origem; cada contato em exatamente um grupo, com rótulo', () => {
  const off = groups.factsFor({ messages: [msg('a', 'CUSTOMER', 1, 'happy birthday')], offTopic: { offTopic: true, source: 'AI' } });
  const group = groups.classify(off, NOW);
  assert.equal(group.key, 'FORA_DO_ASSUNTO');
  assert.equal(group.unattended, null);
  assert.equal(group.label, 'Fora do assunto');
  const items = [
    { id: 1, group: groups.classify(off, NOW) },
    { id: 2, group: groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 1)] }), NOW) },
    { id: 3, group: groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3), msg('b', 'MCS', 1)], orders: [{ logicalModes: ['VALOR'], simulations: [{ logicalMode: 'VALOR', occurredAt: iso(5) }] }] }), NOW) },
    { id: 4, group: groups.classify(groups.factsFor({ messages: [msg('a', 'CUSTOMER', 3), msg('b', 'MCS', 1)] }), NOW) }
  ];
  const split = groups.split(items);
  const placed = split.flatMap((section) => section.items.map((item) => item.id));
  assert.deepEqual(placed.slice().sort(), [1, 2, 3, 4]);
  assert.equal(new Set(placed).size, placed.length);
  assert.deepEqual(split.filter((section) => section.items.length).map((section) => section.key), ['NAO_ATENDIDO', 'CALC_VALOR', 'DIRETO', 'FORA_DO_ASSUNTO']);
  split.forEach((section) => assert.ok(section.label && section.label.length > 3));
});

test('última mensagem do cliente para o cartão sem pedido da calculadora', () => {
  const latest = groups.latestCustomerMessage([msg('a', 'CUSTOMER', 5, 'first'), msg('b', 'CUSTOMER', 2, 'latest'), msg('c', 'MCS', 1, 'reply'), msg('d', 'CUSTOMER', 1, '', {})]);
  assert.equal(latest.id, 'b');
  assert.equal(latest.text, 'latest');
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

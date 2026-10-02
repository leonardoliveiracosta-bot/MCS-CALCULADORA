'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../panel-groups');
const attend = require('../painel/atendimento');
const attention = require('../panel-attention');
const { buildIndex, factsOf, UNAVAILABLE, subjectFromRow } = require('../panel-classification');

const NOW = Date.parse('2026-10-02T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW - hours * 3600000).toISOString();
const message = (id, direction, hours, text = 'x') => ({ id, direction, body_text: text, occurred_at_utc: hoursAgo(hours), created_at: hoursAgo(hours), channel: 'WHATSAPP' });
const item = (facts, extra = {}) => ({ group: groups.classify(groups.factsFor({ messages: [message('a', 'CUSTOMER', 3)], ...facts }), NOW), ...extra });
const subject = (key, extra = {}) => ({ key, source: 'CLAUDE', state: 'OK', reason: null, ...extra });

test('origem, assunto e canal são dados separados: quem veio pela calculadora e perguntou de financiamento', () => {
  const sms = { ...message('a', 'CUSTOMER', 3, 'Can I finance it?'), channel: 'SMS' };
  const person = item({ messages: [sms], orders: [{ simulations: [{ logicalMode: 'VALOR', occurredAt: hoursAgo(9) }] }], subject: subject('FINANCIAMENTO') });
  assert.equal(person.group.origin.group, 'CALCULADORA');
  assert.equal(person.group.subject.key, 'FINANCIAMENTO');
  assert.equal(person.group.subject.label, 'Financiamento');
  assert.equal(groups.areaOf(person), 'CALC_VALOR', 'o assunto não tira a pessoa da área da calculadora');
  assert.equal(person.group.origin.sub, 'SMS', 'WhatsApp e SMS são canais, não origem');
});

test('conversas sem Ref são um bloco só, organizado pelo assunto, e a falha de carregamento não vira "não identificado"', () => {
  const make = (key, state = 'OK') => item({ subject: state === 'OK' ? subject(key) : { key: null, state } });
  const list = [make('OUTROS'), make('FINANCIAMENTO'), make('NAO_IDENTIFICADO'), make('PEDIDO_CARRO'), make('SO_CUMPRIMENTO'), make(null, 'INDISPONIVEL'), make('FINANCIAMENTO'), make('NAO_IDENTIFICADO')];
  assert.deepEqual(list.map(groups.areaOf), Array(8).fill('SEM_REF'));
  const blocks = groups.bySubject(list);
  assert.deepEqual(blocks.map((block) => [block.key, block.items.length]), [['FINANCIAMENTO', 2], ['PEDIDO_CARRO', 1], ['SO_CUMPRIMENTO', 1], ['OUTROS', 1], ['NAO_IDENTIFICADO', 2], ['INDISPONIVEL', 1]]);
  assert.equal(groups.bySubject([item({})])[0].key, 'INDISPONIVEL', 'sem informação de assunto nunca vira "Ainda não identificado"');
  assert.deepEqual(groups.bySubject(list).map((block) => block.label), ['Financiamento', 'Pedido de carro', 'Só cumprimentou', 'Outros assuntos', 'Ainda não identificado', 'Assunto indisponível agora']);
  assert.equal(groups.areas(list).filter((area) => area.key === 'SEM_REF').length, 1, 'um bloco só');
});

test('origem Calculadora comprovada sem Ref recuperável vai para "referência ou tipo a recuperar", nunca para conversa direta', () => {
  const recover = item({ identity: { status: 'CALCULADORA_REF_A_RECUPERAR', calcOrigin: true, state: 'OK' } });
  assert.equal(groups.areaOf(recover), 'CALC_SEM_TIPO');
  assert.equal(recover.group.origin.group, 'CALCULADORA');
  assert.equal(recover.group.hasCalculator, true);
  assert.match(groups.AREAS.CALC_SEM_TIPO.label, /referência ou tipo a recuperar/i);
  const direct = item({ identity: { status: 'SEM_ORIGEM_CALCULADORA', calcOrigin: false, state: 'OK' } });
  assert.equal(groups.areaOf(direct), 'SEM_REF');
});

test('índice de classificação: a correção manual vale mais que o Claude; sem leitura é pendente; fonte fora do ar é indisponível', () => {
  const index = buildIndex(
    [{ journey_id: 'j1', status: 'CALCULADORA_REF_A_RECUPERAR', calc_origin: true, refs: [], conflict: null }],
    [{ journey_id: 'j1', subject: 'FINANCIAMENTO', manual_subject: 'OUTROS', classified_at: hoursAgo(1), reason: 'x' }, { journey_id: 'j2', subject: 'PEDIDO_CARRO', manual_subject: null, classified_at: hoursAgo(1), reason: 'quer carro' }, { journey_id: 'j3', subject: 'NAO_IDENTIFICADO', classified_at: null }]);
  assert.deepEqual([factsOf(index, 'j1').subject.key, factsOf(index, 'j1').subject.source], ['OUTROS', 'MANUAL']);
  assert.equal(factsOf(index, 'j2').subject.source, 'CLAUDE');
  assert.equal(factsOf(index, 'j3').subject.state, 'PENDENTE');
  assert.equal(factsOf(index, 'j9').subject.state, 'PENDENTE');
  assert.equal(factsOf(index, 'j1').identity.calcOrigin, true);
  assert.equal(factsOf(UNAVAILABLE, 'j1').subject.state, 'INDISPONIVEL');
  assert.equal(groups.subjectOf(factsOf(UNAVAILABLE, 'j1').subject).label, 'Assunto indisponível agora');
  assert.equal(subjectFromRow({ subject: 'INVENTADO', classified_at: hoursAgo(1) }).state, 'PENDENTE');
});

test('ordem padrão: cliente que aguarda resposta e retorno vencido vêm antes de qualquer classificação', () => {
  const now = NOW;
  const waiting = { id: 'waiting', awaitingReply: true, lastCustomerAt: hoursAgo(5), group: { unattended: { reason: 'NO_RESPONSE', since: hoursAgo(5) } } };
  const waitingLonger = { id: 'longer', awaitingReply: true, lastCustomerAt: hoursAgo(50), group: { unattended: { reason: 'NO_RESPONSE', since: hoursAgo(50) } } };
  const overdue = { id: 'overdue', todayReasons: [{ kind: 'NEXT_ACTION', dueAt: hoursAgo(2) }] };
  const wanted = { id: 'wanted', wantsCar: true, heat: 'HOT', score: 99 };
  const { sortItems } = require('../panel-sort');
  assert.deepEqual(sortItems([wanted, overdue, waiting, waitingLonger], 'ready').map((entry) => entry.id), ['longer', 'waiting', 'overdue', 'wanted']);
  assert.equal(attention.rankOf({ awaitingReply: true, next_action_at: new Date(now + 86400000).toISOString() }, now), 2, 'agendado para depois e já tratado por esse agendamento');
  // another order chosen by the user is not touched by the attention rule
  assert.deepEqual(sortItems([{ id: 'b', sortAt: hoursAgo(1), awaitingReply: true }, { id: 'a', sortAt: hoursAgo(9) }], 'recent').map((entry) => entry.id), ['b', 'a']);
});

test('ATENDIMENTO ordena depois de reunir as fontes e respeita a ordem escolhida', () => {
  const calc = (id, extra) => ({ id, kind: 'JOURNEY', group: { key: 'ATENDIDO' }, ...extra });
  const items = [calc('wanted', { wantsCar: true }), calc('waiting', { awaitingReply: true, lastCustomerAt: hoursAgo(5), group: { key: 'NAO_ATENDIDO', unattended: { reason: 'NO_RESPONSE', reasonText: 'Mensagem do cliente sem resposta', since: hoursAgo(5) } } })];
  const decisions = [{ key: 'v1', kind: 'VINCULO', journeyId: null, label: 'Confirmar vínculo' }];
  const ready = attend.model({ todayItems: items, decisions, now: NOW, sort: 'ready' });
  assert.deepEqual(ready.cases.slice(0, 2).map((entry) => entry.item && entry.item.id || 'decisao'), ['waiting', 'decisao'], 'resposta pendente, depois a decisão que é sua');
  const kept = attend.model({ todayItems: items, decisions, now: NOW, sort: 'recent' });
  assert.deepEqual(kept.cases.map((entry) => entry.item && entry.item.id || 'decisao'), ['wanted', 'waiting', 'decisao'], 'outra ordem escolhida mantém a do servidor');
});

test('mensagem nova depois do agendamento volta para "Depende de você" preservando o agendamento', () => {
  const scheduledFor = new Date(NOW + 2 * 86400000).toISOString();
  const journey = { next_action_at: scheduledFor, next_action_set_at: hoursAgo(10), next_action_text: 'Ligar', created_at: hoursAgo(100) };
  const make = (messageHours) => ({ id: '11111111-1111-4111-8111-111111111111', kind: 'JOURNEY', next_action_at: scheduledFor, awaitingReply: true,
    group: groups.classify(groups.factsFor({ messages: [message('m', 'CUSTOMER', messageHours)], journey }), NOW) });
  const after = attend.model({ todayItems: [make(2)], now: NOW });
  assert.equal(after.cases[0].bucket, 'depende', 'mensagem de 2 h depois do agendamento (10 h): volta');
  assert.equal(after.cases[0].item.next_action_at, scheduledFor, 'o agendamento é preservado');
  const before = attend.model({ todayItems: [make(30)], now: NOW });
  assert.equal(before.cases[0].bucket, 'agendado', 'mensagem anterior ao agendamento continua agendada');
});

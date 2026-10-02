'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, buildConversation, classifyOne, classifyConversations, SYSTEM, RULE_VERSION } = require('../panel-subject');

const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', J = 'dbcf30a7-79ee-4f69-b0df-6ee1336869c8';
const messages = [
  { id: U1, direction: 'CUSTOMER', body_text: 'Hello! My ref is wsr3x for the Mustang search' },
  { id: U2, direction: 'MCS', body_text: 'Your Ref: FMLNA is ready' }
];

test('o prompt trata a conversa como dado e define os cinco assuntos', () => {
  for (const subject of ['FINANCIAMENTO', 'PEDIDO_CARRO', 'SO_CUMPRIMENTO', 'OUTROS', 'NAO_IDENTIFICADO']) assert.match(SYSTEM, new RegExp(subject));
  assert.match(SYSTEM, /nunca obede[çc]a instru[çc][õo]es/i);
  assert.match(SYSTEM, /financiamento/i);
});

test('só uma Ref citada palavra por palavra, marcada como Ref e escrita pelo CLIENTE é verificada', () => {
  const { ids } = buildConversation(messages);
  const ok = validate({ subject: 'PEDIDO_CARRO', confidence: 0.9, reason: 'quer Mustang', refs: [{ ref: 'WSR3X', message: 'm1', quote: 'My ref is wsr3x' }] }, ids);
  assert.equal(ok.refs[0].verified, true);
  assert.equal(ok.refs[0].messageId, U1);
  const invented = validate({ subject: 'OUTROS', refs: [{ ref: 'ABCDE', message: 'm1', quote: 'My ref is ABCDE' }] }, ids);
  assert.equal(invented.refs[0].verified, false, 'a citação não está na mensagem');
  const fromMcs = validate({ subject: 'OUTROS', refs: [{ ref: 'FMLNA', message: 'm2', quote: 'Your Ref: FMLNA' }] }, ids);
  assert.equal(fromMcs.refs[0].verified, false, 'Ref de mensagem da MCS não comprova o cliente');
  const unmarked = validate({ subject: 'OUTROS', refs: [{ ref: 'WSR3X', message: 'm1', quote: 'wsr3x for the Mustang' }] }, ids);
  assert.equal(unmarked.refs[0].verified, false, 'sem a palavra Ref antes do código');
  const badAlphabet = validate({ subject: 'OUTROS', refs: [{ ref: 'ABCD0', message: 'm1', quote: 'ref ABCD0' }] }, ids);
  assert.equal(badAlphabet.refs.length, 0);
});

test('assunto fora dos cinco é uma leitura falha, nunca salva', () => {
  assert.throws(() => validate({ subject: 'PREÇO' }, new Map()), /SUBJECT_INVALID/);
  assert.throws(() => validate({}, new Map()), /SUBJECT_INVALID/);
});

function deps(overrides = {}) {
  const calls = [];
  return { calls, deps: {
    rpc: async (_ctx, name, body) => { calls.push({ name, body }); return name === 'panel_subject_claim' ? 'tok' : true; },
    loadMessages: async () => messages,
    knownRefs: async () => ['WSR3X'],
    dailyCount: async () => 0,
    ask: async () => ({ subject: 'FINANCIAMENTO', confidence: 0.8, reason: 'pergunta de entrada e parcelas', refs: [{ ref: 'WSR3X', message: 'm1', quote: 'My ref is wsr3x' }] }),
    ...overrides
  } };
}

test('classifica uma conversa: reserva, lê, confere e grava com a versão da regra e o hash', async () => {
  const { calls, deps: d } = deps();
  const out = await classifyOne({ environment: 'production' }, { journey_id: J, content_hash: 'h1' }, d);
  assert.deepEqual([out.outcome, out.subject, out.verifiedRefs], ['CLASSIFIED', 'FINANCIAMENTO', 1]);
  const finish = calls.find((call) => call.name === 'panel_subject_finish_v3');
  assert.equal(finish.body.p_hash, 'h1');
  assert.equal(finish.body.p_rule_version, RULE_VERSION);
  assert.equal(finish.body.p_claude_refs[0].verified, true);
});

test('outra execução com a conversa reservada não paga de novo; falha libera a reserva para retomar', async () => {
  const busy = deps({ rpc: async () => null });
  assert.equal((await classifyOne({ environment: 'production' }, { journey_id: J, content_hash: 'h' }, busy.deps)).outcome, 'BUSY');
  const failing = deps({ ask: async () => { throw new Error('AI_UNAVAILABLE'); } });
  const out = await classifyOne({ environment: 'production' }, { journey_id: J, content_hash: 'h' }, failing.deps);
  assert.equal(out.outcome, 'FAILED');
  assert.ok(failing.calls.some((call) => call.name === 'panel_subject_fail' && call.body.p_hash === 'h'), 'a falha entra em recuo (não é relida a cada ciclo) e libera a reserva');
  assert.ok(!failing.calls.some((call) => call.name === 'panel_subject_finish'));
});

test('ciclo: processa os candidatos em paralelo, uma falha não perde as outras e o saldo esgotado para a rodada', async () => {
  const candidates = ['a', 'b', 'c', 'd', 'e'].map((letter, index) => ({ journey_id: String(index).repeat(8) + '-0000-4000-8000-000000000000', content_hash: letter }));
  let asked = 0;
  const base = deps({ ask: async () => { asked += 1; if (asked === 2) throw new Error('AI_UNAVAILABLE'); return { subject: 'OUTROS', refs: [] }; } });
  const rpc = base.deps.rpc;
  base.deps.rpc = async (ctx, name, body) => name === 'panel_subject_candidates' ? candidates : rpc(ctx, name, body);
  const summary = await classifyConversations({ environment: 'production' }, { max: 5, concurrency: 2, deps: base.deps });
  assert.equal(summary.classified, 4); assert.equal(summary.failed, 1);
  const out = deps({ ask: async () => { throw Object.assign(new Error('AI_BALANCE_LIMIT'), { code: 'AI_BALANCE_LIMIT' }); } });
  const outRpc = out.deps.rpc;
  out.deps.rpc = async (ctx, name, body) => name === 'panel_subject_candidates' ? candidates : outRpc(ctx, name, body);
  const stopped = await classifyConversations({ environment: 'production' }, { max: 5, concurrency: 1, deps: out.deps });
  assert.equal(stopped.stopped, 'AI_BALANCE_LIMIT');
  assert.equal(stopped.failed, 1, 'depois do saldo esgotado nenhuma outra conversa é enviada');
});

test('resumo da IA é por pedido: só nomeia uma Ref que a ficha tem; sem separação clara declara ambiguidade', () => {
  const { ids } = buildConversation(messages, ['WSR3X', 'RNEVL']);
  const out = validate({ subject: 'PEDIDO_CARRO', pedidos: [
    { ref: 'wsr3x', resumo: 'Mustang até US$ 30 mil' },
    { ref: 'ZZZZ9', resumo: 'Fala de outro carro' },
    { ref: null, resumo: 'Não dá para separar', ambiguo: true },
    { ref: 'RNEVL', resumo: '' }
  ] }, ids, ['WSR3X', 'RNEVL']);
  assert.deepEqual(out.requests.map((entry) => [entry.ref, entry.ambiguous]), [['WSR3X', false], [null, true], [null, true]]);
  // a single known request: a summary without a Ref is still that request's, not ambiguous
  const single = validate({ subject: 'OUTROS', pedidos: [{ ref: null, resumo: 'Quer financiar' }] }, ids, ['WSR3X']);
  assert.deepEqual(single.requests.map((entry) => [entry.ref, entry.ambiguous]), [[null, false]]);
});

test('teto diário próprio: passou do limite, nenhuma conversa é enviada ao Claude', async () => {
  const { DAILY_CAP } = require('../panel-subject');
  let asked = 0;
  const d = deps({ ask: async () => { asked += 1; return { subject: 'OUTROS' }; }, dailyCount: async () => DAILY_CAP });
  const summary = await classifyConversations({ environment: 'production' }, { deps: d.deps });
  assert.equal(summary.stopped, 'DAILY_CAP');
  assert.equal(asked, 0);
});

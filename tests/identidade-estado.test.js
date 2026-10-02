'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, hashOf, evaluateJourneys, reconcileIdentity, RULE_VERSION } = require('../panel-identity');

const J = 'dbcf30a7-79ee-4f69-b0df-6ee1336869c8', OTHER = '4bc06bb9-b916-4e74-9cda-b92f03e3cc55';
const base = (extra = {}) => ({ journey_id: J, reference_code: 'K7M2P', linked_refs: [], explicit: [], print_refs: [], template: false, message_count: 3, last_message_at: null, run_refs: [], owners: {}, ...extra });

test('caso Ivan: a Ref escrita pela cliente vale mesmo sem simulação e a sugestão por semelhança não a troca', () => {
  const verdict = decide(base({ reference_code: 'WSR3X', linked_refs: ['WSR3X'], explicit: [{ ref: 'WSR3X', mode: 'CARRO', messageId: 'm1' }], run_refs: ['FMLNA'], owners: { WSR3X: [J] } }));
  assert.equal(verdict.status, 'REF_COMPROVADA');
  assert.deepEqual(verdict.refs, ['WSR3X']);
  assert.deepEqual(verdict.linkRefs, [], 'já é da ficha: nada novo a ligar');
  assert.ok(!verdict.refs.includes('FMLNA'));
});

test('Ref escrita ainda não ligada a ficha nenhuma é ligada; a de outra ficha nunca é tomada', () => {
  const free = decide(base({ explicit: [{ ref: 'WSR3X', mode: 'VALOR', messageId: 'm1' }], owners: { WSR3X: [] } }));
  assert.equal(free.status, 'REF_COMPROVADA');
  assert.deepEqual(free.linkRefs, ['WSR3X']);
  assert.deepEqual(free.messageIds, ['m1']);
  const taken = decide(base({ explicit: [{ ref: 'QQQQ7', messageId: 'm2' }], owners: { QQQQ7: [OTHER] } }));
  assert.equal(taken.status, 'CONFLITO');
  assert.deepEqual(taken.linkRefs, []);
  assert.deepEqual(taken.conflict.conflicts[0].owners, [OTHER]);
});

test('print confirmado também comprova a Ref; duas Refs na mesma ficha são dois pedidos, nenhuma é perdida', () => {
  const verdict = decide(base({ print_refs: ['RNEVL'], explicit: [{ ref: 'WSR3X', messageId: 'm1' }], owners: {} }));
  assert.deepEqual(verdict.refs, ['RNEVL', 'WSR3X']);
  assert.deepEqual([...verdict.linkRefs].sort(), ['RNEVL', 'WSR3X']);
});

test('origem Calculadora comprovada sem Ref recuperável vira "referência a recuperar", sem inventar Ref', () => {
  const verdict = decide(base({ template: true }));
  assert.equal(verdict.status, 'CALCULADORA_REF_A_RECUPERAR');
  assert.equal(verdict.calcOrigin, true);
  assert.deepEqual(verdict.refs, []);
  assert.deepEqual(verdict.linkRefs, []);
  const none = decide(base());
  assert.equal(none.status, 'SEM_ORIGEM_CALCULADORA');
  assert.equal(none.calcOrigin, false);
});

test('código interno só é Ref com prova: simulação, mensagem ou print', () => {
  assert.equal(decide(base({ reference_code: 'K7M2P' })).status, 'SEM_ORIGEM_CALCULADORA');
  assert.equal(decide(base({ reference_code: 'K7M2P', run_refs: ['K7M2P'], owners: { K7M2P: [J] } })).status, 'REF_COMPROVADA');
});

test('o resumo muda só quando as provas mudam', () => {
  const first = hashOf(base());
  assert.equal(hashOf(base()), first);
  assert.notEqual(hashOf(base({ message_count: 4 })), first);
  assert.notEqual(hashOf(base({ template: true })), first);
  assert.notEqual(hashOf(base({ explicit: [{ ref: 'WSR3X', messageId: 'm1' }] })), first);
});

test('varredura retomável: sem resultado primeiro, repetir não liga duas vezes e uma falha não perde as outras', async () => {
  const applied = [], touched = [];
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const evidence = { [A]: base({ journey_id: A, explicit: [{ ref: 'WSR3X', messageId: 'm1' }] }), [B]: base({ journey_id: B, template: true }), [C]: base({ journey_id: C }) };
  const deps = {
    rpc: async (_ctx, name, body) => {
      if (name === 'panel_identity_evidence') return body.p_journey_ids.map((id) => evidence[id]);
      if (body.p_journey_id === B) throw new Error('DB_TIMEOUT');
      applied.push(body); return { linked: body.p_link_refs, blocked: [] };
    },
    patchRows: async (_ctx, _table, filters) => { touched.push(filters.journey_id); }
  };
  const states = new Map();
  const first = await evaluateJourneys({ environment: 'production' }, [A, B, C], states, deps);
  assert.equal(first.evaluated, 2); assert.equal(first.failed, 1); assert.equal(first.linked, 1);
  assert.equal(applied.length, 2, 'a falha de B não impediu A e C');
  states.set(A, { input_hash: hashOf(evidence[A]), rule_version: RULE_VERSION });
  const second = await evaluateJourneys({ environment: 'production' }, [A], states, deps);
  assert.equal(second.unchanged, 1); assert.equal(second.linked, 0);
  assert.equal(applied.length, 2, 'prova igual: nada aplicado de novo');
  assert.deepEqual(touched, ['eq.' + A]);
});

test('palavra comum depois de "ref:" nunca vira Ref; Ref do Claude só vale com simulação conhecida', () => {
  const lower = decide(base({ explicit: [{ ref: 'CAMRY', raw: 'Camry', mode: 'CARRO', messageId: 'm1' }], owners: { CAMRY: [] }, template: true }));
  assert.deepEqual(lower.linkRefs, [], 'digitada em minúsculas e sem simulação: não liga');
  assert.equal(lower.status, 'CALCULADORA_REF_A_RECUPERAR');
  const typedUpper = decide(base({ explicit: [{ ref: 'WSR3X', raw: 'WSR3X', messageId: 'm1' }], owners: {} }));
  assert.deepEqual(typedUpper.linkRefs, ['WSR3X']);
  const withRun = decide(base({ explicit: [{ ref: 'CAMRY', raw: 'Camry', messageId: 'm1' }], run_refs: ['CAMRY'], owners: {} }));
  assert.deepEqual(withRun.linkRefs, ['CAMRY'], 'se existe a simulação dessa Ref, a escrita do cliente vale');
  const claudeNoRun = decide(base({ claude_refs: [{ ref: 'ABCD2', messageId: 'm2', verified: true }], owners: {}, template: true }));
  assert.deepEqual(claudeNoRun.linkRefs, []);
  const claudeRun = decide(base({ claude_refs: [{ ref: 'ABCD2', messageId: 'm2', verified: true }], run_refs: ['ABCD2'], owners: {} }));
  assert.deepEqual(claudeRun.linkRefs, ['ABCD2']);
});

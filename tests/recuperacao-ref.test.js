'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const identity = require('../panel-identity');
const groups = require('../panel-groups');

const TEMPLATE = 'Hello My Car Scout, I want to calculate my cost.\nVehicle search request\nMaximum bid: US$ 6.000\nDodge Challenger';
const run = (ref, lance, marca = 'Dodge') => ({ ref, first_at: '2026-10-02T10:00:00Z', dados: { lance, marca, modelo: '' } });
const base = { journey_id: 'j1', reference_code: null, linked_refs: [], explicit: [], print_refs: [], run_refs: [], owners: {}, template: true, message_count: 1 };

test('desempate: uma simulação da janela com critérios idênticos liga a Ref', () => {
  const result = identity.recoverRef({ text: TEMPLATE, candidates: [run('AAAAA', 6000)] });
  assert.deepEqual([result.outcome, result.ref, result.by], ['RECOVERED', 'AAAAA', 'janela']);
});

test('desempate: várias na janela, só uma com critérios idênticos', () => {
  const result = identity.recoverRef({ text: TEMPLATE, candidates: [run('AAAAA', 6000), run('BBBBB', 7000)] });
  assert.equal(result.ref, 'AAAAA');
  assert.equal(identity.recoverRef({ text: TEMPLATE, candidates: [run('AAAAA', 6000), run('BBBBB', 9000, 'Ford')] }).ref, 'AAAAA');
});

test('empate persistente vai para a fila com as duas candidatas e nada é ligado', () => {
  const result = identity.recoverRef({ text: TEMPLATE, candidates: [run('AAAAA', 6000), run('BBBBB', 6000)] });
  assert.equal(result.outcome, 'TIE');
  const verdict = identity.decide({ ...base, tie: [{ ref: 'AAAAA' }, { ref: 'BBBBB' }] });
  assert.equal(verdict.status, 'CALCULADORA_REF_A_RECUPERAR');
  assert.deepEqual(verdict.linkRefs, []);
  assert.equal(verdict.conflict.tie.length, 2);
});

test('nunca inventa Ref: coincidência de horário sozinha, ref de outra ficha ou critério contrário não ligam', () => {
  assert.equal(identity.recoverRef({ text: 'My Car Scout calculate my cost', candidates: [run('AAAAA', 6000)] }).outcome, 'NONE');
  assert.equal(identity.recoverRef({ text: TEMPLATE, candidates: [run('AAAAA', 6000)], owners: { AAAAA: ['outra'] }, here: 'j1' }).outcome, 'NONE');
  assert.equal(identity.recoverRef({ text: TEMPLATE, candidates: [run('AAAAA', 9000, 'Ford')] }).outcome, 'NONE');
});

test('Ref recuperada vira REF_COMPROVADA com a origem da prova; a escrita pelo cliente continua primeiro', () => {
  const verdict = identity.decide({ ...base, recovered: [{ ref: 'AAAAA', by: 'janela', messageId: 'm1' }] });
  assert.equal(verdict.status, 'REF_COMPROVADA');
  assert.deepEqual(verdict.linkRefs, ['AAAAA']);
  assert.equal(verdict.evidence.recovered[0].by, 'janela');
});

test('a fila de empate aparece no Atendimento com as duas candidatas lado a lado', () => {
  const group = groups.classify(groups.factsFor({ template: true, identity: { status: 'CALCULADORA_REF_A_RECUPERAR', state: 'OK', conflict: { tie: [{ ref: 'AAAAA', lance: 6000, marca: 'Dodge' }, { ref: 'BBBBB', lance: 6000, marca: 'Dodge' }] } } }), Date.now());
  assert.equal(group.refTie.length, 2);
  const atendimento = require('../painel/atendimento.js');
  const reasons = atendimento.reasonsOf({ group }, Date.now());
  const tie = reasons.find((reason) => reason.kind === 'REF_EMPATE');
  assert.match(tie.text, /AAAAA.*BBBBB/);
});

test('evaluateJourneys: recupera pela janela e grava com a origem; repetir não grava de novo', async () => {
  const calls = [];
  const states = new Map();
  const deps = {
    loadTemplateMessage: async () => ({ id: 'm1', text: TEMPLATE, at: '2026-10-02T10:01:00Z' }),
    patchRows: async () => {},
    rpc: async (ctx, name, body) => {
      calls.push([name, body]);
      if (name === 'panel_identity_evidence') return [{ ...base }];
      if (name === 'panel_calc_run_candidates') return [run('AAAAA', 6000)];
      return { linked: ['AAAAA'] };
    }
  };
  const ctx = { environment: 'PRODUCTION' };
  const summary = await identity.evaluateJourneys(ctx, ['j1'], states, deps);
  assert.equal(summary.linked, 1);
  const apply = calls.find(([name]) => name === 'panel_identity_apply')[1];
  assert.equal(apply.p_status, 'REF_COMPROVADA');
  assert.deepEqual(apply.p_link_refs, ['AAAAA']);
  assert.equal(apply.p_evidence.recovered[0].by, 'janela');
});

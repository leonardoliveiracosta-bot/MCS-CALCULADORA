'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const groups = require('../panel-groups');
const refProof = require('../panel-ref-proof');

const TEMPLATE = 'Hello My Car Scout, I want to calculate my cost.\nVehicle search request\nMaximum bid: US$ 5.000\nFind one for me';

test('modelo da calculadora sem Ref é origem Calculadora, nunca conversa direta', () => {
  assert.equal(refProof.isCalculatorTemplate(TEMPLATE), true);
  assert.equal(refProof.isCalculatorTemplate('Oi, tudo bem? queria um Camry'), false);
  const facts = groups.factsFor({ template: true, summary: { last_customer_at: new Date().toISOString() } });
  const group = groups.classify(facts, Date.now());
  assert.equal(group.refState, 'A_RECUPERAR');
  assert.notEqual(groups.areaOf({ group }), 'SEM_REF');
});

test('três estados: com Ref, a recuperar, sem evidência', () => {
  assert.equal(groups.refStateOf({ hasCalcRef: true }), 'COM_REF');
  assert.equal(groups.refStateOf({ template: true }), 'A_RECUPERAR');
  assert.equal(groups.refStateOf({ identity: { status: 'CALCULADORA_REF_A_RECUPERAR' } }), 'A_RECUPERAR');
  assert.equal(groups.refStateOf({}), 'SEM_REF');
  assert.equal(groups.refStateOf({ hasCalcRef: true, template: true }), 'COM_REF');
  assert.deepEqual(groups.REF_STATE_ORDER, ['COM_REF', 'A_RECUPERAR', 'SEM_REF']);
  assert.equal(groups.REF_STATES.A_RECUPERAR.label, 'Calculadora, referência a recuperar');
});

test('painel: filtros e selects oferecem os três estados', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'painel', 'index.html'), 'utf8');
  for (const value of ['with', 'recover', 'without']) {
    assert.match(html, new RegExp('data-today-ref="' + value + '"'));
    assert.match(html, new RegExp('<option value="' + value + '">'));
  }
});

test('toque na vitrine com o código do link cai em um dos três estados de Ref', async () => {
  const { payload } = require('../api/panel/vitrine-requests.js');
  assert.equal(typeof payload, 'function');
  const text = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'api', 'panel', 'vitrine-requests.js'), 'utf8');
  // pedidos e sinais carregam refState e a ficha resolvida pelo código da vitrine
  assert.match(text, /refState:refStateFor\(journeyId\)/);
  assert.equal((text.match(/refState:refStateFor\(signalJourney\)/g) || []).length, 3);
  assert.match(text, /groups\.refStateOf/);
});

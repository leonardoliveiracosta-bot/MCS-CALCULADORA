'use strict';
// "A IA LEU A CONVERSA" só traz o que é novo: nada que a ficha ou a mensagem da calculadora já informaram.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validatedReading, alreadyInFicha } = require('../panel-ai');

const CALC = `EN · NOW · $15,000 · Cadillac Escalade · 1st\n\nHello! I just ran a simulation on the My Car Scout calculator\n\nName: Anderson\nVehicle: Cadillac Escalade\nZIP code: 33076 — Pompano Beach, Florida\nMaximum bid: $15,000\nPayment method: Financing — already approved\nPlanning to buy: Ready to buy now\n\nRef: M3456`;
const ficha = { carros: ['Cadillac Escalade'], lance: 15000, teto: null, pagamento: 'Financing — already approved', prazo: 'Ready to buy now', etapa: null, anos: null, milhas: null };

test('itens tirados da mensagem da calculadora ou iguais à ficha não aparecem; o carro novo da conversa aparece', () => {
  const later = 'Also I would consider a Chevrolet Tahoe';
  const parsed = { summary: { want: 'Cadillac Escalade ou Tahoe', status: 'Aguardando opções', next: 'Enviar opções' }, questions: [{ question: 'Já tem carros?', evidence: 'any news on the cars?' }], contradictions: [],
    items: [
      { type: 'stage', value: 'PRONTO_PARA_COMPRAR', evidence: 'Planning to buy: Ready to buy now' },
      { type: 'budget', value: 15000, evidence: 'Maximum bid: $15,000' },
      { type: 'payment', value: 'fin', evidence: 'Payment method: Financing — already approved' },
      { type: 'wishlist', value: { operation: 'include', car: { make: 'Chevrolet', model: 'Tahoe' } }, evidence: 'Chevrolet Tahoe' }
    ] };
  const bodies = [CALC, later, 'Hi, any news on the cars?'];
  const out = validatedReading(parsed, bodies.join('\n'), { wishes: [], timezone: 'America/New_York' }, bodies, ficha);
  assert.deepEqual(out.items.map((entry) => entry.item.type), ['wishlist']);
  assert.equal(out.summary.questions.length, 1);
  assert.equal(out.summary.onlyNew, true);
  assert.equal(out.summary.next, 'Enviar opções');
});

test('pagamento ou prazo iguais à ficha, ditos na conversa, também não voltam', () => {
  assert.equal(alreadyInFicha({ type: 'payment', value: 'financing', evidence: 'I will finance it' }, ficha, []), true);
  assert.equal(alreadyInFicha({ type: 'payment', value: 'cash', evidence: 'I will pay cash' }, ficha, []), false);
  assert.equal(alreadyInFicha({ type: 'deadline', value: 'now', evidence: 'I need it now' }, ficha, []), true);
});

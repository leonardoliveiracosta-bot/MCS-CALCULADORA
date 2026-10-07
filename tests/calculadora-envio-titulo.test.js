'use strict';

// Calculadora: o envio do título ($45, Title Mailing Fee) desce para o bloco de baixo só fora da Flórida à vista,
// onde a documentação de $599 ficaria sozinha ("Purchase & title"). Nos outros casos os $599 já vêm somados com
// imposto, título e emplacamento e o envio do título fica na taxa do leilão. O total é sempre o mesmo.
const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../calc-core');

const caso = (florida, pgto) => ({ lance: 30000, inspecao: false, florida, placa: 'transf', pgto, estado: florida ? '' : '0', zip: florida ? '33101' : '85001' });

test('fora da Flórida à vista: os $599 nunca ficam sozinhos (bloco de baixo $644 com o envio do título)', () => {
  const r = calc.calcular(caso(false, 'cash'));
  assert.equal(r.caso, 3);
  assert.deepEqual(r.fixasLeilao.map((f) => f.nome), ['Environmental Fee']);
  assert.equal(r.gGrupo, 644);
  assert.equal(r.dLeilao + r.gGrupo + r.dMcs, r.acimaLance);
});

for (const [nome, entrada] of [['Flórida à vista', caso(true, 'cash')], ['Flórida financiado', caso(true, 'fin')], ['fora da Flórida financiado', caso(false, 'fin')]]) {
  test(`${nome}: envio do título fica na taxa do leilão; os $599 já vêm somados no bloco de baixo`, () => {
    const r = calc.calcular(entrada);
    assert.deepEqual(r.fixasLeilao.map((f) => f.nome), ['Environmental Fee', 'Title Mailing Fee']);
    assert.equal(r.dLeilao, Math.round(r.taxaLeilao) + 95);
    assert.ok(r.gGrupo > 599);
    assert.equal(r.dLeilao + r.gGrupo + r.dMcs, r.acimaLance);
  });
}

test('exemplo do print (Flórida à vista, lance $30.000): taxa do leilão $695, bloco de baixo $3.217, total $35.012', () => {
  const r = calc.calcular(caso(true, 'cash'));
  assert.equal(r.dLeilao, 695);
  assert.equal(r.gGrupo, 3217);
  assert.equal(Math.round(r.totalProjetado), 35012);
});

'use strict';

// Calculadora: nos 4 casos o envio do título ($45, Title Mailing Fee) fica no bloco de baixo, junto da documentação
// de $599, e não na casa de leilão. Só muda onde aparece: o que se paga além do lance e o total ficam iguais.
const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../calc-core');

const caso = (florida, pgto) => ({ lance: 30000, inspecao: false, florida, placa: 'transf', pgto, estado: florida ? '' : '0', zip: florida ? '33101' : '85001' });
const casos = {
  'Flórida à vista': caso(true, 'cash'),
  'Flórida financiado': caso(true, 'fin'),
  'fora da Flórida à vista': caso(false, 'cash'),
  'fora da Flórida financiado': caso(false, 'fin')
};

for (const [nome, entrada] of Object.entries(casos)) {
  test(`${nome}: $45 do envio do título no bloco de baixo, total igual`, () => {
    const r = calc.calcular(entrada);
    assert.deepEqual(r.fixasLeilao.map((f) => f.nome), ['Environmental Fee']);
    // Casa de leilão: taxa do leilão + ambiental, sem o envio do título.
    assert.equal(r.dLeilao, Math.round(r.taxaLeilao) + 50);
    assert.equal(r.gLeilao, r.dLeilao);
    // Tudo que se paga além do lance continua somando igual (o $45 só trocou de bloco).
    assert.equal(r.dLeilao + r.gGrupo + r.dMcs, r.acimaLance);
    assert.equal(r.gTaxReg, r.gGrupo);
  });
}

test('exemplo do print (Flórida à vista, lance $30.000): casa de leilão $650, total $35.012 como antes', () => {
  const r = calc.calcular(casos['Flórida à vista']);
  assert.equal(r.dLeilao, 650);
  assert.equal(r.gGrupo, 3262);
  assert.equal(Math.round(r.totalProjetado), 35012);
});

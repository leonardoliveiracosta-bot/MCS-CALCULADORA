'use strict';
// Cartão 5: terceira coluna segue o filtro (regra determinística, sem IA).
const test = require('node:test');
const assert = require('node:assert/strict');
const { realityList } = require('../panel-reality');
const car = (year, model, miles, mmr, id) => ({ year, make: 'Cadillac', model, miles, mmrCents: mmr, rowFingerprint: id || `${year}${model}${miles}` });

test('lance máximo informado: coluna de milhas, MMR típico no veredito, ordem ano desc e milhas asc', () => {
  const options = [car(2018, 'Escalade', 124809), car(2019, 'Escalade', 101920), car(2018, 'Escalade', 110183), car(2019, 'Escalade ESV', 105180)];
  const out = realityList({ options, reference: options.map((item) => ({ ...item, mmrCents: 1387500 })), maxBidCents: 1500000, milesCap: false, typicalCents: [1387500] });
  assert.equal(out.column, 'MILHAS');
  assert.equal(out.verdict, '4 opções dentro do teto');
  assert.equal(out.typicalCents, 1387500);
  assert.deepEqual(out.rows.map((row) => `${row.year} ${row.model} ${row.miles}`), ['2019 Escalade 101920', '2019 Escalade ESV 105180', '2018 Escalade 110183', '2018 Escalade 124809']);
});

test('sem lance, com teto de milhas e MMR diferente em todas as linhas: coluna MMR', () => {
  const options = [car(2021, 'Escalade', 40000), car(2020, 'Escalade', 50000)];
  const reference = [car(2021, 'Escalade', 1, 1680000), car(2020, 'Escalade', 1, 1540000)];
  const out = realityList({ options, reference, maxBidCents: null, milesCap: true, typicalCents: [1600000] });
  assert.equal(out.column, 'MMR');
  assert.equal(out.verdict, '2 opções dentro das milhas');
  assert.equal(out.typicalCents, null);
  assert.match(out.label, /MMR/);
  assert.deepEqual(out.rows.map((row) => row.mmrCents), [1680000, 1540000]);
});

test('sem lance, com teto de milhas e alguma linha sem MMR: milhas, com MMR típico no veredito', () => {
  const options = [car(2021, 'Escalade', 40000), car(2020, 'Escalade', 50000)];
  const out = realityList({ options, reference: [car(2021, 'Escalade', 1, 1680000)], maxBidCents: 0, milesCap: true, typicalCents: [1600000] });
  assert.equal(out.column, 'MILHAS');
  assert.equal(out.typicalCents, 1600000);
});

test('sem lance e sem teto de milhas: quatro colunas; sem opções: mensagem; uma opção: uma linha', () => {
  const one = realityList({ options: [car(2019, 'Escalade', 89300)], reference: [car(2019, 'Escalade', 1, 1420000)], maxBidCents: null, milesCap: false, typicalCents: [] });
  assert.equal(one.column, 'MILHAS_MMR');
  assert.equal(one.verdict, '1 opção no lote');
  assert.equal(one.rows.length, 1);
  const none = realityList({ options: [], maxBidCents: 1500000 });
  assert.equal(none.verdict, 'Nenhuma opção no lote dentro dos filtros');
  assert.equal(none.rows.length, 0);
});

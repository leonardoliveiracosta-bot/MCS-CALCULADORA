'use strict';

// Service fee table (owner's table of 2026-09-29): one source, calc-core.js, for the calculator,
// the site, the real purchase cards and the panel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const core = require('../calc-core.js');
const site = read('index.html');
const calculator = read('msc-calculadora.html');

// The previous table, only here, to measure the change. Production code has one table.
function previousCore() {
  const source = read('calc-core.js')
    .replace(/faixas: \[[\s\S]*?\]/, 'faixas: [{ ate: 3000, valor: 250 }, { ate: 5000, valor: 350 }, { ate: 7500, valor: 450 }, { ate: 10000, valor: 550 }, { ate: 15000, valor: 650 }, { ate: 20000, valor: 800 }]')
    .replace(/base: 900,/, 'base: 800,');
  const sandbox = { module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  return sandbox.module.exports;
}
const before = previousCore();

const money = (value) => '$' + Math.round(value).toLocaleString('en-US');

test('service fee: faixas novas nas bordas', () => {
  const expected = [[3000, 300], [3001, 400], [5000, 400], [5001, 550], [7500, 550], [7501, 650], [10000, 650], [10001, 750],
    [15000, 750], [15001, 900], [20000, 900], [20001, 950], [22500, 950], [22501, 1000], [25000, 1000], [40000, 1300], [300000, 6500]];
  for (const [bid, fee] of expected) assert.equal(core.servicoDe(bid), fee, `lance ${bid}`);
  assert.deepEqual(core.CONFIG.servico.faixas, [
    { ate: 3000, valor: 300 }, { ate: 5000, valor: 400 }, { ate: 7500, valor: 550 },
    { ate: 10000, valor: 650 }, { ate: 15000, valor: 750 }, { ate: 20000, valor: 900 }
  ]);
  assert.deepEqual([core.CONFIG.servico.limite, core.CONFIG.servico.base, core.CONFIG.servico.blocoAdicional, core.CONFIG.servico.valorPorBloco], [20000, 900, 2500, 50]);
  assert.equal(before.servicoDe(17900), 800, 'a tabela anterior do teste é a de produção antes da troca');
});

test('service fee: total sobe a diferença da taxa (e do imposto arredondado na Flórida) e o depósito não muda', () => {
  const increases = { 3000: [50, 54], 4000: [50, 54], 9700: [100, 107], 15000: [100, 107], 17900: [100, 107], 22501: [100, 107], 40000: [100, 107] };
  const scenario = (florida) => ({ florida, estado: florida ? '' : 'other', pgto: 'cash', inspecao: false, placa: 'transfer', zip: '' });
  for (const [bidText, [outside, inFlorida]] of Object.entries(increases)) {
    const bid = Number(bidText);
    const feeDelta = core.servicoDe(bid) - before.servicoDe(bid);
    for (const florida of [false, true]) {
      const now = core.calcular({ lance: bid, ...scenario(florida) });
      const then = before.calcular({ lance: bid, ...scenario(florida) });
      const taxDelta = florida ? now.imposto - then.imposto : 0;
      assert.equal(now.totalProjetado - then.totalProjetado, feeDelta + taxDelta, `lance ${bid} florida=${florida}`);
      assert.equal(now.totalProjetado - then.totalProjetado, florida ? inFlorida : outside, `aumento esperado ${bid} florida=${florida}`);
      assert.equal(now.deposito, then.deposito, `depósito ${bid}`);
      assert.equal(now.taxaLeilao, then.taxaLeilao, `taxa de leilão ${bid}`);
    }
  }
});

// ------------------------------------------------------------------ site: seção #taxas
function feeSection() {
  const start = site.indexOf('<section id="taxas"');
  return site.slice(start, site.indexOf('</section>', start));
}
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function i18n(lang) {
  const line = site.split('\n').find((row) => row.trimStart().startsWith(lang + ': {"'));
  assert.ok(line, 'dicionário ' + lang);
  return JSON.parse(line.trim().slice(lang.length + 2).replace(/,\s*$/, ''));
}

test('site: as seis linhas da tabela batem com CONFIG.servico.faixas', () => {
  const rows = [...feeSection().matchAll(/<tr><td[^>]*>([^<]+)<\/td><td class="fee-val">([^<]+)<\/td><\/tr>/g)].map((match) => [match[1], match[2]]);
  let floor = 0;
  const expected = core.CONFIG.servico.faixas.map((tier) => {
    const label = floor === 0 ? `Up to ${money(tier.ate)}` : `${money(floor + 1)} – ${money(tier.ate)}`;
    floor = tier.ate;
    return [label, money(tier.valor)];
  });
  assert.deepEqual(rows, expected);
});

test('site: regra acima de US$ 20.000 com base 900, +50 e bloco de 2.500 nos três idiomas', () => {
  const above = feeSection().match(/<div class="fee-above">([\s\S]*?)<\/div>/)[1];
  assert.match(above, /<span class="fee-plus">\+\$50 \/ \$2,500<\/span>/);
  const plus = textOf(above.match(/<span class="fee-plus">[\s\S]*?<\/span>/)[0]);
  for (const lang of ['en', 'es', 'pt']) {
    const rule = i18n(lang).fee_above;
    assert.match(rule, /\$900/, lang);
    assert.doesNotMatch(rule, /\$800/, lang);
    // What a screen reader reads inside .fee-above: the translated rule plus the indicator.
    const spoken = `${rule} ${plus}`;
    for (const value of [/\$900\b/, /\$50\b/, /\$2[.,]500\b/]) assert.match(spoken, value, `${lang}: ${value}`);
  }
  assert.match(textOf(above), /\$900 base/);
});

// ------------------------------------------------------------------ compras reais
// Compra real = o que foi pago: lance + cada taxa registrada no compras.json, sem recalcular pela tabela de hoje.
const purchases = JSON.parse(read('data/compras.json'));
const FEES = [['Auction fee', 'taxaLeilao'], ['Environmental fee', 'taxaAmbiental'], ['Title mailing', 'envioTitulo'], ['Service fee', 'taxaServico']];
function card(purchase) {
  const total = Number(purchase.lance) + FEES.reduce((sum, [, key]) => sum + Number(purchase[key]), 0);
  const reference = Number(purchase.referencia);
  return { total, less: reference - total, pct: ((reference - total) / reference * 100).toFixed(2) };
}

test('compras reais: valores registrados, sem recalcular pela tabela atual', () => {
  const expected = {
    'Charger R/T': { total: 10895, less: 8955, pct: '45.11' },
    'Macan GTS': { total: 19595, less: 7135, pct: '26.69' },
    X3: { total: 19335, less: 6465, pct: '25.06' },
    'Escalade Luxury': { total: 31595, less: 9405, pct: '22.94' }
  };
  assert.deepEqual(Object.keys(expected).sort(), purchases.map((purchase) => purchase.modelo).sort());
  for (const purchase of purchases) {
    for (const [, key] of FEES) assert.ok(Number.isFinite(Number(purchase[key])), purchase.modelo + ' ' + key);
    assert.deepEqual(card(purchase), expected[purchase.modelo], purchase.modelo);
  }
  const render = site.slice(site.indexOf('function renderPurchase(d){'), site.indexOf('/* ===== carrossel ===== */'));
  assert.doesNotMatch(render, /core\.calcular/, 'o cartão não recalcula');
  for (const [label, key] of FEES) assert.match(render, new RegExp('\\["' + label + '",Number\\(d\\.' + key + '\\)\\]'));
});

test('compras reais: o X3 é o da imagem do bloco 2 (og-image): $19,335, $6,465 a menos, 25.06%', () => {
  const x3 = purchases.find((purchase) => purchase.modelo === 'X3');
  assert.deepEqual([x3.lance, x3.taxaLeilao, x3.taxaAmbiental, x3.envioTitulo, x3.taxaServico, x3.referencia], [17900, 600, 15, 20, 800, 25800]);
  assert.match(site, /og:image:alt" content="A real My Car Scout purchase at \$19,335 against a \$25,800 retail reference\."/);
});

test('compras reais: o cartão estático do X3 é igual ao renderizado', () => {
  const start = site.indexOf('<section id="real-purchase"');
  const html = site.slice(start, site.indexOf('</section>', start));
  const pick = (pattern) => (html.match(pattern) || [])[1];
  const row = (label) => pick(new RegExp('<span>' + label + '</span><span>([^<]+)</span>'));
  const x3 = purchases.find((purchase) => purchase.modelo === 'X3');
  const dynamic = card(x3);
  assert.deepEqual({
    title: pick(/<h3 class="rpx-title">([^<]+)</),
    price: pick(/<p class="rpx-price">([^<]+)</),
    label: pick(/<p class="rpx-label">([^<]+)</),
    reference: pick(/<p class="rpx-ref">([^<]+)</),
    less: pick(/<p class="rpx-less">([^<]+)</),
    pct: pick(/<p class="rpx-less-sub">([^<]+)</),
    bid: row('Auction purchase'), auction: row('Auction fee'), env: row('Environmental fee'), mailing: row('Title mailing'), service: row('Service fee'), total: row('Total paid')
  }, {
    title: `${x3.ano} ${x3.marca} ${x3.modelo}`,
    price: money(dynamic.total),
    label: 'MY CAR SCOUT · PURCHASE + FEES',
    reference: money(x3.referencia),
    less: money(dynamic.less) + ' LESS',
    pct: dynamic.pct + '% BELOW REFERENCE',
    bid: money(x3.lance), auction: money(x3.taxaLeilao), env: money(x3.taxaAmbiental), mailing: money(x3.envioTitulo), service: money(x3.taxaServico), total: money(dynamic.total)
  });
});

// ------------------------------------------------------------------ fonte única e cache
test('fonte única: calculadora, site e painel usam o calc-core e não há outra tabela', () => {
  assert.match(calculator, /MCSCalcCore\.servicoDe\(lance, P\)/);
  assert.match(read('panel-lead.js'), /require\('\.\/calc-core'\)/);
  assert.match(read('panel-ready.js'), /require\('\.\/calc-core'\)/);
  const published = ['index.html', 'msc-calculadora.html', 'panel-lead.js', 'panel-ready.js', 'painel/lead.js', 'painel/painel.js'];
  for (const file of published) assert.doesNotMatch(read(file), /faixas\s*:|valorPorBloco|blocoAdicional/, file);
});

test('cache: site e calculadora carregam a mesma versão do calc-core', () => {
  const siteSrc = site.match(/<script src="\/?(calc-core\.js[^"]*)"><\/script>/)[1];
  const calcSrc = calculator.match(/<script src="\/?(calc-core\.js[^"]*)"><\/script>/)[1];
  assert.equal(siteSrc, 'calc-core.js?v=deposito-faixas-20261004');
  assert.equal(calcSrc, siteSrc);
  assert.equal((site.match(/calc-core\.js/g) || []).length - (site.match(/\(calc-core\.js\)/g) || []).length, 1, 'uma única tag no site');
});

test('valores antigos: nada da tabela anterior no que vai ao ar', () => {
  const ignored = new Set(read('.vercelignore').split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  assert.ok(ignored.has('card-preview.html'));
  for (const file of ['index.html', 'msc-calculadora.html', 'calc-core.js', 'data/compras.json']) {
    const text = read(file);
    assert.doesNotMatch(text, /\$800 (base|de base)/, file);
    assert.doesNotMatch(text, /valor: 250\b[\s\S]{0,80}valor: 350\b/, file);
    assert.doesNotMatch(text, /\$250<\/td>|\$350<\/td>|\$450<\/td>/, file);
    assert.doesNotMatch(text, /\$19,994|\$5,806 LESS|22\.50% BELOW/, file);
  }
});

test('depósito por faixa: 10% até $50.000, 15% até $99.999, 20% a partir de $100.000, mínimo de $500', () => {
  const dep = (lance) => core.calcular({ lance, florida: true, estado: '', pgto: 'cash', inspecao: false, placa: 'transfer', zip: '' });
  for (const [lance, pct, valor] of [[3000, 10, 500], [12000, 10, 1200], [50000, 10, 5000], [50100, 15, 7515], [99900, 15, 14985], [100000, 20, 20000], [150000, 20, 30000]]) {
    const r = dep(lance);
    assert.equal(r.depPct, pct, `faixa ${lance}`);
    assert.equal(Math.round(r.deposito), valor, `depósito ${lance}`);
  }
});

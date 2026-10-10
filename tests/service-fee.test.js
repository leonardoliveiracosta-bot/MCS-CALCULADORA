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
// Compra real = a conta da calculadora para o lance registrado: os itens do bloco "Where it goes"
// (Vehicle, Auction fee, My Car Scout), Flórida à vista, sem os campos do estado.
const purchases = JSON.parse(read('data/compras.json'));
const ITEMS = [['Vehicle', 'dCarro'], ['Auction fee', 'dLeilao'], ['My Car Scout', 'dMcs']];
function card(purchase) {
  const r = core.calcular({ lance: Number(purchase.lance), florida: true, pgto: 'cash', inspecao: false });
  const rows = ITEMS.map(([label, key]) => [label, r[key]]);
  const total = rows.reduce((sum, [, value]) => sum + value, 0);
  const reference = Number(purchase.referencia);
  return { rows, total, less: reference - total, pct: ((reference - total) / reference * 100).toFixed(2) };
}

test('compras reais: itens e valores da calculadora atual para os quatro carros', () => {
  const expected = {
    'Charger R/T': { rows: [['Vehicle', 9700], ['Auction fee', 645], ['My Car Scout', 650]], total: 10995, less: 8855, pct: '44.61' },
    'Macan GTS': { rows: [['Vehicle', 18100], ['Auction fee', 695], ['My Car Scout', 900]], total: 19695, less: 7035, pct: '26.32' },
    X3: { rows: [['Vehicle', 17900], ['Auction fee', 695], ['My Car Scout', 900]], total: 19495, less: 6305, pct: '24.44' },
    'Escalade Luxury': { rows: [['Vehicle', 29900], ['Auction fee', 695], ['My Car Scout', 1100]], total: 31695, less: 9305, pct: '22.70' }
  };
  assert.deepEqual(Object.keys(expected).sort(), purchases.map((purchase) => purchase.modelo).sort());
  for (const purchase of purchases) assert.deepEqual(card(purchase), expected[purchase.modelo], purchase.modelo);
  const render = site.slice(site.indexOf('function renderPurchase(d){'), site.indexOf('/* ===== carrossel ===== */'));
  assert.match(render, /MCSCalcCore\.calcular\(\{lance:lance,florida:true,pgto:"cash",inspecao:false\}\)/, 'o cartão usa a calculadora');
  for (const [label, key] of ITEMS) assert.match(render, new RegExp('\\["' + label + '",r\\.' + key + '\\]'));
  assert.doesNotMatch(render, /taxaServico|taxaAmbiental|envioTitulo|Service fee|Environmental|Title mailing/, 'sem os campos antigos');
});

test('compras reais: os nomes dos itens são os da calculadora (Where it goes)', () => {
  const en = calculator.split('\n').find((row) => row.trimStart().startsWith('en: {"'));
  const dict = JSON.parse(en.trim().slice(4).replace(/,\s*$/, ''));
  assert.deepEqual([dict.d_car, dict.d_auc, dict.d_mcs], ITEMS.map(([label]) => label));
  assert.match(calculator, /linhaOnde\(T\("d_car"\), T\("d_car_s"\), r\.dCarro\)/);
  assert.match(calculator, /linhaOnde\(T\("d_auc"\), T\("d_auc_s"\), r\.dLeilao\)/);
  assert.match(calculator, /linhaOnde\(T\("d_mcs"\), [^,]+, r\.dMcs, true\)/);
});

test('compras reais: o cartão estático do X3 é igual ao renderizado', () => {
  const start = site.indexOf('<section id="real-purchase"');
  const html = site.slice(start, site.indexOf('</section>', start));
  const pick = (pattern) => (html.match(pattern) || [])[1];
  const rows = [...html.matchAll(/<div class="rpx-row[^"]*"><span>([^<]+)<\/span><span>([^<]+)<\/span><\/div>/g)].map((match) => [match[1], match[2]]);
  const x3 = purchases.find((purchase) => purchase.modelo === 'X3');
  const dynamic = card(x3);
  assert.deepEqual({
    title: pick(/<h3 class="rpx-title">([^<]+)</),
    price: pick(/<p class="rpx-price">([^<]+)</),
    label: pick(/<p class="rpx-label">([^<]+)</),
    reference: pick(/<p class="rpx-ref">([^<]+)</),
    less: pick(/<p class="rpx-less">([^<]+)</),
    pct: pick(/<p class="rpx-less-sub">([^<]+)</),
    rows
  }, {
    title: `${x3.ano} ${x3.marca} ${x3.modelo}`,
    price: money(dynamic.total),
    label: 'MY CAR SCOUT · PURCHASE + FEES',
    reference: money(x3.referencia),
    less: money(dynamic.less) + ' LESS',
    pct: dynamic.pct + '% BELOW REFERENCE',
    rows: [...dynamic.rows.map(([label, value]) => [label, money(value)]), ['Total paid', money(dynamic.total)]]
  });
});

test('Sold: as respostas que citam o X3 usam os mesmos valores do cartão', () => {
  const sold = read('sold-assistant.js');
  assert.doesNotMatch(sold, /19[,.]335|6[,.]465|25[,.]06/);
  assert.equal((sold.match(/\$19,495/g) || []).length, 6);
  assert.equal((sold.match(/\$19\.495/g) || []).length, 3);
  assert.match(sold, /\$6,305 less, 24\.44% below/);
  assert.match(sold, /\$6\.305 a menos, 24,44% abaixo/);
  assert.match(sold, /vehicle \$17,900 \+ auction fee \$695 \+ My Car Scout \$900 = \$19,495/);
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
  assert.equal(siteSrc, 'calc-core.js?v=onde-vai-20261007');
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

test('imagem de compartilhamento: mesmo total do cartão do X3 ($19,495) e endereço novo para os apps buscarem de novo', () => {
  const x3 = card(purchases.find((purchase) => purchase.modelo === 'X3'));
  assert.equal(x3.total, 19495);
  assert.match(site, /og:image:alt" content="A real My Car Scout purchase at \$19,495 against a \$25,800 retail reference\."/);
  assert.equal((site.match(/https:\/\/mycarscout\.net\/og-image\.jpg\?v=19495/g) || []).length, 2, 'og:image e twitter:image');
  assert.doesNotMatch(site, /19,335/);
});

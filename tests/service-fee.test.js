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
const purchases = JSON.parse(read('data/compras.json'));
// Same call as renderPurchase in index.html (read from the page so both stay the same).
const renderCall = site.match(/function renderPurchase\(d\)\{[\s\S]*?core\.calcular\((\{[^)]*\})\)/);
const renderArgs = (bid) => vm.runInNewContext('(' + renderCall[1] + ')', { lance: bid });

function card(purchase) {
  const result = core.calcular(renderArgs(Number(purchase.lance)));
  const total = result.totalProjetado, reference = Number(purchase.referencia);
  return { fee: result.servico, service: result.dMcs, auction: result.dLeilao, title: result.gGrupo, total, less: reference - total, pct: ((reference - total) / reference * 100).toFixed(2) };
}

test('compras reais: recalculadas com a tabela nova', () => {
  assert.ok(renderCall, 'renderPurchase chama core.calcular');
  const expected = {
    'Charger R/T': { fee: 650, total: 11594, less: 8256, pct: '41.59' },
    'Macan GTS': { fee: 900, total: 20294, less: 6436, pct: '24.08' },
    X3: { fee: 900, total: 20094, less: 5706, pct: '22.12' },
    'Escalade Luxury': { fee: 1100, total: 32294, less: 8706, pct: '21.23' }
  };
  assert.deepEqual(Object.keys(expected).sort(), purchases.map((purchase) => purchase.modelo).sort());
  for (const purchase of purchases) {
    const { fee, service, total, less, pct } = card(purchase);
    assert.deepEqual({ fee, total, less, pct }, expected[purchase.modelo], purchase.modelo);
    assert.equal(service, fee, 'sem inspeção, a linha Service fee é a própria taxa');
  }
});

test('compras reais: a service fee vem só do calc-core', () => {
  assert.ok(purchases.every((purchase) => !Object.hasOwn(purchase, 'taxaServico')), 'nenhum taxaServico no JSON');
  assert.deepEqual(Object.keys(purchases[0]), ['ano', 'marca', 'modelo', 'milhas', 'lance', 'taxaLeilao', 'taxaAmbiental', 'envioTitulo', 'referencia', 'fonteRef', 'foto']);
  const render = site.slice(site.indexOf('function renderPurchase(d){'), site.indexOf('/* ===== carrossel ===== */'));
  assert.doesNotMatch(render, /taxaServico|d\.servico|d\.fee/);
  assert.match(render, /costRow\("Service fee",r\.dMcs\)/);
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
    reference: pick(/<p class="rpx-ref">([^<]+)</),
    less: pick(/<p class="rpx-less">([^<]+)</),
    pct: pick(/<p class="rpx-less-sub">([^<]+)</),
    bid: row('Auction purchase'), auction: row('Auction fee'), title2: row('Purchase &amp; title'), service: row('Service fee'), total: row('Total paid')
  }, {
    title: `${x3.ano} ${x3.marca} ${x3.modelo}`,
    price: money(dynamic.total),
    reference: money(x3.referencia),
    less: money(dynamic.less) + ' LESS',
    pct: dynamic.pct + '% BELOW REFERENCE',
    bid: money(x3.lance), auction: money(dynamic.auction), title2: money(dynamic.title), service: money(dynamic.service), total: money(dynamic.total)
  });
  assert.deepEqual([dynamic.auction, dynamic.title, dynamic.service, dynamic.total, dynamic.less, dynamic.pct], [650, 644, 900, 20094, 5706, '22.12']);
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

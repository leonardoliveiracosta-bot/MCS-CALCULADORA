'use strict';

// Service fee table in the browser: calculator, site fee section (3 languages) and real purchase
// cards, with the static fallback. Everything outside the local server is blocked, so the
// calculator never reaches calc_runs, ZIP lookups or fonts.
const { test, expect } = require('@playwright/test');
const path = require('node:path');

const executablePath = process.env.CHROMIUM_PATH || undefined;
const base = 'http://127.0.0.1:4173';
const shots = process.env.FEE_SHOTS || '';
test.use({ launchOptions: executablePath ? { executablePath } : {} });

async function isolate(page) {
  const blocked = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  return blocked;
}

const BIDS = [3000, 4000, 9700, 15000, 17900, 22501, 40000];
const OLD = { 3000: 250, 4000: 350, 9700: 550, 15000: 650, 17900: 800, 22501: 900, 40000: 1200 };
const NEW = { 3000: 300, 4000: 400, 9700: 650, 15000: 750, 17900: 900, 22501: 1000, 40000: 1300 };

test('calculadora: taxa e total da tabela nova em Florida e fora, sem gravar nada', async ({ page }) => {
  const blocked = await isolate(page);
  await page.goto(base + '/msc-calculadora.html');
  await expect.poll(() => page.evaluate(() => Boolean(window.MCSCalcCore))).toBe(true);
  // "Calculate My Cost" only opens the form (no WhatsApp or SMS).
  await page.getByText('CALCULATE MY COST', { exact: true }).click();
  if (await page.locator('#modal-ok').isVisible()) await page.locator('#modal-ok').click();
  await expect(page.locator('#resultado')).toBeVisible();
  const loaded = await page.evaluate(() => [...document.scripts].map((script) => script.getAttribute('src')).filter((src) => src && src.includes('calc-core')));
  expect(loaded).toEqual(['/calc-core.js?v=service-fee-20260929']);
  const rows = [];
  for (const [zip, florida] of [['33101', true], ['97201', false]]) {
    for (const bid of BIDS) {
      const shown = await page.evaluate(({ bid, zip }) => {
        document.getElementById('zip').value = zip;
        document.getElementById('lance').value = String(bid);
        document.getElementById('form').dispatchEvent(new Event('input', { bubbles: true }));
        const text = document.getElementById('saida').innerText;
        const d = lerForm(); const r = calcular(d);
        return { text, fee: r.servico, total: r.total, deposit: r.deposito, florida: d.florida, tax: d.florida ? r.imposto : r.impostoEstado };
      }, { bid, zip });
      expect(shown.florida).toBe(florida);
      expect(shown.fee).toBe(NEW[bid]);
      const usd = (value) => '$' + Math.round(value).toLocaleString('en-US');
      expect(shown.text).toContain(usd(shown.fee));
      expect(shown.text).toContain(usd(shown.total));
      rows.push({ bid, florida, fee: shown.fee, total: shown.total, deposit: shown.deposit, tax: shown.tax });
    }
  }
  // Oregon has no sales tax: outside Florida the total goes up exactly by the fee difference.
  const oregon = rows.filter((row) => !row.florida);
  for (const row of oregon) expect(row.tax).toBe(0);
  // Deposit rule untouched: 10% of the bid, minimum $500.
  for (const row of rows) expect(row.deposit).toBe(Math.max(row.bid * 0.1, 500));
  // The image card and the WhatsApp text come from the same calcular(d).
  const image = await page.evaluate(() => { const canvas = cartaoAtual(); return canvas.width > 0 && canvas.height > 0; });
  expect(image).toBe(true);
  const message = await page.evaluate(() => decodeURIComponent(linkWhatsApp(lerForm(), calcular(lerForm())).split('?text=')[1]));
  expect(message).toContain('$40,000');
  expect(message).not.toMatch(/\$1,200|\$800 base/);
  // Nothing outside the local server is ever reached (calc_runs, ZIP lookup, fonts): all aborted.
  await page.waitForTimeout(2800);
  expect(blocked.every((url) => !url.startsWith(base))).toBe(true);
  if (shots) {
    for (const [zip, name] of [['33101', 'fl'], ['97201', 'fora']]) {
      await page.evaluate((value) => { document.getElementById('zip').value = value; document.getElementById('lance').value = '17900'; document.getElementById('form').dispatchEvent(new Event('input', { bubbles: true })); }, zip);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator('#resultado').screenshot({ path: path.join(shots, `calculadora-17900-${name}-${width}.png`) });
      }
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
  console.log('TOTAIS', JSON.stringify(rows.map((row) => [row.bid, row.florida ? 'FL' : 'OR', OLD[row.bid] + '→' + row.fee, row.total])));
});

test('site: tabela de taxas nos três idiomas e compras reais recalculadas', async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(base + '/index.html');
  await expect(page.locator('#purchaseCards .rpx')).toHaveCount(4);
  const cards = await page.locator('#purchaseCards .rpx').evaluateAll((list) => list.map((card) => ({
    title: card.querySelector('.rpx-title').textContent,
    price: card.querySelector('.rpx-price').textContent,
    less: card.querySelector('.rpx-less').textContent,
    pct: card.querySelector('.rpx-less-sub').textContent,
    rows: [...card.querySelectorAll('.rpx-row')].map((row) => [...row.children].map((cell) => cell.textContent))
  })));
  const byTitle = Object.fromEntries(cards.map((card) => [card.title, card]));
  const expected = {
    '2018 Dodge Charger R/T': ['$650', '$11,594', '$8,256 LESS', '41.59% BELOW REFERENCE'],
    '2018 Porsche Macan GTS': ['$900', '$20,294', '$6,436 LESS', '24.08% BELOW REFERENCE'],
    '2021 BMW X3': ['$900', '$20,094', '$5,706 LESS', '22.12% BELOW REFERENCE'],
    '2020 Cadillac Escalade Luxury': ['$1,100', '$32,294', '$8,706 LESS', '21.23% BELOW REFERENCE']
  };
  for (const [title, [fee, total, less, pct]] of Object.entries(expected)) {
    const card = byTitle[title];
    expect(card, title).toBeTruthy();
    expect(Object.fromEntries(card.rows)['Service fee']).toBe(fee);
    expect(Object.fromEntries(card.rows)['Total paid']).toBe(total);
    expect([card.price, card.less, card.pct]).toEqual([total, less, pct]);
  }
  for (const lang of ['en', 'es', 'pt']) {
    await page.evaluate((value) => document.querySelector(`[data-set-lang="${value}"]`).click(), lang);
    await expect(page.locator('html')).toHaveAttribute('lang', lang);
    const fees = await page.locator('#taxas .fee-val').allTextContents();
    expect(fees).toEqual(['$300', '$400', '$550', '$650', '$750', '$900']);
    const above = await page.locator('#taxas .fee-above').innerText();
    expect(above).toMatch(/\$900/);
    expect(above).toMatch(/\$2[.,]500/);
    expect(above).toContain('+$50 / $2,500');
    if (shots) await page.locator('#taxas .fees-inner').screenshot({ path: path.join(shots, `taxas-${lang}.png`) });
  }
  if (shots) await page.locator('#real-purchase').screenshot({ path: path.join(shots, 'compras-desktop.png') });
});

test('site: cartão estático do X3 igual ao renderizado e 390 px sem rolagem lateral', async ({ page }) => {
  await isolate(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const read = () => page.locator('#purchaseCards .rpx').first().evaluate((card) => ({
    title: card.querySelector('.rpx-title').textContent, price: card.querySelector('.rpx-price').textContent,
    ref: card.querySelector('.rpx-ref').textContent, less: card.querySelector('.rpx-less').textContent, pct: card.querySelector('.rpx-less-sub').textContent,
    rows: [...card.querySelectorAll('.rpx-row')].map((row) => [...row.children].map((cell) => cell.textContent))
  }));
  // Fallback: the purchase JSON never arrives, so the static card stays.
  await page.route('**/data/compras.json*', (route) => route.abort());
  await page.goto(base + '/index.html');
  const fallback = await read();
  await page.unroute('**/data/compras.json*');
  await page.goto(base + '/index.html');
  await expect(page.locator('#purchaseCards .rpx')).toHaveCount(4);
  const rendered = await page.locator('#purchaseCards .rpx').evaluateAll((list) => list.map((card) => ({
    title: card.querySelector('.rpx-title').textContent, price: card.querySelector('.rpx-price').textContent,
    ref: card.querySelector('.rpx-ref').textContent, less: card.querySelector('.rpx-less').textContent, pct: card.querySelector('.rpx-less-sub').textContent,
    rows: [...card.querySelectorAll('.rpx-row')].map((row) => [...row.children].map((cell) => cell.textContent))
  })).find((card) => card.title === '2021 BMW X3'));
  expect(fallback).toEqual(rendered);
  expect(fallback.rows).toEqual([['Auction purchase', '$17,900'], ['Auction fee', '$650'], ['Purchase & title', '$644'], ['Service fee', '$900'], ['Total paid', '$20,094']]);
  expect([fallback.price, fallback.ref, fallback.less, fallback.pct]).toEqual(['$20,094', '$25,800', '$5,706 LESS', '22.12% BELOW REFERENCE']);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const above = page.locator('#taxas .fee-above');
  await above.scrollIntoViewIfNeeded();
  const box = await above.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  if (shots) {
    await page.locator('#taxas .fees-inner').screenshot({ path: path.join(shots, 'taxas-390.png') });
    await page.locator('#real-purchase').screenshot({ path: path.join(shots, 'compras-390.png') });
  }
});

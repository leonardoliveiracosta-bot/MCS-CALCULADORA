'use strict';

// Find One For Me in the browser, desktop and 390 px: field order, the Year to filter, errors next
// to the field, WhatsApp and SMS blocked while the form is invalid, and the "busca" message in the
// three languages read from the link (the links are never clicked while valid). Everything outside
// the local server is aborted, so nothing reaches calc_runs, WhatsApp or SMS.
const { test, expect } = require('@playwright/test');
const path = require('node:path');

const executablePath = process.env.CHROMIUM_PATH || undefined;
const base = 'http://127.0.0.1:4173';
const shots = process.env.FIND_SHOTS || '';
test.use({ launchOptions: executablePath ? { executablePath } : {} });

async function openFind(page, width) {
  const external = [];
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    external.push(url);
    return route.abort();
  });
  await page.setViewportSize({ width, height: 900 });
  await page.goto(base + '/msc-calculadora.html');
  await page.locator('[data-start="find"]').click();
  await expect(page.locator('#path-b')).toBeVisible();
  return external;
}

const top = (page, selector) => page.locator(selector).first().evaluate((node) => node.getBoundingClientRect().top + window.scrollY);
const yearToOptions = (page) => page.locator('#find-year-to option').evaluateAll((list) => list.map((option) => option.value).filter(Boolean).map(Number));
const blocked = (page) => page.locator('#find-wa, #find-sms').evaluateAll((list) => list.map((link) => [link.getAttribute('aria-disabled'), link.getAttribute('href'), link.classList.contains('is-disabled')]));
const errorOn = (page, id) => page.locator('#find-err-' + id).evaluate((node) => node.classList.contains('on'));

async function fillValid(page) {
  await page.selectOption('#find-marca', 'BMW');
  await page.selectOption('#find-modelo', 'X5');
  await page.fill('#find-trim', 'M Sport');
  await page.selectOption('#find-year-from', '2020');
  await page.selectOption('#find-year-to', '2025');
  await page.fill('#find-miles-from', '1000');
  await page.fill('#find-miles-to', '10000');
  await page.fill('#find-zip', '33101');
  await page.fill('#find-nome', 'Teste Find');
  await page.check('input[name="find-prazo"][value="30d"]');
  await page.check('input[name="find-exp"][value="1st"]');
}

for (const width of [1280, 390]) {
  test(`formato ${width}px: ordem, largura dos cartões e nenhum campo de valor`, async ({ page }) => {
    await openFind(page, width);
    const order = ['#find-marca', '#find-trim', '#find-year-from', '#find-miles-from', '#find-zip', '#find-nome', 'input[name="find-prazo"]', 'input[name="find-exp"]', '#find-wa'];
    await page.selectOption('#find-marca', 'BMW');
    const positions = [];
    for (const selector of order) positions.push(await top(page, selector));
    expect(positions).toEqual(positions.slice().sort((a, b) => a - b));
    expect(await top(page, '#find-modelo')).toBeGreaterThan(await top(page, '#find-marca'));
    expect(await top(page, '#find-modelo')).toBeLessThan(await top(page, '#find-trim'));
    // Year to sits next to Year from and Miles to next to Miles from on desktop and on the phone.
    expect(Math.abs(await top(page, '#find-year-to') - await top(page, '#find-year-from'))).toBeLessThan(2);
    expect(Math.abs(await top(page, '#find-miles-to') - await top(page, '#find-miles-from'))).toBeLessThan(2);
    const ids = await page.locator('#path-b input, #path-b select').evaluateAll((list) => list.map((node) => node.id || node.name));
    for (const id of ids) expect(id).not.toMatch(/lance|budget|price|preco|bid/i);
    const findCards = await page.locator('#find-form > .card').evaluateAll((list) => list.map((card) => Math.round(card.getBoundingClientRect().width)));
    expect(findCards.length).toBe(2);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (shots) await page.locator('#path-b').screenshot({ path: path.join(shots, `find-vazio-${width}.png`) });
    // Same card width as Calculate My Cost.
    await page.locator('#path-b [data-back-choice]').click();
    await page.locator('[data-start="calculate"]').click();
    if (await page.locator('#modal-ok').isVisible()) await page.locator('#modal-ok').click();
    const calcCards = await page.locator('#form > .card').evaluateAll((list) => list.map((card) => Math.round(card.getBoundingClientRect().width)));
    expect(new Set([...findCards, ...calcCards]).size).toBe(1);
  });
}

test('validação: Year to filtrado, erros ao lado do campo e WhatsApp e SMS bloqueados de verdade', async ({ page, context }) => {
  const external = await openFind(page, 390);
  const opened = [];
  context.on('page', (popup) => opened.push(popup.url()));
  const nextYear = new Date().getFullYear() + 1;
  expect(await blocked(page)).toEqual([['true', '#', true], ['true', '#', true]]);

  // Click while invalid: nothing opens, the errors appear, the page stays.
  await page.locator('#find-wa').click({ force: true });
  await page.locator('#find-sms').click({ force: true });
  expect(page.url()).toBe(base + '/msc-calculadora.html');
  for (const id of ['marca', 'year-from', 'year-to', 'miles-from', 'miles-to', 'zip', 'prazo', 'exp']) expect(await errorOn(page, id), id).toBe(true);

  // Year to shows only valid years, right after Year from changes.
  expect((await yearToOptions(page))[0]).toBe(nextYear);
  await page.selectOption('#find-year-from', '2020');
  const options = await yearToOptions(page);
  expect(Math.min(...options)).toBe(2020);
  expect(Math.max(...options)).toBe(nextYear);
  expect(await errorOn(page, 'year-from')).toBe(false);
  await page.selectOption('#find-year-to', '2022');
  expect(await errorOn(page, 'year-to')).toBe(false);
  // A new Year from that invalidates Year to clears it.
  await page.selectOption('#find-year-from', '2023');
  expect(await page.inputValue('#find-year-to')).toBe('');
  expect(Math.min(...await yearToOptions(page))).toBe(2023);
  // A Year from that keeps Year to valid keeps it.
  await page.selectOption('#find-year-to', '2024');
  await page.selectOption('#find-year-from', '2021');
  expect(await page.inputValue('#find-year-to')).toBe('2024');

  // Mileage: inverted range is an error next to Miles to, fixed range removes it.
  await page.fill('#find-miles-from', '10000');
  await page.fill('#find-miles-to', '1000');
  expect(await page.inputValue('#find-miles-from')).toBe('10,000');
  expect(await errorOn(page, 'miles-to')).toBe(true);
  await expect(page.locator('#find-err-miles-to')).toBeVisible();
  await page.fill('#find-miles-to', '10000');
  expect(await errorOn(page, 'miles-to')).toBe(false);
  await page.fill('#find-miles-from', '0');
  expect(await errorOn(page, 'miles-from')).toBe(true);

  await fillValid(page);
  for (const id of ['marca', 'modelo', 'year-from', 'year-to', 'miles-from', 'miles-to', 'zip', 'prazo', 'exp']) expect(await errorOn(page, id), id).toBe(false);
  const [wa, sms] = await blocked(page);
  expect(wa[0]).toBeNull();
  expect(wa[1]).toMatch(/^https:\/\/wa\.me\/\d*\?text=/);
  expect(sms[1]).toMatch(/^sms:/);

  // Breaking the form again blocks both buttons again, and a click still opens nothing.
  await page.fill('#find-miles-to', '500');
  expect(await blocked(page)).toEqual([['true', '#', true], ['true', '#', true]]);
  await page.locator('#find-wa').click({ force: true });
  await page.locator('#find-sms').click({ force: true });
  expect(await errorOn(page, 'miles-to')).toBe(true);
  expect(page.url()).toBe(base + '/msc-calculadora.html');
  expect(opened).toEqual([]);
  expect(external.filter((url) => /wa\.me|whatsapp|^sms:|calc_runs|supabase/i.test(url))).toEqual([]);
});

test('mensagens: "busca" nos três idiomas com Ref, veículo, anos, milhagem, ZIP, prazo e experiência (sem clicar)', async ({ page }) => {
  await openFind(page, 1280);
  await fillValid(page);
  const expected = {
    en: ['Hello! I just sent a vehicle search request through My Car Scout', "I'd like to discuss this vehicle search", 'Year range: 2020-2025', 'Mileage range: 1,000-10,000'],
    pt: ['Olá! Acabei de enviar uma solicitação de busca pela My Car Scout', 'Quero conversar sobre esta busca', 'Faixa de anos: 2020-2025', 'Faixa de milhas: 1,000-10,000'],
    es: ['Hola, acabo de enviar una solicitud de búsqueda a My Car Scout', 'Quiero hablar sobre esta búsqueda', 'Rango de años: 2020-2025', 'Rango de millas: 1,000-10,000']
  };
  for (const [lang, lines] of Object.entries(expected)) {
    await page.locator(`#path-b [data-lang="${lang}"]`).click();
    const href = await page.locator('#find-wa').getAttribute('href');
    const message = decodeURIComponent(href.split('?text=')[1]);
    for (const line of lines) expect(message, lang).toContain(line);
    expect(message).toMatch(/BMW X5/);
    expect(message).toMatch(/M Sport/);
    expect(message).toMatch(/33101/);
    expect(message).toMatch(/Ref: [A-HJ-NP-Z2-9]{5}/);
    expect(message).not.toMatch(/simula/i);
    expect(message).not.toMatch(/\$/);
    const sms = decodeURIComponent((await page.locator('#find-sms').getAttribute('href')).split('body=')[1]);
    expect(sms).toBe(message);
    if (shots) await page.locator('#path-b').screenshot({ path: path.join(shots, `find-valido-${lang}-1280.png`) });
  }
  if (shots) {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.locator('#path-b [data-lang="en"]').click();
    await page.locator('#path-b').screenshot({ path: path.join(shots, 'find-valido-en-390.png') });
    await page.fill('#find-miles-to', '500');
    await page.locator('#find-miles-to').blur();
    await page.locator('#find-form > .card').first().screenshot({ path: path.join(shots, 'find-erro-milhas-390.png') });
  }
});

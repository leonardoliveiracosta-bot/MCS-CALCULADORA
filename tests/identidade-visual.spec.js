'use strict';

// Identidade visual do painel no navegador, com dados fictícios e handlers reais sobre o banco
// simulado (tests/fixtures/painel-visual.js). Mede o que está na tela:
//   contraste de texto >= 4,5:1, borda de campo >= 3:1, alvos >= 44 x 44 px em 390 px,
//   nenhuma rolagem horizontal em 390 a 1920 px e menus dentro da tela.
// Capturas em 390 e 1280 px quando VISUAL_SHOTS aponta para uma pasta.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/identidade-visual.spec.js
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { createPanel } = require('./fixtures/painel-visual');
const { openAllOptions } = require('./fixtures/buscas-simulado');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const SHOTS = process.env.VISUAL_SHOTS || '';
test.setTimeout(240000);

let panel;
test.beforeAll(async () => { panel = await createPanel(); });
test.afterAll(async () => { if (panel) await panel.close(); });

const VIEWS = ['today', 'entry', 'clients', 'searches'];

async function open(page, width, height = 900) {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await panel.open(page, base, { width, height });
  await expect(page.locator('#today-list .today-card').first()).toBeVisible({ timeout: 30000 });
  return errors;
}

async function show(page, view) {
  await page.locator(`[data-view="${view}"]`).click();
  if (view === 'entry') {
    // ENTRADA has finished loading once the WhatsApp signal answered (the "pedidos sem conversa"
    // section is gone: an order with no message is never listed).
    await expect(page.locator('#entry-panel')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#whatsapp-signal')).not.toHaveText('Verificando sinal…', { timeout: 30000 });
  }
  if (view === 'clients') await expect(page.locator('#clients-list .client-card').first()).toBeVisible({ timeout: 30000 });
  if (view === 'searches') {
    await expect(page.locator('#buscas-valor .manheim-lead').first()).toBeVisible({ timeout: 30000 });
    // The options of each demand are opened, as the operator would, so they are measured too.
    await openAllOptions(page);
  }
  await page.waitForTimeout(400);
}

async function openRecord(page) {
  await show(page, 'clients');
  await page.locator('#clients-list').getByText('Mariana Costa', { exact: true }).first().click();
  await expect(page.locator('#record-detail.lead-detail')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('#lead-conversation')).toBeAttached({ timeout: 30000 });
  await page.waitForTimeout(400);
}

async function openLogin(browser, width, height = 900) {
  const page = await browser.newPage();
  await panel.open(page, base, { width, height, login: true });
  await expect(page.locator('#login-view')).toBeVisible({ timeout: 30000 });
  return page;
}

// ------------------------------------------------------------------ medições na página
const measure = {
  // Every visible text element: its color against the real background behind it.
  contrast: () => {
    const parse = (value) => {
      const m = String(value).match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const BLACK = { r: 0, g: 0, b: 0, a: 1 };
    const backgroundOf = (element) => {
      const layers = [];
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const style = getComputedStyle(node);
        // A photo behind the text: assume the worst case (black) for dark text.
        if (style.backgroundImage && style.backgroundImage !== 'none' && !/gradient/.test(style.backgroundImage) && node !== document.documentElement) { layers.push(BLACK); break; }
        const color = parse(style.backgroundColor);
        if (color && color.a > 0) { layers.push(color); if (color.a >= 1) break; }
      }
      let result = parse(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
      if (result.a < 1) result = over(result, { r: 255, g: 255, b: 255, a: 1 });
      for (let i = layers.length - 1; i >= 0; i -= 1) result = over(layers[i], result);
      return result;
    };
    const visible = (element) => {
      if (element.closest('details:not([open]) > :not(summary)')) return false;
      const rect = element.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return false;
      for (let node = element; node; node = node.parentElement) if (getComputedStyle(node).display === 'none' || Number(getComputedStyle(node).opacity) === 0) return false;
      return true;
    };
    const failures = [];
    for (const element of document.querySelectorAll('body *')) {
      if (['SCRIPT', 'STYLE', 'OPTION', 'SVG', 'PATH', 'IMG', 'PICTURE'].includes(element.tagName.toUpperCase())) continue;
      const text = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent.trim()).join('');
      if (!/[A-Za-z0-9À-ÿ]/.test(text)) continue;
      if (element.closest('button:disabled, [disabled], .visually-hidden, .visual-page-label, .sr-status')) continue;
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      const fg = parse(style.color);
      let opacity = 1;
      for (let node = element; node; node = node.parentElement) opacity *= Number(getComputedStyle(node).opacity);
      const bg = backgroundOf(element);
      const color = over({ ...fg, a: fg.a * opacity }, bg);
      const value = ratio(color, bg);
      if (value < 4.5) failures.push(`${value.toFixed(2)} ${element.tagName.toLowerCase()}.${String(element.className).trim().replace(/\s+/g, '.')} "${text.slice(0, 40)}" ${style.color} sobre rgb(${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)})`);
    }
    return failures;
  },
  // Field borders against the surface around the field.
  fieldBorders: () => {
    const parse = (value) => { const m = String(value).match(/rgba?\(([^)]+)\)/); const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const surface = (element) => { for (let node = element.parentElement; node; node = node.parentElement) { const c = parse(getComputedStyle(node).backgroundColor); if (c.a >= 0.9) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const failures = [];
    for (const field of document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="hidden"]), select, textarea')) {
      const rect = field.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || field.closest('details:not([open]) > :not(summary)')) continue;
      const style = getComputedStyle(field);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
      const value = ratio(parse(style.borderTopColor), surface(field));
      if (value < 3) failures.push(`${value.toFixed(2)} ${field.tagName.toLowerCase()}#${field.id || '?'} ${style.borderTopColor}`);
    }
    return failures;
  },
  // Buttons, links outside sentences, summary, select and checkbox/radio labels: 44 x 44 px.
  touch: () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      if (element.closest('details:not([open]) > :not(summary)')) return false;
      for (let node = element; node; node = node.parentElement) { const style = getComputedStyle(node); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false; }
      if (element.closest('.visually-hidden')) return false;
      return true;
    };
    const inSentence = (link) => {
      const parent = link.parentElement;
      return [...parent.childNodes].some((node) => node !== link && node.nodeType === 3 && /[A-Za-zÀ-ÿ0-9]/.test(node.textContent));
    };
    const targets = [
      ...document.querySelectorAll('button, summary, select'),
      ...[...document.querySelectorAll('a[href]')].filter((link) => !inSentence(link)),
      ...[...document.querySelectorAll('label')].filter((label) => label.querySelector('input[type="checkbox"], input[type="radio"]'))
    ];
    return targets.filter(visible).map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => Math.round(rect.width) < 44 || Math.round(rect.height) < 44)
      .map(({ element, rect }) => `${Math.round(rect.width)}x${Math.round(rect.height)} ${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}.${String(element.className).trim().replace(/\s+/g, '.')} "${element.textContent.trim().slice(0, 30)}"`);
  },
  // html and body clip horizontal overflow, so scrollWidth alone can't fail: look for visible
  // elements whose box leaves the screen, unless a scroll container of their own holds them.
  overflow: () => {
    const out = [];
    const held = (element) => { for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) { const x = getComputedStyle(node).overflowX; if (['auto', 'scroll', 'hidden', 'clip'].includes(x)) return true; } return false; };
    for (const element of document.querySelectorAll('body *')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || element.closest('.visually-hidden, .visual-page-label, details:not([open]) > :not(summary)')) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || style.position === 'fixed' && rect.width <= window.innerWidth) continue;
      if ((rect.right > window.innerWidth + 1 || rect.left < -1) && !held(element)) out.push(`${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}.${String(element.className).trim().replace(/\s+/g, '.')} ${Math.round(rect.left)}..${Math.round(rect.right)}`);
    }
    return out.slice(0, 8);
  }
};

// ------------------------------------------------------------------ testes
test('contraste: texto de todas as abas, da ficha e do login com pelo menos 4,5:1 e bordas de campo com 3:1', async ({ page, browser }) => {
  const failures = [];
  for (const width of [390, 1280]) {
    const errors = await open(page, width);
    for (const view of VIEWS) {
      await show(page, view);
      failures.push(...(await page.evaluate(measure.contrast)).map((line) => `${width} ${view}: ${line}`));
      failures.push(...(await page.evaluate(measure.fieldBorders)).map((line) => `${width} ${view} borda: ${line}`));
    }
    await openRecord(page);
    failures.push(...(await page.evaluate(measure.contrast)).map((line) => `${width} ficha: ${line}`));
    failures.push(...(await page.evaluate(measure.fieldBorders)).map((line) => `${width} ficha borda: ${line}`));
    expect(errors).toEqual([]);
  }
  const login = await openLogin(browser, 390);
  failures.push(...(await login.evaluate(measure.contrast)).map((line) => `login: ${line}`));
  failures.push(...(await login.evaluate(measure.fieldBorders)).map((line) => `login borda: ${line}`));
  await login.close();
  // Error states the fixture does not render by itself: status errors and scoped action errors.
  const states = await page.evaluate(() => {
    const status = document.getElementById('import-status'); status.classList.add('error'); status.textContent = 'Falha na importação de teste';
    const feedback = document.createElement('p'); feedback.className = 'status action-feedback error'; feedback.textContent = 'Não consegui salvar, tente de novo'; document.getElementById('entry-needs-empty').after(feedback);
    return [status, feedback].map((node) => getComputedStyle(node).color);
  });
  expect(states).toEqual(['rgb(185, 28, 28)', 'rgb(185, 28, 28)']);
  await show(page, 'entry');
  failures.push(...(await page.evaluate(measure.contrast)).filter((line) => /Falha na importação de teste|Não consegui salvar, tente/.test(line)).map((line) => `erro: ${line}`));
  expect(panel.failures, 'nenhum handler falhou no banco simulado').toEqual([]);
  console.log('CONTRASTE', failures.length ? failures.join('\n') : 'nenhuma falha');
  expect(failures).toEqual([]);
});

test('toque: botões, links fora de frase, summary, select e rótulos de checkbox ou radio com 44 x 44 px em 390 px', async ({ page, browser }) => {
  const small = [];
  await open(page, 390, 844);
  for (const view of VIEWS) {
    await show(page, view);
    small.push(...(await page.evaluate(measure.touch)).map((line) => `${view}: ${line}`));
  }
  await openRecord(page);
  small.push(...(await page.evaluate(measure.touch)).map((line) => `ficha: ${line}`));
  const login = await openLogin(browser, 390, 844);
  small.push(...(await login.evaluate(measure.touch)).map((line) => `login: ${line}`));
  await login.close();
  console.log('TOQUE', small.length ? small.join('\n') : 'nenhum alvo abaixo de 44 x 44');
  expect(small).toEqual([]);
});

test('responsivo: nenhuma rolagem horizontal de 390 a 1920 px, em todas as abas, na ficha e no login', async ({ page, browser }) => {
  const wide = [];
  for (const width of [390, 430, 1024, 1280, 1440, 1920]) {
    await open(page, width);
    for (const view of VIEWS) { await show(page, view); for (const line of await page.evaluate(measure.overflow)) wide.push(`${width} ${view}: ${line}`); }
    await openRecord(page);
    for (const line of await page.evaluate(measure.overflow)) wide.push(`${width} ficha: ${line}`);
    const loginPage = await openLogin(browser, width);
    for (const line of await loginPage.evaluate(measure.overflow)) wide.push(`${width} login: ${line}`);
    await loginPage.close();
  }
  expect(wide).toEqual([]);
});

test('menus dentro da tela em 390 px: menu da mensagem, calor, desligar com motivo e motivos de descarte', async ({ page }) => {
  await open(page, 390, 844);
  const inside = async (locator, label) => {
    const box = await locator.boundingBox();
    expect(box, label).toBeTruthy();
    expect(box.x, label).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, label).toBeLessThanOrEqual(390);
  };
  // Temperature explanation on HOJE and discard reasons.
  const card = page.locator('#today-list .today-card').first();
  await card.locator('.temperature-details summary').click();
  await inside(card.locator('.temperature-explanation'), 'calor');
  await card.locator('.temperature-details summary').click();
  await card.getByRole('button', { name: 'Descartar' }).click();
  await inside(card.locator('.discard-reasons'), 'motivos de descarte');
  // Journey switch reasons on CLIENTES.
  await show(page, 'clients');
  const client = page.locator('#clients-list .client-card').first();
  const reasons = client.locator('details.switch-reasons').first();
  await reasons.locator('summary').click();
  await inside(reasons.locator('.inline-actions'), 'desligar com motivo');
  // Message menu in the record.
  await openRecord(page);
  const menu = page.locator('#record-detail details.message-menu').first();
  await menu.locator('summary').scrollIntoViewIfNeeded();
  await menu.locator('summary').click();
  await inside(menu.locator('.message-menu-panel'), 'menu da mensagem');
  // The open menu is not hidden behind the fixed tab bar.
  const [panelBox, navBox] = await Promise.all([menu.locator('.message-menu-panel').boundingBox(), page.locator('nav[aria-label="Seções do painel"]').boundingBox()]);
  if (panelBox.y + panelBox.height > navBox.y) { await page.evaluate((y) => window.scrollBy(0, y), panelBox.y + panelBox.height - navBox.y + 16); }
  const [after, nav] = await Promise.all([menu.locator('.message-menu-panel').boundingBox(), page.locator('nav[aria-label="Seções do painel"]').boundingBox()]);
  expect(after.y + after.height, 'menu acima da barra de abas').toBeLessThanOrEqual(nav.y);
  expect(await page.evaluate(measure.overflow)).toEqual([]);
});

test('capturas: login, HOJE, ENTRADA, CLIENTES com prontuário e BUSCAS em 390 e 1280 px', async ({ page, browser }) => {
  test.skip(!SHOTS, 'defina VISUAL_SHOTS para gerar as capturas');
  for (const width of [390, 1280]) {
    const height = width === 390 ? 844 : 900;
    const login = await openLogin(browser, width, height);
    await login.screenshot({ path: path.join(SHOTS, `login-${width}.png`) });
    await login.close();
    await open(page, width, height);
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, `hoje-${width}.png`), fullPage: width !== 390 });
    if (width === 390) { await page.locator('#today-list .today-card').first().scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -60)); await page.screenshot({ path: path.join(SHOTS, 'hoje-cartao-390.png') }); }
    await show(page, 'entry');
    await page.screenshot({ path: path.join(SHOTS, `entrada-${width}.png`), fullPage: width !== 390 });
    await openRecord(page);
    await page.screenshot({ path: path.join(SHOTS, `clientes-prontuario-${width}.png`), fullPage: width !== 390 });
    if (width === 390) { await page.locator('#lead-conversation').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'clientes-conversa-390.png') }); }
    await show(page, 'searches');
    await page.screenshot({ path: path.join(SHOTS, `buscas-${width}.png`), fullPage: width !== 390 });
    if (width === 390) {
      await page.locator('#buscas-valor').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'buscas-valor-390.png') });
      await page.locator('#buscas-carro').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(SHOTS, 'buscas-carro-390.png') });
    }
  }
});

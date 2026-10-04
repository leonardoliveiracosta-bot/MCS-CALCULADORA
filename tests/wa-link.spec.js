'use strict';
// Chromium de verdade: o link do painel abre o WhatsApp Web (simulado) na aba "mcs-whatsapp"; o
// segundo clique reusa a mesma aba; as partes 2 e 3 copiam e não navegam; aba fechada abre de novo.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome PANEL_VISUAL_LOCAL=1 npx playwright test tests/wa-link.spec.js
const { test, expect } = require('@playwright/test');
const base = 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
const CHROMEBOOK = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function setup(browser, userAgent = CHROMEBOOK) {
  const context = await browser.newContext({ userAgent, permissions: ['clipboard-read', 'clipboard-write'] });
  const loads = [];
  // WhatsApp Web stand-in: every navigation of the tab is recorded (a real one would reload WhatsApp).
  await context.route('https://web.whatsapp.com/**', (route) => { loads.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>WhatsApp</title><p>WhatsApp Web</p>' }); });
  await context.route('https://wa.me/**', (route) => { loads.push(route.request().url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>wa.me</title>' }); });
  const page = await context.newPage();
  await page.goto(base + '/tests/fixtures/wa-link.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  return { context, page, loads };
}

test('computador: o link do servidor abre o WhatsApp Web na aba "mcs-whatsapp" e o segundo clique reusa a mesma aba', async ({ browser }) => {
  const { context, page, loads } = await setup(browser);
  const opened = context.waitForEvent('page');
  await page.locator('#server-link').click();
  const tab = await opened;
  await expect.poll(() => loads.length).toBe(1);
  expect(loads[0]).toMatch(/^https:\/\/web\.whatsapp\.com\/send\?phone=13055550123&text=/);
  expect(new URL(loads[0]).searchParams.get('text')).toBe('Olá João & # 1\n🚗');
  expect(await tab.evaluate(() => window.name)).toBe('mcs-whatsapp');
  await page.locator('#server-link').click();
  await expect.poll(() => loads.length).toBe(2);
  expect(context.pages().length, 'nenhuma aba nova no segundo clique').toBe(2);
  await expect(page.locator('.wa-tab-notice')).toContainText("Use a aba do WhatsApp que o painel abre e feche outras abas do WhatsApp Web, para não aparecer 'Usar nesta janela'.");
  await page.locator('.wa-tab-notice button', { hasText: 'Entendi' }).click();
  await expect(page.locator('.wa-tab-notice')).toHaveCount(0);
  await page.reload();
  await page.locator('#server-link').click();
  await expect.poll(() => loads.length).toBe(3);
  await expect(page.locator('.wa-tab-notice')).toHaveCount(0);
  expect(context.pages().length, 'depois de recarregar o painel, a aba nomeada ainda é reusada').toBe(2);
  await context.close();
});

test('partes: a 1 abre a aba, a 2 e a 3 copiam sem navegar; aba fechada abre de novo', async ({ browser }) => {
  const { context, page, loads } = await setup(browser);
  const opened = context.waitForEvent('page');
  await page.locator('#p1').click();
  const tab = await opened;
  await expect.poll(() => loads.length).toBe(1);
  await page.locator('#p2').click();
  await expect(page.locator('#status')).toHaveText('Parte 2 copiada: vá para a aba do WhatsApp, cole (Ctrl+V) e envie');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Parte dois & mais');
  await page.locator('#p3').click();
  await expect(page.locator('#status')).toHaveText('Parte 3 copiada: vá para a aba do WhatsApp, cole (Ctrl+V) e envie');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('Parte três 🚗');
  expect(loads.length, 'o WhatsApp não recarrega nas partes 2 e 3').toBe(1);
  await tab.close();
  const reopened = context.waitForEvent('page');
  await page.locator('#p2').click();
  await reopened;
  await expect.poll(() => loads.length).toBe(2);
  expect(new URL(loads[1]).searchParams.get('text')).toBe('Parte dois & mais');
  await context.close();
});

test('celular: continua wa.me, sem aba nomeada', async ({ browser }) => {
  const { context, page, loads } = await setup(browser, 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36');
  await page.locator('#server-link').evaluate((node) => node.removeAttribute('target'));
  await page.locator('#server-link').click();
  await expect.poll(() => loads.length).toBe(1);
  expect(loads[0]).toMatch(/^https:\/\/wa\.me\/13055550123\?text=/);
  await context.close();
});

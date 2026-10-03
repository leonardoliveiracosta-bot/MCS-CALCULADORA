'use strict';
// Enviar com as duas opções no computador: "No celular" (QR code com o texto atual, "Enviar para meu celular" quando há
// avisos ativos) e "No WhatsApp Web" (o link wa.me de sempre).
const { test, expect } = require('@playwright/test');
const base = 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

test('computador: No celular abre o QR do link atual e envia por aviso; No WhatsApp Web mantém o link wa.me', async ({ page }) => {
  await page.goto(base + '/tests/fixtures/whatsapp-envio.html');
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  await expect(page.locator('.v1-send-actions > *')).toHaveText(['No celular', 'No WhatsApp Web']);
  await expect(page.locator('a.wa-web')).toHaveAttribute('href', /^https:\/\/wa\.me\/15513009180\?text=/);
  await page.evaluate(() => { document.querySelector('a').href = 'https://wa.me/15513009180?text=Texto%20editado'; });
  await page.locator('.wa-phone').click();
  const dialog = page.locator('.wa-handoff-dialog');
  await expect(dialog).toContainText('Aponte a câmera do celular');
  await expect(dialog.locator('.wa-handoff-qr svg')).toHaveCount(1);
  await dialog.locator('.wa-handoff-push').click();
  await expect.poll(() => page.evaluate(() => window.POSTS.map((post) => post.url))).toEqual(['https://wa.me/15513009180?text=Texto%20editado']);
});

test('celular: o link direto continua igual, sem os dois botões', async ({ browser }) => {
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto(base + '/tests/fixtures/whatsapp-envio.html');
  await expect(page.locator('.v1-send-actions > *')).toHaveText(['Abrir no WhatsApp do celular']);
  await context.close();
});

'use strict';
// Tela "O que o cliente informou, campo a campo": só título, subtítulo e a tabela de 9 campos.
// Os blocos "Próxima ação · sugestão do painel" (com o resumo de campos) e o de 4 colunas não existem na página renderizada.
const { test, expect } = require('@playwright/test');
const base = 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

test('campo a campo: título, subtítulo e 9 campos; sem Próxima ação e sem o bloco de 4 colunas, na ficha e no cartão', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (failure) => errors.push(failure.message));
  await page.goto(base + '/tests/fixtures/campo-a-campo.html', { waitUntil: 'load' });
  await expect(page.locator('body')).toHaveAttribute('data-ready', '1');
  for (const scope of ['#ficha', '#cartao details.context-more']) {
    const view = page.locator(scope).first();
    await expect(view.locator('.context-subtitle')).toHaveText('O que o cliente informou, campo a campo');
    await expect(view.locator('.context-subtitle-note')).toHaveText('Campo a campo, com a situação de cada valor');
    await expect(view.locator('.context-table thead th')).toHaveText(['Campo', 'Valor usado', 'Situação']);
    await expect(view.locator('.context-table tbody th')).toHaveText(['Tipo de busca', 'Carro', 'Anos', 'Milhagem', 'Lance máximo', 'Pagamento', 'Prazo', 'Localização', 'Placa']);
    await expect(view.locator('.context-table tbody tr').nth(1).locator('td').first()).toHaveText('BMW M4 · BMW 328i');
  }
  const page_ = page.locator('body');
  await expect(page.locator('.context-next')).toHaveCount(0);
  await expect(page.locator('.context-links')).toHaveCount(0);
  await expect(page.locator('.context-fields')).toHaveCount(0);
  for (const text of ['Próxima ação', 'sugestão do painel', 'Pedidos da calculadora', 'Pedidos lidos da conversa', 'Busca e carros', 'Leitura da IA por pedido', 'De onde veio', 'Teto total', 'Uso do carro']) await expect(page_).not.toContainText(text);
  expect(errors).toEqual([]);
});

'use strict';
// TODOS deixou de ser aba: a lista de clientes fica no bloco recolhido "Mais" de ATENDER AGORA.
// Abre ATENDER AGORA e o bloco (se ainda fechado); o bloco carrega a lista ao abrir.
async function openClientsList(page, options = {}) {
  await page.locator('[data-view="today"]').click(options);
  const open = await page.locator('#today-more').evaluate((node) => node.open);
  if (!open) await page.locator('#today-more > summary').click(options);
}
module.exports = { openClientsList };

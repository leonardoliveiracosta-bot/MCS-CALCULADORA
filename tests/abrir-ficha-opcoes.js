'use strict';
// ENVIAR OPÇÕES virou fila (#218); os carros, a seleção, o trim, a conferência e a V1 de cada cliente ficam
// na tela "Opções do cliente" (a ficha só mostra o resumo e "Ver opções"). Abre o cartão da fila (pelo nome e
// pelo modo) e devolve essa tela, no pedido do modo pedido.
const { expect } = require('@playwright/test');

// Minimal ficha for the specs with a simulated /api/**: the options part reads the queue data itself.
function fichaLead(url) {
  const id = url.searchParams.get('id'), ref = url.searchParams.get('ref');
  return {
    ref: ref || '', hasCalculatorRef: Boolean(ref), order: null, track: null, notes: [], events: [], promises: [], checklist: [], wishes: [], typical: [], offers: [], fits: [],
    zip: '', state: null, city: null, timezone: 'America/New_York', goodHour: true, payment: 'cash', paymentKnown: null, deadlineKnown: null, zipKnown: false, plate: 'transf', florida: true,
    maxBidCents: null, totalCeilingCents: null, bid: null, costs: null, score: null, calculatorNews: [], ai: { reading: null, suggestion: null }, aiHelp: [],
    record: id ? { id, stage: 'RESPONDIDO', contact: { display_name: 'Cliente' }, phones: [], attachments: [], returns: [], conversation: [], units: [] } : null
  };
}
// The client's options screen of ENVIAR OPÇÕES (where the cars, the selection, the PDF and the V1 live now; the
// ficha only shows the summary and "Ver opções"). Opened from the queue card, on the request of that mode.
async function openOptionsScreen(page, { name = null, mode = null, realLead = false } = {}) {
  // Registered last, so it answers before the spec's catch-all route (the real backend specs pass realLead).
  if (!realLead && !page.__fichaLeadRoute) {
    page.__fichaLeadRoute = true;
    await page.route('**/api/panel/lead?**', (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== 'GET' || url.searchParams.get('cityZip')) return route.fallback();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fichaLead(url)) });
    });
  }
  if (!(await page.locator('#options-queue').isVisible().catch(() => false))) await page.locator('[data-view="searches"]').click();
  let cards = page.locator('#options-queue .options-queue-card');
  if (mode) cards = cards.and(page.locator(`[data-mode~="${mode}"]`));
  if (name) cards = cards.filter({ hasText: name });
  await expect(cards.first()).toBeVisible({ timeout: 30000 });
  await cards.first().locator('.identity-name').click();
  const screen = page.locator('#options-client');
  await expect(screen.locator('.oc-bar, .offer-pending').first()).toBeVisible({ timeout: 30000 });
  // A person with both requests: the chip of the asked mode.
  if (mode && (await screen.getAttribute('data-mode')) !== mode) {
    await screen.locator('.oc-demands .oc-tab', { hasText: mode === 'VALOR' ? 'Por valor' : 'Por carro' }).click();
    await expect(screen).toHaveAttribute('data-mode', mode);
  }
  return screen;
}
// Back to the queue (the screen closes; the list behind stays as it was).
async function backToQueue(page) {
  const screen = page.locator('#options-client');
  if (await screen.isVisible()) await screen.getByRole('button', { name: '← Voltar' }).click();
  await expect(page.locator('#options-queue')).toBeVisible({ timeout: 30000 });
}
module.exports = { openOptionsScreen, backToQueue, fichaLead };

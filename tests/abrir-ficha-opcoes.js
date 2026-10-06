'use strict';
// ENVIAR OPÇÕES virou fila (#218): os grupos de carros, a seleção, o trim, a conferência e a V1 ficam
// na ficha. Abre o cartão da fila (pelo nome e pelo modo) e devolve a seção do pedido na ficha.
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
async function openOptionsFicha(page, { name = null, mode = null, realLead = false } = {}) {
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
  // One row per person (#231): tapping the row opens the ficha.
  await cards.first().locator('.identity-name').click();
  await expect(page.locator('#detail-panel .ficha-demand').first()).toBeVisible({ timeout: 30000 });
  return fichaSection(page, mode);
}
// The section of one demand in the open ficha (VALOR or CARRO).
const fichaSection = (page, mode) => mode
  ? page.locator(`#detail-panel .ficha-demand[data-demand-key$=":${mode}"]`).first()
  : page.locator('#detail-panel .ficha-demand').first();
// Back to the queue (the ficha closes; the list behind stays as it was).
async function backToQueue(page) {
  await page.goBack();
  await expect(page.locator('#options-queue')).toBeVisible({ timeout: 30000 });
}
module.exports = { openOptionsFicha, fichaSection, backToQueue, fichaLead };

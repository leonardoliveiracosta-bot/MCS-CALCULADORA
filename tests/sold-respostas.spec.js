'use strict';

// Sold, o assistente da página: cada pergunta frequente cai no assunto certo (nos três idiomas), a taxa de serviço
// é calculada pela tabela da página, a resposta vem antes do botão, e o boneco fica logo acima do WhatsApp.
// Nada sai da máquina: só a página local.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/sold-respostas.spec.js
const { test, expect } = require('@playwright/test');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });

const Q = [
 ['en','Do I need a dealer license?','license'],['en','How does it work?','how'],['en','How much is your fee?','fees'],['en','fee for $12,000','fee'],
 ['en','what is the fee on a 25k car','fee'],['en','Is the deposit refundable?','deposit'],['en','how much is the deposit','depositAmount'],['en','Can I get my money back?','refund'],
 ['en','What if I change my mind after you win?','backout'],['en',"What if you don't win the car?",'lose'],['en','Can I test drive it?','testdrive'],['en','Do you offer financing? I have bad credit','finance'],
 ['en','How much does shipping cost?','shipcost'],['en','Do you deliver to Texas?','receive'],['en','Do you buy salvage cars?','title'],['en','Will I get the Carfax?','carfax'],
 ['en','Is there a warranty?','warranty'],['en','How long does it take?','time'],['en','What about taxes and registration?','taxes'],['en','Where are you located?','where'],
 ['en','Do you speak Spanish?','language'],['en','Can I talk to a person?','contact'],['en','Is this a scam?','trust'],['en','How much can I save?','save'],
 ['en','What are the total costs, any hidden fees?','total'],['en','Is the calculator an official quote?','calc'],['en','What does reference mean?','reference'],['en','What cars do you have available?','inventory'],['en','Do you have a Tesla in stock?','inventory'],['en','show me real examples','examples'],
 ['en','How much is a BMW?','price'],['en','How do I pay? cash?','pay'],['en','Can you find me a Tesla Model 3?','choose'],['en','who decides the max bid','decide'],
 ['en','what happens after purchase','after'],['en','What is My Car Scout?','about'],['en','I want to buy a car','start'],['en','hi','hello'],['en','thanks!','thanks'],['en','why not just go to a dealership','markup'],
 ['en','what about high mileage','mileage'],['en','are the auctions open to the public?','auction'],['en','can I inspect the car mechanically','inspection'],['en','do you bid live?','bid'],
 ['pt','Preciso de licença?','license'],['pt','Como funciona?','how'],['pt','Quanto vocês cobram?','fees'],['pt','qual a taxa para 8 mil','fee'],['pt','O depósito é reembolsável?','deposit'],
 ['pt','Quanto custa o frete?','shipcost'],['pt','Vocês financiam?','finance'],['pt','Posso fazer test drive?','testdrive'],['pt','Quanto tempo demora?','time'],['pt','Vocês compram carro batido ou salvage?','title'],
 ['pt','É golpe?','trust'],['pt','Quero falar com uma pessoa','contact'],['pt','Onde vocês ficam?','where'],['pt','Tem garantia?','warranty'],['pt','Quanto custa um Porsche Macan?','price'],
 ['pt','Como eu recebo o carro?','receive'],['pt','Vocês tem estoque?','inventory'],['pt','Quais carros vocês têm?','inventory'],['pt','E se eu desistir depois do arremate?','backout'],
 ['es','¿Necesito licencia de dealer?','license'],['es','¿Cuánto cobran?','fees'],['es','¿El depósito es reembolsable?','deposit'],['es','¿Ofrecen financiamiento?','finance'],
 ['es','¿Cuánto cuesta el envío?','shipcost'],['es','¿Puedo hacer prueba de manejo?','testdrive'],['es','¿Cuánto tiempo tarda?','time'],['es','¿Hablan español?','language'],
 ['es','¿Es confiable?','trust'],['es','¿Y los impuestos y el registro?','taxes'],['es','¿Cómo funciona?','how'],['es','¿Qué pasa si no ganan el auto?','lose'],['es','¿Qué autos tienen en inventario?','inventory'],
 ['en','what is the weather today','(none)']
];

test('perguntas frequentes caem no assunto certo nos três idiomas', async ({ page }) => {
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.MCSSold);
  const misses = await page.evaluate((list) => list.map(([lg, q, want]) => {
    document.documentElement.lang = lg;
    const r = window.MCSSold.classify(q);
    const got = r ? r.id : '(none)';
    return got === want ? null : `${lg} "${q}": ${got} (esperado ${want})`;
  }).filter(Boolean), Q);
  expect(misses).toEqual([]);
  expect(Q.length).toBeGreaterThanOrEqual(30);
});

// a resposta (sem o gancho que vem depois dela)
const reply = (page) => page.locator('.sold-msg.bot:not(.sold-hook)').last();

test('taxa de serviço pela tabela, resposta sem mandar tudo para a calculadora', async ({ page }) => {
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.MCSSold);
  await page.evaluate(() => window.MCSSold.open());
  const ask = async (text) => { await page.fill('.sold-form input', text); await page.press('.sold-form input', 'Enter'); };
  await ask('fee for $12,000');
  await expect(reply(page)).toContainText('$750');
  await ask('fee for $20,001');
  await expect(reply(page)).toContainText('$950');
  await ask('fee for $25,000');
  await expect(reply(page)).toContainText('$1,000');
  // primeiro a resposta de verdade, depois o gancho
  await ask('Do you buy salvage cars?');
  await expect(reply(page)).toContainText('clean title');
  await expect(page.locator('.sold-msg.sold-hook').last()).toContainText('What are you looking for?');
});

test('estoque: "me mostra qual antes", com gancho e os dois caminhos', async ({ page }) => {
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.MCSSold);
  await page.evaluate(() => window.MCSSold.open());
  await page.fill('.sold-form input', 'Do you have a 2020 Camry?');
  await page.press('.sold-form input', 'Enter');
  await expect(reply(page)).toContainText('Show me which car you want first');
  await expect(page.locator('.sold-msg.sold-hook').last()).toContainText('Which one is it?');
  await expect(page.locator('.sold-cta').last()).toBeVisible();
  await expect(page.locator('.sold-log a.sold-link').last()).toHaveAttribute('href', /wa\.me\/13055400742\?text=.*Camry/);
});

test('contato: botões de WhatsApp e SMS com a mensagem já escrita', async ({ page }) => {
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.MCSSold);
  await page.evaluate(() => window.MCSSold.open());
  await page.locator('.sold-chip', { hasText: 'Talk to a person' }).click();
  const links = page.locator('.sold-actions').last().locator('a');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('href', /^https:\/\/wa\.me\/13055400742\?text=Hi!/);
  await expect(links.nth(1)).toHaveAttribute('href', /^sms:\+13055400742\?&body=Hi!/);
});

test('no computador o Sold fica logo acima do WhatsApp, no mesmo eixo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + '/index.html');
  await page.waitForFunction(() => window.MCSSold);
  const box = await page.evaluate(() => {
    const r = (s) => document.querySelector(s).getBoundingClientRect();
    const sold = r('.sold-launcher'), wa = r('.wa-float');
    return { gap: wa.top - sold.bottom, axis: Math.abs((sold.left + sold.width / 2) - (wa.left + wa.width / 2)) };
  });
  expect(box.gap).toBeGreaterThan(0);
  expect(box.gap).toBeLessThan(24);
  expect(box.axis).toBeLessThan(4);
});

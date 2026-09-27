const { test, expect } = require('@playwright/test');

const preview = process.env.PANEL_PREVIEW_URL;
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

if (!preview) throw new Error('PANEL_PREVIEW_URL é obrigatório');
const previewUrl = new URL(preview);
if (previewUrl.hostname === 'www.mycarscout.net' || previewUrl.hostname === 'mycarscout.net') {
  throw new Error('O teste visual nunca pode rodar em produção');
}

const target = new URL('/painel', previewUrl);
const actionScript = new URL('/painel/action.js', previewUrl);
for (const [name, value] of previewUrl.searchParams) target.searchParams.append(name, value);
if (bypass) {
  target.searchParams.set('x-vercel-protection-bypass', bypass);
  actionScript.searchParams.set('x-vercel-protection-bypass', bypass);
}

test.beforeEach(async ({ page }) => {
  if (bypass) await page.setExtraHTTPHeaders({ 'x-vercel-protection-bypass': bypass });
});

async function showPanel(page, view = 'today') {
  await page.evaluate((activeView) => {
    document.querySelector('#login-view')?.classList.add('hidden');
    document.querySelector('#password-view')?.classList.add('hidden');
    document.querySelector('#app-view')?.classList.remove('hidden');
    for (const name of ['today', 'entry', 'pending', 'orders', 'qualification', 'searches', 'manheim', 'records']) {
      document.querySelector(`#${name}-panel`)?.classList.toggle('hidden', name !== activeView);
    }
  }, view);
  await page.evaluate(() => document.fonts?.ready);
}

for (const width of [360, 390, 430]) {
  for (const colorScheme of ['light', 'dark']) {
    for (const view of ['today', 'entry']) {
      test(`${view} sem rolagem horizontal em ${width}px / ${colorScheme}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ colorScheme });
        await page.goto(target.toString(), { waitUntil: 'networkidle' });
        await showPanel(page, view);
        const dimensions = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth
        }));
        expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.innerWidth);
      });
    }
  }
}

test('helper dá efeito em até 300 ms, bloqueia clique duplo, desfaz e reverte falha',async({page})=>{
  await page.goto(target.toString(),{waitUntil:'domcontentloaded'});
  await page.setContent('<article id="card"><button id="action">Descartar</button></article><article id="failure"><button id="fail">Tratado</button></article>');
  await page.addScriptTag({url:actionScript.toString()});
  await page.evaluate(()=>{
    window.actionPosts=0;
    window.actionStatus='TREATED';
    window.actionRelease=null;
    const card=document.querySelector('#card'),button=document.querySelector('#action');
    MCSAction.bind(button,()=>({scope:card,optimistic:()=>{card.hidden=true;window.actionStatus='DISCARDED';return'TREATED';},commit:()=>{window.actionPosts++;return new Promise((resolve)=>{window.actionRelease=resolve;});},rollback:(previous)=>{card.hidden=false;window.actionStatus=previous;},successText:'Descartado.',undo:{commit:async(_result,previous)=>{window.actionPosts++;window.actionStatus=previous;card.hidden=false;},successText:'Ação desfeita.'}}));
    const failCard=document.querySelector('#failure'),fail=document.querySelector('#fail');
    MCSAction.bind(fail,()=>({scope:failCard,optimistic:()=>{failCard.hidden=true;},commit:()=>Promise.reject(new Error('500')),rollback:()=>{failCard.hidden=false;}}));
  });
  const started=Date.now();
  await page.locator('#action').click();
  await expect(page.locator('#card')).toBeHidden({timeout:300});
  expect(Date.now()-started).toBeLessThanOrEqual(300);
  await page.evaluate(()=>document.querySelector('#action').click());
  expect(await page.evaluate(()=>window.actionPosts)).toBe(1);
  await page.evaluate(()=>window.actionRelease({saved:true}));
  await expect(page.locator('.action-feedback button')).toHaveText('Desfazer');
  await page.locator('.action-feedback button').click();
  await expect(page.locator('#card')).toBeVisible();
  expect(await page.evaluate(()=>window.actionStatus)).toBe('TREATED');
  await page.locator('#fail').click();
  await expect(page.locator('#failure')).toBeVisible();
  await expect(page.locator('#failure .action-feedback')).toHaveText('Não consegui salvar — tente de novo');
});

for (const width of [1024, 1280, 1440, 1920]) {
  test(`as 8 abas ficam inteiras e visíveis em ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(target.toString(), { waitUntil: 'networkidle' });
    await showPanel(page);
    const tabs = await page.locator('nav[aria-label="Seções do painel"] .tab').evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        visible: getComputedStyle(element).visibility !== 'hidden'
      };
    }));
    expect(tabs).toHaveLength(8);
    for (const tab of tabs) {
      expect(tab.visible).toBe(true);
      expect(tab.width).toBeGreaterThan(0);
      expect(tab.left).toBeGreaterThanOrEqual(0);
      expect(tab.right).toBeLessThanOrEqual(width);
    }
  });
}

for (const width of [360, 390, 430]) {
  test(`controles da HOJE ocupam a largura disponível em ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(target.toString(), { waitUntil: 'networkidle' });
    await showPanel(page);
    const controls = await page.locator('.today-heading .inline-actions').evaluate((element) => {
      const parent = element.parentElement.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return { parentWidth: parent.width, width: rect.width };
    });
    expect(Math.abs(controls.parentWidth - controls.width)).toBeLessThanOrEqual(1);
  });
}

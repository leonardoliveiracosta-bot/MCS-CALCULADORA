'use strict';

// Assistente do painel no navegador real (servidor do assistente simulado): abre ao lado no
// computador e de baixo para cima no iPhone sem sair da tela; responde; "N찾o funcionou" leva o
// 첬ltimo clique; nada executa sem Autorizar; com Autorizar executa pelo caminho do bot찾o normal;
// Desfazer volta; dado desatualizado n찾o executa e pede nova proposta; OpenAI fora do ar n찾o trava.
// Run: CHROMIUM_PATH=/opt/pw-browsers/chromium PANEL_VISUAL_LOCAL=1 npx playwright test tests/assistente.spec.js
const { test, expect } = require('@playwright/test');
const { fichaLead } = require('./abrir-ficha-opcoes');

const base = process.env.PANEL_LOCAL_URL || 'http://127.0.0.1:4173';
if (process.env.CHROMIUM_PATH) test.use({ launchOptions: { executablePath: process.env.CHROMIUM_PATH } });
test.setTimeout(120000);

const JOURNEY = '7f000000-0000-4000-8000-000000000001', MATCH = '7f000000-0000-4000-8000-000000000002';
async function openPanel(page, { width = 1366, height = 900, assistant }) {
  const calls = { assistant: [], options: [], lead: [] };
  await page.setViewportSize({ width, height });
  await page.addInitScript(() => localStorage.setItem('mcs_panel_session', JSON.stringify({ accessToken: 'token-teste', refreshToken: 'refresh-teste', accessExpiresAt: Date.now() + 3600000 })));
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.href.startsWith(base)) return route.abort();
   떻쬺�^
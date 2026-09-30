'use strict';
// Exemplo fictício do Preview: sem banco, sem 360dialog e inexistente em produção.
const test = require('node:test');
const assert = require('node:assert/strict');
const v1 = require('../api/panel/v1-send');
const untouchable = new Proxy({}, { get: () => () => { throw new Error('o exemplo não pode tocar no banco nem no 360dialog'); } });
const base = 'https://preview.example.test';
const run = (body, env = { VERCEL_ENV: 'preview' }) => v1.handle({ environment: 'preview' }, body, untouchable, env);

test('em produção o exemplo não existe', async () => {
  const env = { VERCEL_ENV: 'production', V1_DIRECT_SEND_ENABLED: '1' };
  assert.equal((await run({ action: 'demo_prepare', baseUrl: base }, env)).status, 404);
  assert.equal((await run({ action: 'demo_send', text: 'x', confirmed: true, requestKey: '6c700000-0000-4000-8000-000000000001' }, env)).status, 404);
});

test('prepara com dados fictícios e a mensagem aprovada da origem, sem banco', async () => {
  const valor = await run({ action: 'demo_prepare', baseUrl: base, origin: 'VALOR', window: 'open' });
  assert.equal(valor.status, 200); assert.equal(valor.demo, true); assert.equal(valor.mode, 'SIMULATED');
  assert.equal(valor.name, 'Cliente Fictício (teste)'); assert.equal(valor.phone, '+15550100100');
  assert.equal(valor.text, v1.suggestedText('VALOR', 'Cliente Fictício (teste)', base + '/v/EXEMPLO-FICTICIO-NAO-E-CLIENTE'));
  const carro = await run({ action: 'demo_prepare', baseUrl: base, origin: 'CARRO', window: 'closed' });
  assert.equal(carro.windowOpen, false); assert.match(carro.text, /I reviewed the current auction listings/);
});

test('envio simulado: confirmação exigida, clique duplo barrado e janela fechada sem envio', async () => {
  const prepared = await run({ action: 'demo_prepare', baseUrl: base, origin: 'VALOR' });
  const key = (n) => '6c700000-0000-4000-8000-00000000010' + n;
  assert.equal((await run({ action: 'demo_send', text: prepared.text, requestKey: key(1) })).error, 'V1_SEND_CONFIRM_REQUIRED');
  assert.equal((await run({ action: 'demo_send', text: 'sem link', confirmed: true, requestKey: key(1), card: 't' })).error, 'V1_LINK_MISSING');
  const [first, second] = await Promise.all([
    run({ action: 'demo_send', text: prepared.text, confirmed: true, requestKey: key(2), card: 'duplo' }),
    run({ action: 'demo_send', text: prepared.text, confirmed: true, requestKey: key(3), card: 'duplo', fast: true })
  ]);
  assert.equal(first.sendStatus, 'SENT'); assert.equal(first.simulated, true);
  assert.equal(second.error, 'SEND_IN_PROGRESS');
  assert.equal((await run({ action: 'demo_send', text: prepared.text, confirmed: true, requestKey: key(4), card: 'duplo', fast: true })).error, 'V1_ALREADY_SENT');
  const closed = await run({ action: 'demo_send', text: prepared.text, confirmed: true, requestKey: key(5), window: 'closed', card: 'fechada', fast: true });
  assert.equal(closed.error, 'WINDOW_CLOSED'); assert.match(closed.whatsappLink, /^https:\/\/wa\.me\/15550100100\?text=/);
});

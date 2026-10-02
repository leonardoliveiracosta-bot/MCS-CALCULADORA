'use strict';

// Claude pelo saldo pré-pago: cada chamada reserva o pior caso, liquida pelo custo real, a recusa
// do provedor libera a reserva e "sem saldo" (400 credit balance) para o Claude até um novo saldo.
// Sem saldo que cubra a chamada, o provedor nunca é chamado. Nada sai da máquina.
const test = require('node:test');
const assert = require('node:assert/strict');
const claude = require('../panel-anthropic-budget');

const ctx = { environment: 'preview', config: {} };
function rpcLog(answers = {}) {
  const calls = [];
  return { calls, rpc: async (name, args) => { calls.push({ name, args }); return (answers[name] || (() => ({})))(args); } };
}

test('custo máximo: bytes de entrada + saída inteira; imagem conta 5 mil tokens', () => {
  const text = claude.maxCostUsd('claude-opus-5-5', 'sistema', 'x'.repeat(1000), 2400);
  assert.ok(text >= ((1000 + 7) * 4 + 2400 * 20) / 1e6, String(text));
  const image = claude.maxCostUsd('claude-opus-5-5', 's', [{ type: 'image', source: { data: 'A'.repeat(5_000_000) } }, { type: 'text', text: 'ler' }], 2400);
  assert.ok(image < 0.1, `imagem não conta os bytes do base64: ${image}`);
  assert.ok(claude.usageCostUsd({ input_tokens: 1000, output_tokens: 100 }, 'claude-opus-5-5') > 0);
});

test('reserva antes, liquida pelo custo real; sem saldo que cubra, o provedor nunca é chamado', async () => {
  const log = rpcLog({ panel_anthropic_budget_hold: () => ({ held: true, id: 'r1' }), panel_anthropic_budget_settle: () => ({ settled: true }) });
  let sent = 0;
  const result = await claude.paidCall({ ctx, feature: 'NOTA', subject: 'ABCDE', services: log }, { model: 'claude-opus-5-5', system: 's', user: 'u', maxTokens: 2400,
    send: async () => { sent++; return { status: 200, payload: { usage: { input_tokens: 100, output_tokens: 10 } } }; } });
  assert.equal(sent, 1);
  assert.ok(result.payload);
  assert.deepEqual(log.calls.map((call) => call.name), ['panel_anthropic_budget_hold', 'panel_anthropic_budget_settle']);
  assert.equal(log.calls[1].args.p_status, 'PAGA');
  assert.ok(log.calls[1].args.p_actual <= log.calls[0].args.p_amount, 'custo real nunca acima do reservado');
  const refused = rpcLog({ panel_anthropic_budget_hold: () => ({ held: false, reason: 'SALDO_INSUFICIENTE' }) });
  await assert.rejects(claude.paidCall({ ctx, feature: 'NOTA', services: refused }, { model: 'm', system: 's', user: 'u', maxTokens: 10, send: async () => { sent++; return {}; } }), { code: 'AI_BALANCE_LIMIT' });
  assert.equal(sent, 1, 'nenhuma chamada sem saldo');
});

test('"credit balance too low" libera a reserva e marca o Claude sem saldo; erro de rede conta o pior caso', async () => {
  const log = rpcLog({ panel_anthropic_budget_hold: () => ({ held: true, id: 'r2' }), panel_anthropic_budget_settle: () => ({ settled: true }) });
  const out = await claude.paidCall({ ctx, feature: 'LEITURA', services: log }, { model: 'm', system: 's', user: 'u', maxTokens: 10,
    send: async () => ({ status: 400, detail: '{"error":{"message":"Your credit balance is too low to access the Anthropic API"}}' }) });
  assert.equal(out.payload, undefined);
  assert.deepEqual(log.calls.map((call) => [call.name, call.args.p_status || call.args.p_provider || null]), [['panel_anthropic_budget_hold', null], ['panel_anthropic_budget_settle', 'LIBERADA'], ['panel_ai_mark_exhausted', 'ANTHROPIC']]);
  const network = rpcLog({ panel_anthropic_budget_hold: () => ({ held: true, id: 'r3' }), panel_anthropic_budget_settle: () => ({ settled: true }) });
  await assert.rejects(claude.paidCall({ ctx, feature: 'LEITURA', services: network }, { model: 'm', system: 's', user: 'u', maxTokens: 10, send: async () => { throw new Error('rede'); } }), /rede/);
  assert.equal(network.calls[1].args.p_status, 'PAGA');
  assert.equal(network.calls[1].args.p_actual, network.calls[0].args.p_amount, 'pode ter sido cobrada: conta o pior caso');
});

test('em produção, chamada do Claude sem reserva não sai', async () => {
  const saved = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  try { await assert.rejects(claude.paidCall(null, { model: 'm', system: 's', user: 'u', maxTokens: 10, send: async () => ({}) }), { code: 'AI_BUDGET_GUARD_MISSING' }); }
  finally { if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved; }
});

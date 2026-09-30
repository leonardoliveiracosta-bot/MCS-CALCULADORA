'use strict';
// Teto único da OpenAI: US$ 50 somando PESQUISAS, ENTRADA, conferência e normalização do Manheim.
const test = require('node:test');
const assert = require('node:assert/strict');
const budget = require('../panel-openai-budget');
const ctx = { environment: 'production', config: {} };
const reader = (tables) => async (_ctx, table) => { if (tables.fail) throw Error('rede'); return tables[table] || []; };

test('soma o gasto das quatro frentes OpenAI', async () => {
  const spent = await budget.spentUsd(ctx, { allRows: reader({ vehicle_request_runs: [{ cost_usd: 10 }], vehicle_request_batches: [{ cost_usd: 0.5 }], conversation_triage: [{ cost_usd: 2 }], manheim_match_audits: [{ cost_usd: 3 }], audit_log: [{ after_json: { costUsd: 4 } }, { after_json: {} }] }) });
  assert.equal(spent.total, 19.5);
  assert.deepEqual(spent.byFeature, { pesquisas: 10.5, entrada: 2, manheimAudit: 3, manheimCsv: 4 });
});

test('uma chamada só começa se o pior caso ainda cabe em US$ 50', () => {
  assert.equal(budget.fits({ total: 49.9 }, 0.05), true);
  assert.equal(budget.fits({ total: 49.96 }, 0.05), false);
  assert.equal(budget.fits({ total: 49.9 }, 0.05, 0.06), false);
});

test('em produção, falha ao ler o gasto bloqueia a chamada', async () => {
  const saved = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  await assert.rejects(budget.spentUsd(ctx, { allRows: reader({ fail: true }) }), /OPENAI_BUDGET_UNAVAILABLE/);
  process.env.VERCEL_ENV = 'preview';
  assert.equal((await budget.spentUsd(ctx, { allRows: reader({ fail: true }) })).total, 0);
  if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved;
});

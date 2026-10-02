'use strict';
// OpenAI pelo saldo pré-pago: gasto somado de todas as funções, sem teto interno.
const test = require('node:test');
const assert = require('node:assert/strict');
const budget = require('../panel-openai-budget');
const ctx = { environment: 'production', config: {} };
const reader = (tables) => async (_ctx, table, params = {}) => { if (tables.fail) throw Error('rede'); const key = table === 'audit_log' && params.entity_type ? table + ':' + params.entity_type.replace(/^eq\./, '') : table; return tables[key] || tables[table] || []; };

test('soma o gasto das frentes OpenAI (sugestões, resposta orientada e tradução no mesmo teto)', async () => {
  const spent = await budget.spentUsd(ctx, { allRows: reader({ vehicle_request_runs: [{ cost_usd: 10 }], vehicle_request_batches: [{ cost_usd: 0.5 }], conversation_triage: [{ cost_usd: 2 }], manheim_match_audits: [{ cost_usd: 3 }], 'audit_log:manheim_openai': [{ after_json: { costUsd: 4 } }, { after_json: {} }], 'audit_log:reply_suggestion_openai': [{ after_json: { costUsd: 0.25 } }], 'audit_log:reply_guided_openai': [{ after_json: { costUsd: 0.5 } }], 'audit_log:conversation_translation_openai': [{ after_json: { costUsd: 0.25 } }] }) });
  assert.equal(spent.total, 20.5);
  assert.deepEqual(spent.byFeature, { pesquisas: 10.5, entrada: 2, manheimAudit: 3, manheimCsv: 4, resposta: 0.25, respostaOrientada: 0.5, traducao: 0.25 });
});

test('uma chamada só começa se o pior caso ainda cabe no saldo pré-pago que resta; sem saldo informado não há teto interno', () => {
  // Saldo informado: restam US$ 0,10.
  assert.equal(budget.fits({ total: 49.9, remaining: 0.1 }, 0.05), true);
  assert.equal(budget.fits({ total: 49.9, remaining: 0.04 }, 0.05), false);
  assert.equal(budget.fits({ total: 49.9, remaining: 0.1 }, 0.05, 0.06), false);
  // Sem saldo informado: nem US$ 50 nem nenhum outro teto do painel (o limite é o pré-pago do provedor).
  assert.equal(budget.fits({ total: 120, remaining: null }, 0.05), true);
  // O provedor disse "sem saldo": nada sai até informar um novo saldo.
  assert.equal(budget.fits({ total: 1, remaining: null, exhausted: true }, 0.05), false);
  assert.equal(budget.LIMIT_USD, undefined);
});

test('em produção, falha ao ler o gasto bloqueia a chamada', async () => {
  const saved = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  await assert.rejects(budget.spentUsd(ctx, { allRows: reader({ fail: true }) }), /OPENAI_BUDGET_UNAVAILABLE/);
  process.env.VERCEL_ENV = 'preview';
  assert.equal((await budget.spentUsd(ctx, { allRows: reader({ fail: true }) })).total, 0);
  if (saved === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved;
});

const modelCheck = require('../panel-openai-model-check');
test('teste mínimo do modelo antes da primeira leitura real: sem dado de cliente, gravado e exigido', async () => {
  const env = { VERCEL_ENV: 'production' };
  const inserted = [], sent = [];
  const services = (found, fail) => ({ env, rows: async () => found ? [{ id: 'x' }] : [], insert: async (_c, table, row) => { inserted.push({ table, row }); },
    budget: { fits: () => true, spentUsd: async () => ({ total: 0 }) },
    chat: async (body, options) => { sent.push({ body, model: options.env.SEARCH_EXTRACTION_MODEL }); if (fail) throw Object.assign(Error('x'), { code: 'OPENAI_MODEL_UNAVAILABLE' }); return { usage: { input: 5, output: 1 }, costUsd: 0.000004 }; } });
  assert.deepEqual(await modelCheck.ensureModelChecked(ctx, 'gpt-6-luna', services(true)), { ok: true });
  assert.equal(sent.length, 0);
  assert.deepEqual(await modelCheck.ensureModelChecked(ctx, 'gpt-6-luna', services(false)), { ok: true, checked: true });
  assert.equal(sent.length, 1); assert.equal(sent[0].model, 'gpt-6-luna');
  assert.deepEqual(sent[0].body.messages, [{ role: 'user', content: 'Teste de disponibilidade do modelo. Responda apenas: ok' }]);
  assert.equal(inserted[0].table, 'vehicle_request_batches'); assert.equal(inserted[0].row.stopped_reason, 'MODEL_CHECK_OK'); assert.equal(inserted[0].row.conversations, 0);
  const failed = await modelCheck.ensureModelChecked(ctx, 'gpt-6-luna', services(false, true));
  assert.equal(failed.ok, false); assert.equal(inserted[1].row.stopped_reason, 'MODEL_UNAVAILABLE');
  assert.deepEqual(await modelCheck.ensureModelChecked(ctx, 'gpt-6-luna', { env: { VERCEL_ENV: 'preview' } }), { ok: true, simulated: true });
});

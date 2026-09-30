'use strict';

// Before the first real reading of any OpenAI feature (ENTRADA triage, Manheim match audit and
// Manheim CSV normalization), one minimal call with the configured model and no customer data
// must have passed. It is recorded like the PESQUISAS model check (vehicle_request_batches with
// conversations = 0) and counts in the US$ 50 OpenAI ceiling. Outside production nothing is
// called: the Preview is always simulated.
const { insert, rows } = require('./panel-server');
const openAiBudget = require('./panel-openai-budget');

const CHECK_OK = 'MODEL_CHECK_OK';
const PROMPT = 'Teste de disponibilidade do modelo. Responda apenas: ok';

async function ensureModelChecked(ctx, modelId, services = {}) {
  if (!modelId) return { ok: false, error: 'MODEL_MISSING' };
  if ((services.env || process.env).VERCEL_ENV !== 'production') return { ok: true, simulated: true };
  const read = services.rows || rows, add = services.insert || insert;
  const [found] = await read(ctx, 'vehicle_request_batches', { select: 'id', environment: 'eq.' + ctx.environment, provider: 'eq.OPENAI', model: 'eq.' + modelId, stopped_reason: 'eq.' + CHECK_OK, limit: '1' });
  if (found) return { ok: true };
  const budget = services.budget || openAiBudget;
  if (!budget.fits(await budget.spentUsd(ctx))) return { ok: false, error: 'PROVIDER_LIMIT' };
  const chat = services.chat || require('./panel-search-requests').openAiChat;
  let result = null, failure = null;
  const guard = budget.guard ? budget.guard(ctx, 'MODELO_TESTE', 'modelo:' + modelId, services.budgetServices) : null;
  try { result = await chat({ messages: [{ role: 'user', content: PROMPT }] }, { env: { ...process.env, SEARCH_EXTRACTION_MODEL: modelId }, fetchImpl: services.fetchImpl, guard }); }
  catch (error) { failure = error && error.code || 'OPENAI_FAILED'; }
  if (failure === 'OPENAI_BUDGET_LIMIT') return { ok: false, error: 'PROVIDER_LIMIT' };
  await add(ctx, 'vehicle_request_batches', { environment: ctx.environment, provider: 'OPENAI', model: modelId, conversations: 0, input_tokens: result?.usage?.input || 0, output_tokens: result?.usage?.output || 0,
    cost_usd: Math.round((Number(result?.costUsd) || 0) * 1e6) / 1e6, stopped_reason: failure ? (failure === 'OPENAI_MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' : 'MODEL_CHECK_' + String(failure).replace(/^OPENAI_/, '')) : CHECK_OK, created_by: ctx.panel?.id || null }, false);
  if (budget.recorded) await budget.recorded(guard);
  return failure ? { ok: false, error: failure } : { ok: true, checked: true };
}

module.exports = { CHECK_OK, ensureModelChecked };

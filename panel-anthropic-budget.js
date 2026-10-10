'use strict';

// Claude spend of the whole panel against the provider's prepaid balance (no internal ceiling):
// the same reservation as panel-openai-budget. Every paid call reserves its worst case first
// (panel_anthropic_budget_hold, one lock per environment) and starts only when it fits in the
// balance left; after the answer the reservation holds the real cost. "Credit balance too low"
// from Anthropic stops every Claude feature until a new balance is informed. In production a
// failed reservation blocks the call (never spend blind); elsewhere nothing real is paid.
const { supabase } = require('./panel-server');

const failure = (code) => Object.assign(new Error(code), { code });
const isProduction = () => process.env.VERCEL_ENV === 'production';

// USD per million tokens by model family (same table as the general reading).
function modelPrices(model) {
  const name = String(model || '').toLowerCase();
  if (name.includes('opus-5-5')) return { input: 4, output: 20 };
  if (name.includes('sonnet-5')) return { input: 2, output: 10 };
  if (name.includes('haiku')) return { input: 1, output: 5 };
  return { input: 4, output: 20 };
}
// An image is at most ~1.6k tokens after the provider resizes it; 5k is a safe upper bound.
const IMAGE_TOKENS = 5000;
function inputTokensOf(value) {
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + (part && part.type === 'image' ? IMAGE_TOKENS : inputTokensOf(part && part.text !== undefined ? part.text : part)), 0);
  if (value && typeof value === 'object') return Buffer.byteLength(JSON.stringify(value), 'utf8');
  return Buffer.byteLength(String(value || ''), 'utf8');
}
// Upper bound of one request: every input byte as a token (a token is never shorter than a byte)
// plus the full output cap.
function maxCostUsd(model, system, user, maxTokens) {
  const price = modelPrices(model);
  const input = inputTokensOf(system) + inputTokensOf(user) + 64;
  return Math.ceil((input * price.input + Number(maxTokens || 0) * price.output) / 1e6 * 1e6) / 1e6;
}
function usageCostUsd(usage, model) {
  const price = modelPrices(model);
  const input = Number(usage?.input_tokens || 0) + Number(usage?.cache_creation_input_tokens || 0) + Number(usage?.cache_read_input_tokens || 0);
  return (input * price.input + Number(usage?.output_tokens || 0) * price.output) / 1e6;
}

async function callRpc(ctx, name, args, services = {}) {
  if (services.rpc) return services.rpc(name, args);
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
}
async function markExhausted(ctx, reason, services = {}) {
  try { await callRpc(ctx, 'panel_ai_mark_exhausted', { p_environment: ctx.environment, p_provider: 'ANTHROPIC', p_reason: String(reason || 'ANTHROPIC_CREDIT').slice(0, 200) }, services); } catch (_) {}
}
async function balanceState(ctx, services = {}) {
  return (await callRpc(ctx, 'panel_ai_balance_state', { p_environment: ctx.environment, p_provider: 'ANTHROPIC' }, services)) || {};
}
// "Your credit balance is too low" (400) or a billing refusal (402): the provider has no balance.
function isNoCredit(status, detail) { return status === 402 || (status === 400 && /credit balance|billing/i.test(String(detail || ''))); }

// budget: { ctx, feature, subject, services? }. send() makes the request and returns
// { payload, status, detail } (payload only when ok).
async function paidCall(budget, { model, system, user, maxTokens, send }) {
  if (!budget || !budget.ctx) {
    if (isProduction()) throw failure('AI_BUDGET_GUARD_MISSING');
    return send();
  }
  const { ctx, services = {} } = budget;
  const amount = Math.max(maxCostUsd(model, system, user, maxTokens), 0.000001);
  let hold;
  try {
    hold = await callRpc(ctx, 'panel_anthropic_budget_hold', { p_environment: ctx.environment, p_feature: String(budget.feature || 'CLAUDE').slice(0, 40), p_subject: String(budget.subject || '-').slice(0, 200), p_model: String(model || '').slice(0, 80), p_amount: amount }, services);
  } catch (_) {
    if (isProduction()) throw failure('AI_BUDGET_UNAVAILABLE');
    hold = { held: true, id: null };
  }
  if (!hold || hold.held !== true) throw Object.assign(failure('AI_BALANCE_LIMIT'), { reason: (hold && hold.reason) || 'SALDO_INSUFICIENTE' });
  const settle = (status, actual) => hold.id ? callRpc(ctx, 'panel_anthropic_budget_settle', { p_environment: ctx.environment, p_id: hold.id, p_status: status, p_actual: actual === null ? null : Math.round(Number(actual) * 1e6) / 1e6 }, services).catch(() => null) : null;
  const startedAt = Date.now();
  const observe = (ok, costUsd, result, costKind) => require('./panel-ai-observability').record({ provider: 'anthropic', model,
    feature: budget.feature || 'CLAUDE', environment: ctx.environment, startedAt, endedAt: Date.now(), ok, costUsd, result, costKind });
  let result;
  try { result = await send(); }
  catch (error) {
    // A network failure or timeout may have been billed: the worst case stays.
    observe(false, amount, null, 'reservation_unknown_charge');
    await settle('PAGA', amount);
    throw error;
  }
  if (!result || !result.payload) {
    // Refused by the provider before any work: nothing billed.
    observe(false, 0, null, 'not_billed');
    await settle('LIBERADA', 0);
    if (result && isNoCredit(result.status, result.detail)) await markExhausted(ctx, 'ANTHROPIC_CREDIT', services);
    return result;
  }
  observe(true, Math.min(usageCostUsd(result.payload.usage, model), amount), result);
  await settle('PAGA', Math.min(usageCostUsd(result.payload.usage, model), amount));
  return result;
}

module.exports = { modelPrices, maxCostUsd, usageCostUsd, paidCall, balanceState, markExhausted, isNoCredit };

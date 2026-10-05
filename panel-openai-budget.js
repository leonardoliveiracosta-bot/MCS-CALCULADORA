'use strict';

// OpenAI spend of the whole panel against the provider's prepaid balance (no internal ceiling).
// The balance is the one informed in the panel (OpenAI has no balance API); every paid call
// reserves its worst case and starts only when it still fits in what is left. Without an informed
// balance the limit is the provider's own prepaid credit. "No balance" from OpenAI stops every
// feature until a new balance is informed. In production a failed read of the state blocks the
// call (never spend blind); elsewhere nothing real is paid.
const { allRows, supabase } = require('./panel-server');

const MAX_CALL_USD = 0.05;

const number = (value) => Number(value) || 0;
const sum = (list, pick) => list.reduce((total, row) => total + number(pick(row)), 0);

async function spentUsd(ctx, services = {}) {
  const read = services.allRows || allRows;
  const env = 'eq.' + ctx.environment;
  try {
    const [runs, checks, triage, audits, csv, replies, guided, translations] = await Promise.all([
      read(ctx, 'vehicle_request_runs', { select: 'cost_usd', environment: env, provider: 'eq.OPENAI', cost_usd: 'not.is.null' }),
      read(ctx, 'vehicle_request_batches', { select: 'cost_usd', environment: env, provider: 'eq.OPENAI', conversations: 'eq.0', cost_usd: 'not.is.null' }),
      read(ctx, 'conversation_triage', { select: 'cost_usd', environment: env, cost_usd: 'not.is.null' }),
      read(ctx, 'manheim_match_audits', { select: 'cost_usd', environment: env, cost_usd: 'not.is.null' }),
      read(ctx, 'audit_log', { select: 'after_json', environment: env, entity_type: 'eq.manheim_openai' }),
      read(ctx, 'audit_log', { select: 'after_json', environment: env, entity_type: 'eq.reply_suggestion_openai' }),
      read(ctx, 'audit_log', { select: 'after_json', environment: env, entity_type: 'eq.reply_guided_openai' }),
      read(ctx, 'audit_log', { select: 'after_json', environment: env, entity_type: 'eq.conversation_translation_openai' })
    ]);
    const byFeature = {
      pesquisas: sum(runs, (row) => row.cost_usd) + sum(checks, (row) => row.cost_usd),
      entrada: sum(triage, (row) => row.cost_usd),
      manheimAudit: sum(audits, (row) => row.cost_usd),
      manheimCsv: sum(csv, (row) => row.after_json && row.after_json.costUsd),
      resposta: sum(replies, (row) => row.after_json && row.after_json.costUsd),
      respostaOrientada: sum(guided, (row) => row.after_json && row.after_json.costUsd),
      traducao: sum(translations, (row) => row.after_json && row.after_json.costUsd)
    };
    const total = Object.values(byFeature).reduce((a, b) => a + b, 0);
    let balance;
    try { balance = await balanceState(ctx, services); }
    catch (error) { if (isProduction()) throw error; balance = { balance: null, remaining: null, exhausted: false, unavailable: true }; }
    return { total: Math.round(total * 1e6) / 1e6, byFeature, limit: balance.balance, remaining: balance.remaining, exhausted: Boolean(balance.exhausted), balance };
  } catch (error) {
    if (process.env.VERCEL_ENV === 'production') throw Object.assign(new Error('OPENAI_BUDGET_UNAVAILABLE'), { code: 'OPENAI_BUDGET_UNAVAILABLE' });
    return { total: 0, byFeature: {}, limit: null, remaining: null, exhausted: false, unavailable: true };
  }
}
// The prepaid balance state (balance, spent since it was informed, remaining, warn, exhausted).
async function balanceState(ctx, services = {}) {
  const item = { ctx, services };
  const state = await callRpc(item, 'panel_ai_balance_state', { p_environment: ctx.environment, p_provider: 'OPENAI' });
  return state || {};
}

// True when a call that may cost up to `nextUsd` still fits in the prepaid balance left, given
// `extraUsd` already spent in this run but not yet read back. No informed balance: always true
// (the provider's prepaid credit is the limit and the reservation still runs per call).
function fits(spent, nextUsd = MAX_CALL_USD, extraUsd = 0) {
  if (!spent || spent.exhausted) return false;
  if (spent.remaining === null || spent.remaining === undefined) return true;
  return number(extraUsd) + number(nextUsd) <= number(spent.remaining);
}
// "No balance" from OpenAI (insufficient_quota / billing): every feature stops until a new
// balance is informed. Never throws.
async function markExhausted(ctx, reason, services = {}) {
  try { await callRpc({ ctx, services }, 'panel_ai_mark_exhausted', { p_environment: ctx.environment, p_provider: 'OPENAI', p_reason: String(reason || 'OPENAI_QUOTA').slice(0, 200) }); } catch (_) {}
}
// One reading of a failed OpenAI response for every feature: quota/billing is OPENAI_QUOTA
// (no balance), 429 otherwise a rate limit, anything else a failure.
async function openAiFailure(response) {
  let detail = '';
  try { detail = await response.text(); } catch (_) {}
  const failure = new Error('OPENAI_FAILED');
  failure.status = response.status;
  if ((response.status === 429 && /insufficient_quota|billing|credit/i.test(detail)) || response.status === 402) failure.code = 'OPENAI_QUOTA';
  else failure.code = response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_FAILED';
  return failure;
}

// ------------------------------------------------------------------ reserva por chamada
// Every paid call reserves its worst case first (panel_openai_budget_hold, one lock per
// environment for every feature): input tokens never exceed the bytes sent (+ message overhead),
// output tokens never exceed max_completion_tokens, set here on every request. After the answer
// the reservation holds the real cost until the feature writes it to its own table
// (recorded); a provider refusal releases it; a timeout or network failure keeps the worst case
// (it may have been billed).
const OUTPUT_CAP = Object.freeze({ PESQUISAS: 8000, MODELO_TESTE: 200, ENTRADA: 2000, MANHEIM_AUDIT: 16000, MANHEIM_CSV: 8000, RESPOSTA: 1500, RESPOSTA_ORIENTADA: 1500, TRADUCAO_CONVERSA: 8000, V2_DRAFT: 2000 });
const NOT_BILLED = new Set(['OPENAI_FAILED', 'OPENAI_RATE_LIMIT', 'OPENAI_QUOTA', 'OPENAI_MODEL_UNAVAILABLE', 'OPENAI_KEY_INVALID']);
const failure = (code) => Object.assign(new Error(code), { code });
const isProduction = () => process.env.VERCEL_ENV === 'production';

function priceOf(modelId) {
  const price = require('./panel-triage').PRICES[modelId];
  if (!price) throw failure('OPENAI_MODEL_PRICE_UNKNOWN');
  return price;
}
// Upper bound of what one request can cost.
function maxCostUsd(modelId, body) {
  const price = priceOf(modelId);
  const inputTokens = Buffer.byteLength(JSON.stringify(body), 'utf8') + 16 * ((body.messages || []).length + 4);
  const outputTokens = Number(body.max_completion_tokens) || 0;
  if (!outputTokens) throw failure('OPENAI_OUTPUT_CAP_MISSING');
  return Math.ceil((inputTokens * price.input + outputTokens * price.output) / 1e6 * 1e6) / 1e6;
}

// One guard per unit of work (a conversation, a demand, a CSV request). services.rpc is for tests.
function guard(ctx, feature, subject, services = {}) {
  if (!OUTPUT_CAP[feature]) throw failure('OPENAI_FEATURE_UNKNOWN');
  return { ctx, feature, subject: String(subject || '-').slice(0, 200), paid: [], services };
}
async function callRpc(item, name, args) {
  const ctx = item.ctx;
  if (item.services.rpc) return item.services.rpc(name, args);
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
}
async function reserve(item, modelId, amountUsd) {
  let answer;
  try { answer = await callRpc(item, 'panel_openai_budget_hold', { p_environment: item.ctx.environment, p_feature: item.feature, p_subject: item.subject, p_model: modelId, p_amount: amountUsd }); }
  catch (error) {
    // Never spend blind in production; outside it nothing real is paid (the Preview shares the
    // database and may run before the migration).
    if (isProduction()) throw failure('OPENAI_BUDGET_UNAVAILABLE');
    return { id: null, simulated: true };
  }
  if (!answer || answer.held !== true) throw Object.assign(failure('OPENAI_BUDGET_LIMIT'), { reason: (answer && answer.reason) || 'SALDO_INSUFICIENTE', remainingUsd: Number(answer && answer.remaining) || 0 });
  return { id: answer.id };
}
async function settle(item, hold, status, actualUsd = null) {
  if (!hold || !hold.id) return false;
  try {
    const answer = await callRpc(item, 'panel_openai_budget_settle', { p_environment: item.ctx.environment, p_id: hold.id, p_status: status, p_actual: actualUsd === null ? null : Math.round(Number(actualUsd) * 1e6) / 1e6 });
    return Boolean(answer && answer.settled);
  } catch (_) { return false; } // the reservation keeps counting: never less than what was spent
}

// send(body) makes the request with the capped body and returns { costUsd, ... } or throws.
async function paidCall(item, { modelId, body, send }) {
  if (!item || !item.ctx) {
    if (isProduction()) throw failure('OPENAI_BUDGET_GUARD_MISSING');
    return send(body);
  }
  const capped = { ...body, max_completion_tokens: OUTPUT_CAP[item.feature] };
  const amount = maxCostUsd(modelId, capped);
  const hold = await reserve(item, modelId, amount);
  let result;
  try { result = await send(capped); }
  catch (error) {
    const billed = !NOT_BILLED.has(error && error.code);
    await settle(item, hold, billed ? 'PAGA' : 'LIBERADA', billed ? amount : 0);
    if (error && error.code === 'OPENAI_QUOTA') await markExhausted(item.ctx, 'OPENAI_QUOTA', item.services);
    throw error;
  }
  await settle(item, hold, 'PAGA', Number(result && result.costUsd) || 0);
  // Only a successful answer's cost is written by the feature; a failure's stays on the hold.
  if (hold.id) item.paid.push(hold.id);
  return result;
}
// The feature wrote the cost of these calls to its own table: the reservations stop counting.
async function recorded(item) {
  if (!item) return;
  const ids = item.paid.splice(0);
  for (const id of ids) await settle(item, { id }, 'REGISTRADA');
}
async function state(ctx, services = {}) {
  const item = { ctx, services };
  return callRpc(item, 'panel_openai_budget_state', { p_environment: ctx.environment });
}

module.exports = { MAX_CALL_USD, OUTPUT_CAP, spentUsd, balanceState, fits, markExhausted, openAiFailure, maxCostUsd, guard, paidCall, recorded, state };

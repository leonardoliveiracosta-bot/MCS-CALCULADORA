'use strict';

// One OpenAI ceiling for the whole panel: US$ 50 summed over every OpenAI feature
// (PESQUISAS reading and its model checks, ENTRADA triage, Manheim match audit and the Manheim
// CSV normalization). Each feature keeps its own limits; this one is checked before every paid
// call and a call starts only when the worst case still fits. In production a failed read of the
// spend blocks the call (never spend blind); elsewhere nothing real is paid.
const { allRows } = require('./panel-server');

const LIMIT_USD = 50;
const MAX_CALL_USD = 0.05;

const number = (value) => Number(value) || 0;
const sum = (list, pick) => list.reduce((total, row) => total + number(pick(row)), 0);

async function spentUsd(ctx, services = {}) {
  const read = services.allRows || allRows;
  const env = 'eq.' + ctx.environment;
  try {
    const [runs, checks, triage, audits, csv] = await Promise.all([
      read(ctx, 'vehicle_request_runs', { select: 'cost_usd', environment: env, provider: 'eq.OPENAI', cost_usd: 'not.is.null' }),
      read(ctx, 'vehicle_request_batches', { select: 'cost_usd', environment: env, provider: 'eq.OPENAI', conversations: 'eq.0', cost_usd: 'not.is.null' }),
      read(ctx, 'conversation_triage', { select: 'cost_usd', environment: env, cost_usd: 'not.is.null' }),
      read(ctx, 'manheim_match_audits', { select: 'cost_usd', environment: env, cost_usd: 'not.is.null' }),
      read(ctx, 'audit_log', { select: 'after_json', environment: env, entity_type: 'eq.manheim_openai' })
    ]);
    const byFeature = {
      pesquisas: sum(runs, (row) => row.cost_usd) + sum(checks, (row) => row.cost_usd),
      entrada: sum(triage, (row) => row.cost_usd),
      manheimAudit: sum(audits, (row) => row.cost_usd),
      manheimCsv: sum(csv, (row) => row.after_json && row.after_json.costUsd)
    };
    const total = Object.values(byFeature).reduce((a, b) => a + b, 0);
    return { total: Math.round(total * 1e6) / 1e6, byFeature, limit: LIMIT_USD };
  } catch (error) {
    if (process.env.VERCEL_ENV === 'production') throw Object.assign(new Error('OPENAI_BUDGET_UNAVAILABLE'), { code: 'OPENAI_BUDGET_UNAVAILABLE' });
    return { total: 0, byFeature: {}, limit: LIMIT_USD, unavailable: true };
  }
}

// True when a call that may cost up to `nextUsd` still fits under the ceiling, given `extraUsd`
// already spent in this run but not yet read back.
function fits(spent, nextUsd = MAX_CALL_USD, extraUsd = 0) {
  return number(spent.total) + number(extraUsd) + number(nextUsd) <= LIMIT_USD;
}

module.exports = { LIMIT_USD, MAX_CALL_USD, spentUsd, fits };

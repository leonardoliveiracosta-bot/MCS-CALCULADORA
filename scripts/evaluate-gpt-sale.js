'use strict';

// One manual evaluation, not a cron or normal build command. Run on Vercel so
// production secrets never need to be downloaded. Only built-in fictional cases.
const crypto = require('node:crypto');
const { CASES, grade } = require('./gpt-sale-cases');
const unlock = require('../api/panel/unlock-sale');
const guided = require('../panel-reply-guided');
const budget = require('../panel-openai-budget');
const suggest = require('../panel-reply-suggest');
const { insert } = require('../panel-server');
const { exportTrace } = require('../panel-ai-observability');
const { VERSION, prepareAnswer } = require('../panel-gpt-sale-guidance');

async function exportEvaluation(event, result, env, fetchImpl = fetch) {
  let traceId, observationId;
  const accepted = await exportTrace(event, { env, fetchImpl: async (url, options) => {
    const payload = JSON.parse(options.body);
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    traceId = span.traceId; observationId = span.spanId;
    span.attributes.push({ key: 'langfuse.observation.metadata.case', value: { stringValue: result.caseId } });
    span.attributes.push({ key: 'langfuse.observation.metadata.promptVersion', value: { stringValue: result.version } });
    return fetchImpl(url, { ...options, body: JSON.stringify(payload) });
  } });
  if (!accepted) throw Object.assign(new Error('EVALUATION_EXPORT_FAILED'), { code: 'EVALUATION_EXPORT_FAILED' });
  const response = await fetchImpl(new URL('/api/public/scores', env.LANGFUSE_BASE_URL), {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'content-type': 'application/json', authorization: 'Basic ' + Buffer.from(env.LANGFUSE_PUBLIC_KEY + ':' + env.LANGFUSE_SECRET_KEY).toString('base64') },
    body: JSON.stringify({ id: crypto.randomUUID(), traceId, observationId, name: 'mcs_regras_e_clareza',
      dataType: 'BOOLEAN', value: result.passed ? 1 : 0, comment: result.failures.join(', ') || 'Built-in fictional case passed deterministic checks' })
  });
  if (!response.ok) throw Object.assign(new Error('EVALUATION_SCORE_FAILED'), { code: 'EVALUATION_SCORE_FAILED' });
}

async function run() {
  const env = { ...process.env };
  if (env.VERCEL_ENV !== 'production' || !env.OPENAI_API_KEY || !env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw Object.assign(new Error('EVALUATION_SERVER_ONLY'), { code: 'EVALUATION_SERVER_ONLY' });
  if (env.LANGFUSE_ENABLED !== 'true' || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) throw Object.assign(new Error('EVALUATION_LANGFUSE_REQUIRED'), { code: 'EVALUATION_LANGFUSE_REQUIRED' });
  const model = suggest.model(env);
  const variants = [{ name: 'BASELINE', version: 'destravar-v2', instructions: unlock.instructionsFor('Claude') },
    { name: 'CANDIDATE', version: VERSION, instructions: unlock.instructionsFor('OpenAI') }];
  const maximum = variants.reduce((sum, variant) => sum + CASES.reduce((total, scenario) => total + budget.maxCostUsd(model, {
    model, messages: [{ role: 'system', content: variant.instructions }, { role: 'user', content: JSON.stringify(scenario.input) }],
    response_format: { type: 'json_schema', json_schema: { name: 'destravar_pessoas', strict: true, schema: unlock.SCHEMA } },
    max_completion_tokens: budget.OUTPUT_CAP.RESPOSTA_ORIENTADA
  }), 0), 0);
  if (maximum > 0.05) throw Object.assign(new Error('EVALUATION_CAP_EXCEEDED'), { code: 'EVALUATION_CAP_EXCEEDED' });
  console.log('GPT_EVAL_START ' + JSON.stringify({ cases: CASES.length, calls: CASES.length * variants.length, maximumUsd: maximum, model }));
  const ctx = { environment: 'production', config: { url: env.SUPABASE_URL, secretKey: env.SUPABASE_SECRET_KEY }, panel: { id: null } };
  const results = [];
  // The build process is isolated. Export one correctly labelled test trace per
  // call instead of duplicating the normal cost trace and the evaluation trace.
  const priorEnabled = process.env.LANGFUSE_ENABLED;
  process.env.LANGFUSE_ENABLED = 'false';
  try {
    for (const scenario of CASES) for (const variant of variants) {
      const id = crypto.randomUUID();
      const guard = budget.guard(ctx, 'RESPOSTA_ORIENTADA', 'gpt-eval:' + id);
      const startedAt = Date.now();
      const answer = await guided.openAiJson({ instructions: variant.instructions, input: scenario.input, schema: unlock.SCHEMA, name: 'destravar_pessoas' }, { env, guard, timeoutMs: 40000 });
      await insert(ctx, 'audit_log', { environment: 'production', actor_user_id: null, entity_type: 'unlock_sale_openai', entity_id: id, action: 'GPT_PROMPT_EVAL',
        after_json: { provider: 'openai', model: answer.model, inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens, costUsd: answer.costUsd,
          synthetic: true, caseId: scenario.id, promptVersion: variant.version } }, false);
      await budget.recorded(guard);
      const response = variant.name === 'CANDIDATE' ? prepareAnswer(answer.parsed) : answer.parsed;
      const review = grade(response, scenario);
      const result = { caseId: scenario.id, variant: variant.name, version: variant.version, ...review,
        costUsd: answer.costUsd, latencyMs: Date.now() - startedAt, response };
      results.push(result);
      await exportEvaluation({ provider: 'openai', model: answer.model, feature: 'GPT_EVAL_' + variant.name, environment: 'test',
        startedAt, endedAt: Date.now(), ok: true, costUsd: answer.costUsd, result: answer, costKind: 'estimated_token_usage' }, result, env);
      console.log('GPT_EVAL_RESULT ' + JSON.stringify(result));
    }
  } finally { process.env.LANGFUSE_ENABLED = priorEnabled; }
  const summary = Object.fromEntries(variants.map((variant) => {
    const items = results.filter((result) => result.variant === variant.name);
    return [variant.name, { passed: items.filter((result) => result.passed).length, total: items.length,
      costUsd: Number(items.reduce((sum, result) => sum + result.costUsd, 0).toFixed(6)) }];
  }));
  console.log('GPT_EVAL_SUMMARY ' + JSON.stringify(summary));
  if (summary.CANDIDATE.passed !== summary.CANDIDATE.total) throw Object.assign(new Error('EVALUATION_CANDIDATE_FAILED'), { code: 'EVALUATION_CANDIDATE_FAILED' });
}

if (require.main === module) run().catch((error) => { console.error('GPT_EVAL_FAILED ' + (error.code || 'EVALUATION_FAILED')); process.exitCode = 1; });
module.exports = { exportEvaluation, run };

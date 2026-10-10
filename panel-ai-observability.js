'use strict';

// Optional Langfuse pilot, OTLP/HTTP JSON. Explicit opt-in; only operational
// metadata leaves MCS. Never send prompts, answers, names, phone numbers, refs,
// customer IDs, request bodies, provider errors or credentials in trace data.
const crypto = require('node:crypto');

function usageOf(result) {
  const usage = result?.payload?.usage || result?.usage || {};
  const input = usage.prompt_tokens ?? usage.inputTokens ?? usage.input_tokens ?? usage.input;
  const output = usage.completion_tokens ?? usage.outputTokens ?? usage.output_tokens ?? usage.output;
  const valid = (value) => Number.isFinite(Number(value)) && Number(value) >= 0;
  return { ...(valid(input) ? { input: Number(input) } : {}), ...(valid(output) ? { output: Number(output) } : {}) };
}

async function exportTrace(event, services = {}) {
  const env = services.env || process.env;
  if (env.LANGFUSE_ENABLED !== 'true' || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return false;
  try {
    const base = new URL(env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com');
    if (base.protocol !== 'https:') return false;
    const attribute = (key, value) => ({ key, value: { stringValue: String(value) } });
    const start = Number(event.startedAt), end = Number(event.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
    const attributes = [attribute('langfuse.observation.type', 'generation'),
      attribute('langfuse.observation.model.name', event.model), attribute('gen_ai.system', event.provider),
      attribute('langfuse.environment', event.environment), attribute('langfuse.trace.name', 'mcs.' + event.feature),
      attribute('langfuse.observation.metadata.feature', event.feature),
      attribute('langfuse.observation.metadata.costKind', event.costKind || 'estimated_token_usage'),
      attribute('langfuse.observation.level', event.ok ? 'DEFAULT' : 'ERROR')];
    if (Number.isFinite(event.costUsd)) attributes.push(attribute('langfuse.observation.cost_details', JSON.stringify({ total: event.costUsd })));
    const usage = usageOf(event.result);
    if (Object.keys(usage).length) attributes.push(attribute('langfuse.observation.usage_details', JSON.stringify(usage)));
    const payload = { resourceSpans: [{ resource: { attributes: [attribute('service.name', 'my-car-scout')] },
      scopeSpans: [{ scope: { name: 'mcs-ai-metadata' }, spans: [{ traceId: crypto.randomBytes(16).toString('hex'),
        spanId: crypto.randomBytes(8).toString('hex'), name: 'mcs.' + event.feature,
        startTimeUnixNano: (BigInt(Math.trunc(start)) * 1000000n).toString(),
        endTimeUnixNano: (BigInt(Math.trunc(end)) * 1000000n).toString(), attributes,
        status: { code: event.ok ? 1 : 2 } }] }] }] };
    const response = await (services.fetchImpl || fetch)(new URL('/api/public/otel/v1/traces', base), {
      method: 'POST', signal: AbortSignal.timeout(3000), headers: { 'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from(env.LANGFUSE_PUBLIC_KEY + ':' + env.LANGFUSE_SECRET_KEY).toString('base64'),
        'x-langfuse-ingestion-version': '4' }, body: JSON.stringify(payload)
    });
    return response.ok;
  } catch (_) { return false; }
}

function record(event, services = {}) {
  const env = services.env || process.env;
  if (env.LANGFUSE_ENABLED !== 'true' || !env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) return;
  // Preserve serverless lifetime without holding up the customer's suggestion.
  const task = exportTrace(event, services).catch(() => false);
  try { (services.waitUntil || require('@vercel/functions').waitUntil)(task); } catch (_) {}
}

module.exports = { record, exportTrace };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const unlock = require('../api/panel/unlock-sale');
const { INSTRUCTIONS, VERSION } = require('../panel-gpt-sale-guidance');
const { CASES, grade } = require('./fixtures/gpt-sale-cases');
const { exportEvaluation } = require('../scripts/evaluate-gpt-sale');

test('Claude keeps its exact previous instructions; only GPT uses the new guidance', () => {
  assert.equal(crypto.createHash('sha256').update(unlock.instructionsFor('Claude')).digest('hex'), 'bd289854c7b40c68aef385f042d8cff243c561cb331e6c5d49116114db83ad01');
  assert.equal(unlock.instructionsFor('OpenAI'), INSTRUCTIONS);
  assert.notEqual(unlock.instructionsFor('OpenAI'), unlock.instructionsFor('Claude'));
});

test('the existing two-card endpoint sends each provider its own instructions and version', async () => {
  const file = path.resolve(__dirname, '../api/panel/unlock-sale.js');
  const calls = [], versions = [];
  const answer = { titulo: 'Próxima etapa', acao: 'Apresentar opções', porque: 'Cliente pronto', mensagemPt: 'Vamos conferir as opções.', mensagemEn: 'Let us check the options.' };
  const stubs = {
    '../../panel-server': { requirePanel: async () => ({ environment: 'preview', panel: { id: 'test' } }),
      send: (_res, status, body) => ({ status, body }), jsonBody: async (req) => req.body,
      safeText: (value, limit) => String(value || '').slice(0, limit) },
    '../../panel-ai': { aiContextWindow: () => ({ messages: [] }), reserveCall: async () => {},
      anthropicJson: async (instructions) => { calls.push(['Claude', instructions]); return answer; } },
    '../../panel-lead': { leadData: async () => ({ ref: 'SYNTHETIC', batchActive: false, searchModes: ['CARRO'], wishes: [], record: { conversation: [] } }) },
    '../../panel-reply-guided': { openAiJson: async (body) => { calls.push(['OpenAI', body.instructions]); return { parsed: answer }; }, recordCost: async () => {} },
    '../../panel-reply-suggest': { model: () => 'gpt-6-luna' },
    '../../panel-openai-budget': { guard: () => ({}) },
    '../../panel-ai-feedback': { generated: async (_ctx, item) => { versions.push([item.provider, item.promptVersion]); return 'synthetic-suggestion'; } }
  };
  const sandbox = { module: { exports: {} }, process: { env: { OPENAI_API_KEY: 'test-key' } }, fetch: () => {},
    require: (name) => stubs[name] || require(path.resolve(path.dirname(file), name)), Date, Promise, Error, Set };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  const route = sandbox.module.exports;
  const both = await route({ method: 'POST', body: { ref: 'SYNTHETIC' } }, {});
  assert.equal(both.status, 200);
  assert.deepEqual(Array.from(both.body.options, (option) => option.provider), ['OpenAI', 'Claude']);
  assert.deepEqual(calls, [['OpenAI', INSTRUCTIONS], ['Claude', unlock.instructionsFor('Claude')]]);
  assert.deepEqual(versions, [['OpenAI', VERSION], ['Claude', 'destravar-v2']]);
  calls.length = 0;
  await route({ method: 'POST', body: { ref: 'SYNTHETIC', only: 'Claude' } }, {});
  assert.deepEqual(calls, [['Claude', unlock.instructionsFor('Claude')]], 'retrying Claude does not call GPT');
});

test('evaluation checks reject wrong search questions, multiple messages and premature deposits', () => {
  const answer = (mensagemEn) => ({ titulo: 'Ação', acao: 'Ação', porque: 'Fato', mensagemPt: 'Tradução', mensagemEn });
  assert.equal(grade(answer('What is your budget?'), CASES[0]).passed, false);
  assert.equal(grade(answer('What year and mileage do you want?'), CASES[1]).passed, false);
  assert.equal(grade(answer('Mensagem 1: Hi. Mensagem 2: What do you think?'), CASES[0]).passed, false);
  assert.equal(grade(answer('Send the deposit and we will place your bid.'), CASES[7]).passed, false);
  assert.equal(grade(answer('I will show you the options first. Once you approve a car and its bid limit, we can discuss the deposit.'), CASES[7]).passed, true);
});

test('Langfuse evaluation exports only case metadata, cost and a score; no answer content', async () => {
  const requests = [];
  const event = { provider: 'openai', model: 'gpt-6-luna', feature: 'GPT_EVAL_CANDIDATE', environment: 'test', startedAt: 100, endedAt: 200, ok: true, costUsd: 0.0002, result: { usage: { inputTokens: 10, outputTokens: 20 } } };
  const result = { caseId: CASES[0].id, version: VERSION, passed: true, failures: [], response: { mensagemEn: 'Private content never exported' } };
  const env = { LANGFUSE_ENABLED: 'true', LANGFUSE_BASE_URL: 'https://cloud.langfuse.com', LANGFUSE_PUBLIC_KEY: 'public-test', LANGFUSE_SECRET_KEY: 'secret-test' };
  await exportEvaluation(event, result, env, async (url, options) => { requests.push({ url: String(url), body: JSON.parse(options.body) }); return { ok: true }; });
  assert.equal(requests.length, 2);
  const span = requests[0].body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(requests[1].body.traceId, span.traceId);
  assert.equal(requests[1].body.observationId, span.spanId);
  assert.equal(requests[1].body.value, 1);
  assert.ok(!JSON.stringify(requests).includes('Private content'));
  assert.ok(!JSON.stringify(requests).includes('secret-test'));
});

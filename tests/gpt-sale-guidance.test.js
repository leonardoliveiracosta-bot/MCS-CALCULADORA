'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const unlock = require('../api/panel/unlock-sale');
const { INSTRUCTIONS, VERSION, prepareAnswer } = require('../panel-gpt-sale-guidance');
const { CASES, grade } = require('../scripts/gpt-sale-cases');
const { exportEvaluation } = require('../scripts/evaluate-gpt-sale');

test('Claude keeps its exact approved instructions (v3, with the shared sale posture); GPT uses its own guidance', () => {
  assert.equal(crypto.createHash('sha256').update(unlock.instructionsFor('Claude')).digest('hex'), '7bec6a71926bcae031a3e119fb694630aa343ae22359a36ea8c74d8c30a54cc2');
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
  assert.deepEqual(versions, [['OpenAI', VERSION], ['Claude', 'destravar-v3']]);
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
  assert.equal(grade(answer("I won’t place a bid without your approval."), CASES[7]).passed, true);
  assert.equal(grade(answer("I won’t place a bid without your approval. Send the deposit."), CASES[7]).passed, false);
  assert.equal(grade(answer("I can’t guarantee a Civic for $7,000, reserve one, or confirm it’s mechanically perfect; I can check options."), CASES[5]).passed, true);
  assert.equal(grade(answer("I can’t guarantee the price, but it is mechanically perfect."), CASES[5]).passed, false);
  assert.equal(grade(answer('I have your Civic request with a $10,000 max bid. Are you ready to move forward?'), CASES[4]).passed, true);
  assert.equal(grade(answer('Are you ready to move forward?'), CASES[4]).passed, false);
  assert.equal(grade(answer("I've updated your search to a BMW X6."), CASES[6]).passed, false);
  assert.equal(grade(answer('I will show you the options first. Once you approve a car and its bid limit, we can discuss the deposit.'), CASES[7]).passed, true);
});

test('GPT messages remove dash punctuation while preserving numeric ranges and translated values', () => {
  const prepared = prepareAnswer({ mensagemEn: '2020–2022, $10,000–$13,000 — here are the limits.', mensagemPt: '2020–2022, $10.000–$13.000 — estes são os limites.', acao: 'Não alterada' });
  assert.equal(prepared.mensagemEn, '2020-2022, $10,000-$13,000, here are the limits.');
  assert.equal(prepared.mensagemPt, '2020-2022, $10.000-$13.000, estes são os limites.');
  assert.equal(prepared.acao, 'Não alterada');
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

test('postura de venda: as duas IAs conduzem e sugerem, e não pedem para o cliente confirmar o que já disse', () => {
  const { SALE_POSTURE } = require('../panel-sale-posture');
  for (const provider of ['OpenAI', 'Claude']) {
    const text = unlock.instructionsFor(provider);
    assert.ok(text.includes(SALE_POSTURE), provider + ' recebe a mesma postura de venda');
    assert.doesNotMatch(text, /esclare[cç](?:a|er essa) (?:a )?diverg[eê]ncia/i, provider + ' não manda esclarecer divergência com o cliente');
    assert.doesNotMatch(text, /imagine a prov[aá]vel resposta/i, provider + ' não inventa resposta do cliente');
  }
  // A Tundra: ficha com US$ 10.000 e simulação mais recente com US$ 25.000. Perguntar qual vale reprova; seguir com o atual passa.
  const scenario = CASES.find((item) => item.id === 'lance-divergente');
  const answer = (mensagemEn) => ({ titulo: 'Ação', acao: 'Ação', porque: 'Ficha tem 10 mil, simulação nova 25 mil', mensagemPt: 'Tradução', mensagemEn });
  assert.equal(grade(answer('Our record also shows a $10,000 maximum. Which maximum bid should we use for the Tundra?'), scenario).passed, false);
  assert.equal(grade(answer('Can you confirm your max bid for the Tundra?'), scenario).passed, false);
  assert.equal(grade(answer('Working with your $25,000 max, I will line up the best 2021 and 2022 Tundras running at auction this week and send them to you today.'), scenario).passed, true);
});

test('o texto que vai ao cliente sai sem rótulo "Message 1:" e sem travessão, também no card do Claude', () => {
  const { clientText } = require('../panel-gpt-sale-guidance');
  assert.equal(clientText('Message 1:\nVinayak, I found solid options right now — let me show you.\n\nMessage 2:\nHere is the plan'), 'Vinayak, I found solid options right now, let me show you.\n\nHere is the plan');
  assert.equal(clientText('Mensagem 1: Oi\n\n\n\nMensagem 2: Tudo certo'), 'Oi\n\nTudo certo');
  // Caminho comum: texto sem rótulo e sem travessão passa igual.
  assert.equal(clientText('I will send the options today.'), 'I will send the options today.');
  const file = fs.readFileSync(path.resolve(__dirname, '../api/panel/unlock-sale.js'), 'utf8');
  assert.match(file, /clean\(gptGuidance\.prepareAnswer\(await anthropicJson\(SALES/);
});

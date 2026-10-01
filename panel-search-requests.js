'use strict';

// PESQUISAS no servidor: lê conversas em pedidos de veículo, compara pedidos com o lote ativo e
// monta a lista de trabalho. Regras em vehicle-requests.js.
//  * Leitura: fora de produção é sempre o simulador local (nenhuma chamada paga). Em produção só lê
//    com SEARCH_EXTRACTION_AI_ENABLED=1, OPENAI_API_KEY e um modelo aprovado em
//    SEARCH_EXTRACTION_MODEL; sem isso a leitura fica desligada. Nenhuma outra flag liga isto.
//  * A mesma conversa com o mesmo conteúdo e a mesma regra nunca é lida duas vezes.
//  * Comparação: só o lote realmente ativo (ativado, não desfeito, não cancelado), só carros com
//    MMR válido, pelas regras atuais do matcher. O resultado fica gravado e auditável.
const crypto = require('node:crypto');
const { allRows, insert, patchRows, rows } = require('./panel-server');
const { latestActiveUpload } = require('./panel-manheim-state');
const requests = require('./vehicle-requests');
const catalog = require('./vehicle-catalog');
const { makeKey } = require('./panel-manheim-batch');

// US$ per 1M tokens (standard tier). Same approved list as the ENTRADA triage.
const PRICES = Object.freeze({ 'gpt-6-luna': { input: 0.10, output: 0.50 }, 'gpt-5.4-nano': { input: 0.20, output: 1.25 } });
// Default wait for one reading (safe inside a 30 s function). Callers with more time pass
// options.timeoutMs (the history routine gives up to LONG_TIMEOUT_MS when its window allows).
const TIMEOUT_MS = 20000;
const LONG_TIMEOUT_MS = 40000;
// The historical audit has a cumulative ceiling of US$ 50 (no credit is ever added). A call only
// starts when even an unusually large reading (MAX_CALL_USD, far above a real one) still fits.
const PROVIDER_LIMIT_USD = Object.freeze({ OPENAI: 50 });
const MAX_CALL_USD = 0.01;
const HISTORY_SINCE = '2026-08-09T00:00:00Z';

function extractionStatus(env = process.env) {
  if (env.VERCEL_ENV !== 'production') return 'SIMULADA';
  if (env.SEARCH_EXTRACTION_AI_ENABLED !== '1') return 'DESLIGADA';
  if (!env.OPENAI_API_KEY) return 'SEM_CHAVE';
  if (!PRICES[String(env.SEARCH_EXTRACTION_MODEL || '')]) return 'MODELO_INVALIDO';
  return 'LIGADA';
}
const estimateCostUsd = (model, input, output) => { const price = PRICES[model]; return price ? Math.round(((input || 0) * price.input + (output || 0) * price.output)) / 1e6 : null; };
const tableMissing = (error) => error && (error.status === 404 || /PGRST205|42P01/.test(String(error.code || '') + String(error.message || '')));

// ------------------------------------------------------------------ leitura por IA (desligada)
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['hasRequest', 'requests'],
  properties: {
    hasRequest: { type: 'boolean' },
    requests: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['make', 'model', 'trim', 'yearMin', 'yearMax', 'minMiles', 'maxMiles', 'budgetUsd', 'location', 'notes', 'evidence', 'confidence', 'reviewReason'],
      properties: {
        make: { type: ['string', 'null'] }, model: { type: ['string', 'null'] }, trim: { type: ['string', 'null'] },
        yearMin: { type: ['integer', 'null'] }, yearMax: { type: ['integer', 'null'] }, minMiles: { type: ['integer', 'null'] }, maxMiles: { type: ['integer', 'null'] },
        budgetUsd: { type: ['integer', 'null'] }, location: { type: ['string', 'null'] }, notes: { type: ['string', 'null'] },
        evidence: { type: 'object', additionalProperties: false, required: requests.FIELDS, properties: Object.fromEntries(requests.FIELDS.map((field) => [field, { type: 'array', items: { type: 'string' } }])) },
        confidence: { type: 'string', enum: ['alta', 'media', 'baixa'] }, reviewReason: { type: ['string', 'null'] }
      } } }
  }
};
const INSTRUCTIONS = [
  'Você lê uma conversa de WhatsApp da My Car Scout (compra de carros em leilões de concessionárias nos EUA) e diz se o CLIENTE pediu um veículo.',
  'Devolva só o que o cliente escreveu. Nunca invente marca, modelo, ano, versão, milhagem, orçamento, localização ou preferência. Um campo não informado é null.',
  'Cada campo informado precisa dos ids das mensagens do CLIENTE onde ele aparece, em evidence. Mensagens da MCS e automáticas nunca são evidência.',
  'Um cliente pode pedir mais de um veículo: um item por veículo. Se ele mudou o pedido depois, use o pedido mais recente e cite as mensagens novas.',
  'Não deduza desistência. Comprar daqui a meses continua sendo um pedido. Não classifique o cliente, só leia o pedido.',
  'hasRequest=false quando a conversa não tem pedido de veículo. confidence "alta" só quando o pedido é claro; reviewReason explica a dúvida em uma frase, em português.'
].join('\n');

// The provider's answer to a failed call, as a safe code. A model the key cannot use stops the
// audit (no other model is tried); the provider's own limit (quota or balance) stops it safely.
async function failureOf(response) {
  const detail = await response.json().catch(() => null);
  const code = String(detail?.error?.code || detail?.error?.type || '');
  const failure = new Error('OPENAI_FAILED');
  if (response.status === 404 || /model_not_found|does not exist|do not have access/i.test(code + ' ' + String(detail?.error?.message || ''))) failure.code = 'OPENAI_MODEL_UNAVAILABLE';
  else if ((response.status === 429 && /insufficient_quota|billing/i.test(code)) || response.status === 402) failure.code = 'OPENAI_QUOTA';
  else failure.code = response.status === 429 ? 'OPENAI_RATE_LIMIT' : response.status === 401 ? 'OPENAI_KEY_INVALID' : 'OPENAI_FAILED';
  return failure;
}
// options.guard: the reservation of the US$ 50 OpenAI ceiling (panel-openai-budget.paidCall).
async function openAiChat(body, options = {}) {
  const env = options.env || process.env;
  const modelId = env.SEARCH_EXTRACTION_MODEL;
  return require('./panel-openai-budget').paidCall(options.guard, { modelId, body: { model: modelId, ...body }, send: (capped) => openAiSend(capped, options) });
}
async function openAiSend(fullBody, options = {}) {
  const env = options.env || process.env;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: JSON.stringify(fullBody)
    });
    if (!response.ok) throw await failureOf(response);
    const payload = await response.json();
    const usage = { input: Number(payload?.usage?.prompt_tokens) || 0, output: Number(payload?.usage?.completion_tokens) || 0 };
    return { payload, model: env.SEARCH_EXTRACTION_MODEL, usage, costUsd: estimateCostUsd(env.SEARCH_EXTRACTION_MODEL, usage.input, usage.output) };
  } catch (failure) {
    if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
    throw failure;
  } finally { clearTimeout(timer); }
}
// One minimal call with the configured model and no customer data, before any real conversation
// is sent. Only in production with the flag on; the Preview never calls anything.
async function checkModel(options = {}) {
  const env = options.env || process.env;
  if (extractionStatus(env) !== 'LIGADA') { const failure = new Error('EXTRACTION_AI_DISABLED'); failure.code = 'EXTRACTION_AI_DISABLED'; throw failure; }
  const out = await openAiChat({ messages: [{ role: 'user', content: 'Teste de disponibilidade do modelo. Responda apenas: ok' }] }, options);
  return { model: out.model, usage: out.usage, costUsd: out.costUsd };
}

async function readWithAi(conversation, options = {}) {
  const env = options.env || process.env;
  if (extractionStatus(env) !== 'LIGADA') { const failure = new Error('EXTRACTION_AI_DISABLED'); failure.code = 'EXTRACTION_AI_DISABLED'; throw failure; }
  const out = await openAiChat({ messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: JSON.stringify({ mensagens: conversation.map((item) => ({ id: item.id, de: item.from, texto: item.text })) }) }],
    response_format: { type: 'json_schema', json_schema: { name: 'pedido_de_veiculo', strict: true, schema: SCHEMA } } }, { ...options, env });
  let parsed = null;
  try { parsed = JSON.parse(out.payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
  return { raw: parsed, model: out.model, usage: out.usage, costUsd: out.costUsd };
}

async function conversationOf(ctx, chatId, services) {
  const messages = await services.allRows(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chatId, order: 'id.asc' });
  return requests.conversationFor(messages);
}

// Reads one conversation. dryRun: nothing is written (the Preview sample). Otherwise the run,
// the requests and their versions are stored; a new reading of a changed conversation adds a
// version and never deletes the previous one.
// Readings of the same content that may fail before the conversation is left for a person.
const MAX_FAILED_READS = 3;
async function extractChat(ctx, chatId, options = {}) {
  const services = { allRows, rows, insert, patchRows, ...(options.services || {}) };
  const env = options.env || process.env;
  const status = extractionStatus(env);
  if (status !== 'SIMULADA' && status !== 'LIGADA') return { status, skipped: true };
  const [chat] = await services.rows(ctx, 'chats', { select: 'id,contact_id,is_group,channel', environment: 'eq.' + ctx.environment, id: 'eq.' + chatId, limit: '1' });
  if (!chat) return { status, error: 'CHAT_NOT_FOUND' };
  const conversation = await conversationOf(ctx, chatId, services);
  const hash = requests.inputHash(conversation);
  const provider = status === 'LIGADA' ? 'OPENAI' : 'SIMULATED';
  let failedRun = null;
  if (!options.dryRun) {
    // A failed reading (timeout, provider error) is tried again, up to MAX_FAILED_READS times for the
    // same content; before, one failure counted as read and the conversation stayed pending forever.
    // There is one run per content (unique key): a retry updates the failed run and counts attempts.
    [failedRun] = (await services.rows(ctx, 'vehicle_request_runs', { select: 'id,status,attempts', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chatId, input_hash: 'eq.' + hash, rule_version: 'eq.' + requests.RULE_VERSION, provider: 'eq.' + provider, limit: '1' })) || [];
    if (failedRun && failedRun.status !== 'FAILED') return { status, alreadyRead: true, runId: failedRun.id };
    if (failedRun && (Number(failedRun.attempts) || 1) >= MAX_FAILED_READS) return { status, alreadyRead: true, gaveUp: true, runId: failedRun.id };
  }
  // A paid reading: one caller per conversation content (cron and button at the same time), and the
  // US$ 50 OpenAI reservation around the call.
  const claims = options.claims || require('./panel-ai-claim');
  const task = provider === 'OPENAI' && !options.dryRun ? await claims.claimTask(ctx, { kind: 'PESQUISAS', subject: chatId, hash, rule: requests.RULE_VERSION }) : null;
  if (task && !task.claimed) return { status, inProgress: true };
  const guard = provider === 'OPENAI' ? require('./panel-openai-budget').guard(ctx, 'PESQUISAS', chatId, options.budgetServices) : null;
  let reading;
  try {
    reading = provider === 'OPENAI' ? await (options.readWithAi || readWithAi)(conversation, { env, guard, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs }) : { raw: requests.simulateExtraction(conversation), model: null, usage: null, costUsd: 0 };
  } catch (failure) {
    if (task) await claims.finishTask(ctx, task, false).catch(() => null);
    if (options.dryRun) return { status, error: failure.code || 'EXTRACTION_FAILED' };
    const failed = { model: env.SEARCH_EXTRACTION_MODEL || null, messages_read: conversation.length, status: 'FAILED', error_code: failure.code || 'EXTRACTION_FAILED', created_by: ctx.panel?.id || null };
    if (failedRun) await services.patchRows(ctx, 'vehicle_request_runs', { environment: 'eq.' + ctx.environment, id: 'eq.' + failedRun.id, status: 'eq.FAILED' }, { ...failed, attempts: (Number(failedRun.attempts) || 1) + 1, created_at: new Date().toISOString() });
    else await services.insert(ctx, 'vehicle_request_runs', { environment: ctx.environment, chat_id: chatId, contact_id: chat.contact_id, provider, rule_version: requests.RULE_VERSION, input_hash: hash, ...failed }, false);
    return { status, error: failure.code || 'EXTRACTION_FAILED' };
  }
  const checked = requests.validateExtraction(reading.raw, conversation);
  const evidenceText = new Map(conversation.map((item) => [item.id, item]));
  if (options.dryRun) return { status, provider, messagesRead: conversation.length, ...checked, evidence: [...new Set(checked.requests.flatMap((item) => Object.values(item.evidence).flat()))].map((id) => evidenceText.get(id)) };
  let run;
  try {
    const done = { model: reading.model, messages_read: conversation.length, status: checked.requests.length ? 'DONE' : 'NO_REQUEST', request_count: checked.requests.length, error_code: checked.errorCode,
      input_tokens: reading.usage?.input ?? null, output_tokens: reading.usage?.output ?? null, cost_usd: reading.costUsd ?? null, created_by: ctx.panel?.id || null };
    // A retry that worked turns the failed run into the reading (same content, same row).
    if (failedRun) [run] = await services.patchRows(ctx, 'vehicle_request_runs', { environment: 'eq.' + ctx.environment, id: 'eq.' + failedRun.id, status: 'eq.FAILED' }, { ...done, created_at: new Date().toISOString() }, true);
    else [run] = await services.insert(ctx, 'vehicle_request_runs', { environment: ctx.environment, chat_id: chatId, contact_id: chat.contact_id, provider, rule_version: requests.RULE_VERSION, input_hash: hash, ...done });
    if (!run) throw Object.assign(new Error('RUN_NOT_SAVED'), { code: 'RUN_NOT_SAVED' });
  } catch (error) {
    // The cost stays on the reservation (it keeps counting in the US$ 50); the reading is done: a
    // new call for the same content would pay twice.
    if (task) await claims.finishTask(ctx, task, true).catch(() => null);
    throw error;
  }
  // The cost is on the run now.
  await require('./panel-openai-budget').recorded(guard);
  if (task) await claims.finishTask(ctx, task, true).catch(() => null);
  const existing = await services.rows(ctx, 'vehicle_requests', { select: 'id,request_key', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chatId });
  const byKey = new Map(existing.map((row) => [row.request_key, row]));
  for (const item of checked.requests) {
    let request = byKey.get(item.requestKey);
    if (!request) {
      [request] = await services.insert(ctx, 'vehicle_requests', { environment: ctx.environment, chat_id: chatId, contact_id: chat.contact_id, request_key: item.requestKey });
      byKey.set(item.requestKey, request);
    }
    const [last] = await services.rows(ctx, 'vehicle_request_versions', { select: 'criteria_hash,needs_review', environment: 'eq.' + ctx.environment, request_id: 'eq.' + request.id, order: 'created_at.desc', limit: '1' });
    // Same criteria as before: nothing new to record for this request.
    if (last && last.criteria_hash === item.criteriaHash && last.needs_review === item.needsReview) continue;
    await services.insert(ctx, 'vehicle_request_versions', { environment: ctx.environment, request_id: request.id, run_id: run.id, criteria_json: item.criteria, missing_fields: item.missing,
      evidence_json: item.evidence, confidence: item.confidence, needs_review: item.needsReview, review_reason: item.reviewReason, criteria_hash: item.criteriaHash }, false);
    await services.patchRows(ctx, 'vehicle_requests', { environment: 'eq.' + ctx.environment, id: 'eq.' + request.id }, { updated_at: new Date().toISOString() });
  }
  // Requests of earlier readings that did not come back are kept as they were (no deduced withdrawal).
  return { status, provider, runId: run.id, requests: checked.requests.length, errorCode: checked.errorCode, usage: reading.usage || null, costUsd: reading.costUsd || 0 };
}

// ------------------------------------------------------------------ comparação com o lote ativo
// Cars of the active batch for one make, read once per comparison round (valid MMR only).
async function vehiclesForMake(ctx, uploadId, key, cache, services) {
  if (cache.has(key)) return cache.get(key);
  const found = await services.allRows(ctx, 'manheim_vehicles', { select: 'row_fingerprint,vehicle_json', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId, make_key: 'eq.' + key, undone_at: 'is.null', mmr_cents: 'not.is.null' });
  cache.set(key, found);
  return found;
}
// Makes whose cars can match: the one informed, or the make(s) the catalog gives for the model.
function makeKeysOf(criteria) {
  const c = criteria || {};
  if (c.make) return [makeKey(c.make)].filter(Boolean);
  if (!c.model) return [];
  const found = catalog.inferMake(c.model);
  return (found.candidates && found.candidates.length ? found.candidates : [found.make]).map(makeKey).filter(Boolean);
}
async function compareOne(ctx, uploadId, item, cache, services) {
  if (item.completeness === 'PRECISA_REVISAO') return { result: 'NEEDS_REVIEW', count: 0, sample: [] };
  if (!item.comparable) return { result: 'INSUFFICIENT', count: 0, sample: [] };
  const sample = [];
  let count = 0;
  const take = (row) => { count += 1; if (sample.length < 5) sample.push(row.row_fingerprint); };
  // A demand with the official calculation (Ref): the current matcher, as in OPÇÕES.
  if (item.targets && item.targets.length) {
    const keys = new Set();
    item.targets.forEach((target) => target.wishes.forEach((wish) => { const key = makeKey(wish.make) || makeKey(catalog.inferMake(wish.model).make); if (key) keys.add(key); }));
    for (const key of keys) for (const row of await vehiclesForMake(ctx, uploadId, key, cache, services)) if (requests.optionFor(row.vehicle_json, item.targets)) take(row);
    return { result: count ? 'HAS_OPTIONS' : 'NO_OPTIONS', count, sample };
  }
  // A ready request without the official matcher: model, year and mileage as informed, never the
  // value as an MMR filter. CARRO: the vehicle, year and mileage decide, so a fit is an option.
  // VALOR: without the official bid a fit is a candidate whose value is still to be checked.
  const c = item.criteria || {};
  for (const key of makeKeysOf(c)) for (const row of await vehiclesForMake(ctx, uploadId, key, cache, services)) if (requests.fitsReady(row.vehicle_json, c)) take(row);
  return { result: !count ? 'NO_OPTIONS' : item.searchMode === 'CARRO' ? 'HAS_OPTIONS' : 'HAS_CANDIDATES', count, sample };
}
// Compares the given items (FALTA BUSCAR) with the active batch and records each result.
async function compareItems(ctx, items, options = {}) {
  const services = { allRows, rows, insert, ...(options.services || {}) };
  const upload = await latestActiveUpload(ctx, 'id', services.stateServices);
  if (!upload) return { uploadId: null, compared: 0 };
  const cache = new Map();
  const results = [];
  // A large batch (tens of thousands of cars) makes each make heavy to read: stop before the
  // function's time limit and let the next round continue (at least one item per round).
  const deadlineAt = Number(options.deadlineAt) || Infinity;
  // One request that fails (bad criteria, a read that errors) never stops the others: it is left
  // in FALTA BUSCAR, logged by key only, and the round goes on.
  const failed = [];
  for (const item of items) {
    if ((results.length || failed.length) && Date.now() >= deadlineAt) break;
    try {
      const outcome = await compareOne(ctx, upload.id, item, cache, services);
      await services.upsertCheck(ctx, { environment: ctx.environment, request_key: item.key, criteria_hash: item.criteriaHash, upload_id: upload.id, result: outcome.result,
        option_count: outcome.count, sample_fingerprints: outcome.sample, compared_by: ctx.panel?.id || null });
      results.push({ key: item.key, ...outcome });
    } catch (error) {
      failed.push(item.key);
      console.error('[pesquisas] comparação falhou', item.key, String(error && (error.code || error.message) || error).slice(0, 200));
    }
  }
  return { uploadId: upload.id, compared: results.length, failed, results };
}

module.exports = { LONG_TIMEOUT_MS, MAX_FAILED_READS, openAiChat, HISTORY_SINCE, MAX_CALL_USD, PRICES, PROVIDER_LIMIT_USD, checkModel, makeKeysOf, compareItems, compareOne, conversationOf, estimateCostUsd, extractChat, extractionStatus, readWithAi, tableMissing };

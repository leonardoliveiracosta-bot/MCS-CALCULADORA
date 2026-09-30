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
const { allRows, insert, patchRows, rows, rpc } = require('./panel-server');
const { latestActiveUpload } = require('./panel-manheim-state');
const requests = require('./vehicle-requests');
const catalog = require('./vehicle-catalog');
const { makeKey } = require('./panel-manheim-batch');

// US$ per 1M tokens (standard tier). Same approved list as the ENTRADA triage.
const PRICES = Object.freeze({ 'gpt-6-luna': { input: 0.10, output: 0.50 }, 'gpt-5.4-nano': { input: 0.20, output: 1.25 } });
const TIMEOUT_MS = 20000;
// The reading of the history uses at most the balance already available in each AI provider:
// US$ 50 per provider. No credit is added and no lower internal ceiling is created.
const PROVIDER_LIMIT_USD = Object.freeze({ OPENAI: 50 });
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

async function readWithAi(conversation, options = {}) {
  const env = options.env || process.env;
  if (extractionStatus(env) !== 'LIGADA') { const failure = new Error('EXTRACTION_AI_DISABLED'); failure.code = 'EXTRACTION_AI_DISABLED'; throw failure; }
  const model = env.SEARCH_EXTRACTION_MODEL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl || fetch)('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: JSON.stringify({ mensagens: conversation.map((item) => ({ id: item.id, de: item.from, texto: item.text })) }) }],
        response_format: { type: 'json_schema', json_schema: { name: 'pedido_de_veiculo', strict: true, schema: SCHEMA } } })
    });
    if (!response.ok) {
      // The provider's own limit (quota or balance) stops the reading safely; the rest stays pending.
      const detail = await response.json().catch(() => null);
      const quota = response.status === 429 && /insufficient_quota|billing/i.test(String(detail?.error?.code || detail?.error?.type || ''));
      const failure = new Error('OPENAI_FAILED'); failure.code = quota || response.status === 402 ? 'OPENAI_QUOTA' : response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_FAILED'; throw failure;
    }
    const payload = await response.json();
    const usage = { input: Number(payload?.usage?.prompt_tokens) || 0, output: Number(payload?.usage?.completion_tokens) || 0 };
    let parsed = null;
    try { parsed = JSON.parse(payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
    return { raw: parsed, model, usage, costUsd: estimateCostUsd(model, usage.input, usage.output) };
  } catch (failure) {
    if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
    throw failure;
  } finally { clearTimeout(timer); }
}

async function conversationOf(ctx, chatId, services) {
  const messages = await services.allRows(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chatId, order: 'id.asc' });
  return requests.conversationFor(messages);
}

// Reads one conversation. dryRun: nothing is written (the Preview sample). Otherwise the run,
// the requests and their versions are stored; a new reading of a changed conversation adds a
// version and never deletes the previous one.
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
  if (!options.dryRun) {
    const [previous] = await services.rows(ctx, 'vehicle_request_runs', { select: 'id,status', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chatId, input_hash: 'eq.' + hash, rule_version: 'eq.' + requests.RULE_VERSION, provider: 'eq.' + provider, limit: '1' });
    if (previous) return { status, alreadyRead: true, runId: previous.id };
  }
  let reading;
  try {
    reading = provider === 'OPENAI' ? await (options.readWithAi || readWithAi)(conversation, { env }) : { raw: requests.simulateExtraction(conversation), model: null, usage: null, costUsd: 0 };
  } catch (failure) {
    if (options.dryRun) return { status, error: failure.code || 'EXTRACTION_FAILED' };
    await services.insert(ctx, 'vehicle_request_runs', { environment: ctx.environment, chat_id: chatId, contact_id: chat.contact_id, provider, model: env.SEARCH_EXTRACTION_MODEL || null, rule_version: requests.RULE_VERSION, input_hash: hash, messages_read: conversation.length, status: 'FAILED', error_code: failure.code || 'EXTRACTION_FAILED', created_by: ctx.panel?.id || null }, false);
    return { status, error: failure.code || 'EXTRACTION_FAILED' };
  }
  const checked = requests.validateExtraction(reading.raw, conversation);
  const evidenceText = new Map(conversation.map((item) => [item.id, item]));
  if (options.dryRun) return { status, provider, messagesRead: conversation.length, ...checked, evidence: [...new Set(checked.requests.flatMap((item) => Object.values(item.evidence).flat()))].map((id) => evidenceText.get(id)) };
  const [run] = await services.insert(ctx, 'vehicle_request_runs', { environment: ctx.environment, chat_id: chatId, contact_id: chat.contact_id, provider, model: reading.model, rule_version: requests.RULE_VERSION, input_hash: hash,
    messages_read: conversation.length, status: checked.requests.length ? 'DONE' : 'NO_REQUEST', request_count: checked.requests.length, error_code: checked.errorCode,
    input_tokens: reading.usage?.input ?? null, output_tokens: reading.usage?.output ?? null, cost_usd: reading.costUsd ?? null, created_by: ctx.panel?.id || null });
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
  // A complete demand of the ficha: the current matcher, as in OPÇÕES.
  if (item.targets && item.targets.length) {
    const keys = new Set();
    item.targets.forEach((target) => target.wishes.forEach((wish) => { const key = makeKey(wish.make) || makeKey(catalog.inferMake(wish.model).make); if (key) keys.add(key); }));
    for (const key of keys) for (const row of await vehiclesForMake(ctx, uploadId, key, cache, services)) if (requests.optionFor(row.vehicle_json, item.targets)) take(row);
    return { result: count ? 'HAS_OPTIONS' : 'NO_OPTIONS', count, sample };
  }
  // A partial request: only what was informed. With a make or model, the cars of that make; with
  // neither, the database counts the whole batch by year, mileage and budget.
  const c = item.criteria || {};
  const keys = makeKeysOf(c);
  if (keys.length) {
    for (const key of keys) for (const row of await vehiclesForMake(ctx, uploadId, key, cache, services)) if (requests.fitsPartial(row.vehicle_json, c)) take(row);
    return { result: count ? 'HAS_OPTIONS' : 'NO_OPTIONS', count, sample };
  }
  const scan = await services.scan(ctx, { p_environment: ctx.environment, p_upload_id: uploadId, p_year_min: c.yearMin || null, p_year_max: c.yearMax || null,
    p_min_miles: c.minMiles || null, p_max_miles: c.maxMiles || null, p_max_mmr_cents: c.budgetUsd ? c.budgetUsd * 100 : null });
  const total = Number(scan && scan.count) || 0;
  return { result: total ? 'HAS_OPTIONS' : 'NO_OPTIONS', count: total, sample: (scan && scan.sample) || [] };
}
// Compares the given items (FALTA BUSCAR) with the active batch and records each result.
async function compareItems(ctx, items, options = {}) {
  const services = { allRows, rows, insert, scan: (ctx2, args) => rpc(ctx2, 'panel_vehicle_request_scan', args), ...(options.services || {}) };
  const upload = await latestActiveUpload(ctx, 'id', services.stateServices);
  if (!upload) return { uploadId: null, compared: 0 };
  const cache = new Map();
  const results = [];
  for (const item of items) {
    const outcome = await compareOne(ctx, upload.id, item, cache, services);
    await services.upsertCheck(ctx, { environment: ctx.environment, request_key: item.key, criteria_hash: item.criteriaHash, upload_id: upload.id, result: outcome.result,
      option_count: outcome.count, sample_fingerprints: outcome.sample, compared_by: ctx.panel?.id || null });
    results.push({ key: item.key, ...outcome });
  }
  return { uploadId: upload.id, compared: results.length, results };
}

module.exports = { HISTORY_SINCE, PRICES, PROVIDER_LIMIT_USD, makeKeysOf, compareItems, compareOne, conversationOf, estimateCostUsd, extractChat, extractionStatus, readWithAi, tableMissing };

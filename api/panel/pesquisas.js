'use strict';

// PESQUISAS: a lista diária de pedidos de veículo, sem lote, sem upload e sem cartões de opções.
//  GET                 pedidos (ficha, calculadora e conversas lidas), com estado e evidências
//  GET ?view=audit     auditoria desde 09/08/2026 e estimativa da leitura do histórico (só leitura)
//  POST compare        compara só os pedidos PRONTO PARA BUSCAR (modelo + valor + ano ou milhagem)
//                      ainda em FALTA BUSCAR com o lote ativo e grava o resultado
//  POST extract        lê uma conversa (simulada fora de produção; em produção só com a flag nova)
//  POST sample         leitura simulada de uma conversa sem gravar nada
//  POST extract_history próximas conversas do histórico (retomável; até US$ 50 por provedor de IA)
// Nenhum pedido sai da lista por estágio, previsão de compra, prazo ou classificação comercial.
// "Sem opção no lote" continua na lista para a próxima importação. Nada é enviado a ninguém.
const crypto = require('node:crypto');
const { allRows, insert, isUuid, jsonBody, requirePanel, rows, send, supabase } = require('../../panel-server');
const { loadBuscasBase, demandPerson, matchTarget, upper } = require('../../panel-buscas');
const { latestActiveUpload } = require('../../panel-manheim-state');
const { criteriaHash: targetHash } = require('../../panel-manheim-batch');
const requests = require('../../vehicle-requests');
const search = require('../../panel-search-requests');

const COMPARE_BATCH = 40;
const safe = (promise, fallback) => promise.catch((error) => { if (search.tableMissing(error)) return fallback; throw error; });
const wishText = (demand) => (demand.wishes || []).map((wish) => {
  const parts = [[wish.make, wish.model, wish.trim].filter(Boolean).join(' ') || 'Veículo não informado'];
  if (wish.yearMin || wish.yearMax) parts.push(`${wish.yearMin || '?'} a ${wish.yearMax || '?'}`);
  const miles = (value) => value ? Number(value).toLocaleString('en-US') : '?';
  if (wish.minMiles || wish.maxMiles) parts.push(`${miles(wish.minMiles)} a ${miles(wish.maxMiles)} milhas`);
  return parts.join(' · ');
}).join(' | ') + (demand.mode === 'VALOR' && demand.bidCents ? ` · lance US$ ${Math.round(demand.bidCents / 100).toLocaleString('en-US')}` : '');

// Every request of the operation, from the ficha, the calculator and the read conversations.
async function buildList(ctx) {
  const [base, upload] = await Promise.all([loadBuscasBase(ctx, { allRows }), latestActiveUpload(ctx, 'id,uploaded_at')]);
  const uploadId = upload ? upload.id : null;
  const [summary, snapshot, checks, conversation] = await Promise.all([
    uploadId ? supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_manheim_batch_summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment, p_upload_id: uploadId }) }).catch(() => []) : [],
    uploadId ? rows(ctx, 'manheim_uploads', { select: 'targets_json', environment: 'eq.' + ctx.environment, id: 'eq.' + uploadId, limit: '1' }).then((found) => found[0]?.targets_json || []).catch(() => []) : [],
    uploadId ? safe(allRows(ctx, 'vehicle_request_checks', { select: 'request_key,criteria_hash,upload_id,result,option_count,compared_at', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId }), null) : [],
    loadConversationRequests(ctx)
  ]);
  const checkByKey = new Map((checks || []).map((row) => [row.request_key + '|' + row.criteria_hash, row]));
  const summaryByKey = new Map((summary || []).map((row) => [row.demand_key, row]));
  const importedHash = new Map((Array.isArray(snapshot) ? snapshot : []).map((target) => [target.key, target.criteriaHash]));
  const lastCustomer = lastCustomerByJourney(base);
  const items = [];
  // Ficha and calculator requests. Only an explicit operator decision (discarded or closed) takes
  // one out; stage, triage, lead flag or buying horizon never do.
  const journeyDemands = base.journeys.filter((journey) => journey.status !== 'ENCERRADO' && (base.journeyDisposition(journey)?.status || null) !== 'DISCARDED')
    .flatMap((journey) => (base.demands.byJourney.get(journey.id) || []).map((demand) => ({ demand, journey })));
  const orderDemands = base.demands.orders.filter((demand) => { const order = base.groupedByRef.get(upper(demand.ref)); return order && order.disposition !== 'DISCARDED' && !order.journeyId; }).map((demand) => ({ demand, journey: null }));
  for (const { demand, journey } of [...journeyDemands, ...orderDemands]) {
    const key = (journey ? 'ficha:' : 'pedido:') + demand.key;
    const common = { source: journey ? 'FICHA' : 'CALCULADORA', person: demandPerson(base, demand), mode: demand.mode, lastMessageAt: journey ? lastCustomer.get(journey.id) || null : null,
      evidence: journey ? [{ kind: 'FICHA', text: journey.vehicle_text ? 'Ficha: ' + String(journey.vehicle_text).slice(0, 300) : 'Critérios preenchidos na ficha' }] : [{ kind: 'CALCULADORA', text: 'Pedido da calculadora' + (demand.ref ? ', Ref ' + demand.ref : '') }] };
    if (demand.active) {
      // Demand with the official calculation: the current matcher, and the import result when the
      // criterion is the same.
      const target = { ...matchTarget(demand), reactivation: false };
      const hash = targetHash(target);
      const item = { ...common, key, criteriaText: wishText({ ...demand, wishes: demand.activeWishes }), completeness: 'PRONTO', missing: [], lacks: [], comparable: true, official: true, criteriaHash: hash, targets: [target] };
      let check = checkByKey.get(key + '|' + hash) || null;
      if (!check && uploadId && importedHash.has(demand.key) && importedHash.get(demand.key) === hash) {
        const row = summaryByKey.get(demand.key);
        const served = row ? (row.bate_count || 0) + (row.por_valor_count || 0) : 0;
        check = { upload_id: uploadId, criteria_hash: hash, result: served ? 'HAS_OPTIONS' : 'NO_OPTIONS', option_count: served, compared_at: upload.uploaded_at, fromImport: true };
      }
      items.push(finish(item, check, uploadId));
      continue;
    }
    // Demand the official matcher cannot use (no Ref, a missing range, mode not defined): still a
    // request. Each wish follows the MCS rule: ready (model + value + year or mileage) or it shows
    // what is missing. The value is the bid the calculator gave (VALOR), never guessed.
    const wishes = (demand.wishes && demand.wishes.length ? demand.wishes : [{}]);
    wishes.forEach((wish, index) => {
      const criteria = Object.fromEntries(Object.entries({ make: wish.make || null, model: wish.model || null, trim: wish.trim || null, yearMin: Number(wish.yearMin) || null, yearMax: Number(wish.yearMax) || null,
        minMiles: Number(wish.minMiles) || null, maxMiles: Number(wish.maxMiles) || null, budgetUsd: demand.mode === 'VALOR' && demand.bidCents ? Math.round(demand.bidCents / 100) : null }).filter(([, value]) => value));
      const described = requests.describe({ criteria });
      const itemKey = key + (wishes.length > 1 ? '#' + index : '');
      const item = { ...common, key: itemKey, criteria, criteriaText: requests.criteriaText(criteria), completeness: described.completeness, missing: described.missing, lacks: described.lacks, comparable: described.comparable, criteriaHash: described.criteriaHash, targets: [] };
      items.push(finish(item, checkByKey.get(itemKey + '|' + described.criteriaHash) || null, uploadId));
    });
  }
  for (const request of conversation.requests) {
    const key = 'conversa:' + request.id;
    const described = requests.describe({ criteria: request.criteria, evidence: request.evidence, confidence: request.confidence, needsReview: request.needs_review, reviewReason: request.review_reason });
    const item = { key, source: 'CONVERSA', person: request.person, mode: null, criteria: request.criteria, criteriaText: requests.criteriaText(request.criteria), missing: described.missing, lacks: described.lacks,
      completeness: described.completeness, reviewReason: described.reviewReason, comparable: described.comparable, criteriaHash: described.criteriaHash, targets: [],
      typeNotChecked: Boolean(request.criteria && request.criteria.bodyType), lastMessageAt: request.lastMessageAt, evidence: request.evidenceMessages, chatId: request.chat_id, versions: request.versionCount };
    items.push(finish(item, checkByKey.get(key + '|' + described.criteriaHash) || null, uploadId));
  }
  // Same criteria, one operational task; every person stays linked to it.
  const groups = new Map();
  items.forEach((item) => { const groupKey = (item.comparable ? 'c:' : 'x:' + item.key + ':') + item.criteriaHash; item.groupKey = groupKey; if (!groups.has(groupKey)) groups.set(groupKey, []); groups.get(groupKey).push(item.key); });
  const counts = Object.fromEntries(STATES.map((state) => [state, items.filter((item) => item.state === state).length]));
  const byCompleteness = Object.fromEntries(requests.COMPLETENESS.map((level) => [level, Object.fromEntries([...requests.RESULTS, 'NONE'].map((result) => [result, items.filter((item) => item.completeness === level && (item.result || 'NONE') === result).length]))]));
  return { uploadId, upload: upload ? { id: upload.id, uploadedAt: upload.uploaded_at } : null, items, groupCount: groups.size, counts, byCompleteness,
    extraction: search.extractionStatus(), requestsPending: conversation.pending, checksPending: checks === null };
}
// State shown and filtered: the readiness when the request is not compared (PRECISA DETALHE,
// PRECISA DE REVISÃO), otherwise its result in the active batch. A request that needs detail has
// no option count, is never compared and never counts as served.
const STATES = Object.freeze(['FALTA_BUSCAR', 'COM_OPCOES', 'COM_CANDIDATOS', 'SEM_OPCAO', 'PRECISA_DETALHE', 'PRECISA_REVISAO']);
function finish(item, check, uploadId) {
  const result = requests.resultOf(item, check, uploadId);
  const state = result || item.completeness;
  const label = [requests.COMPLETENESS_LABELS[item.completeness], result ? requests.RESULT_LABELS[result] : null].filter(Boolean).join(' · ');
  return { ...item, result, state, stateLabel: label, completenessLabel: requests.COMPLETENESS_LABELS[item.completeness],
    optionCount: result === 'COM_OPCOES' || result === 'COM_CANDIDATOS' || result === 'SEM_OPCAO' ? check.option_count : null,
    comparedAt: result && result !== 'FALTA_BUSCAR' ? check.compared_at : null, comparedUploadId: check ? check.upload_id : null, comparedAtImport: Boolean(check && check.fromImport) };
}
function lastCustomerByJourney(base) {
  const customerAt = new Map((base.messages || []).filter((message) => message.direction === 'CUSTOMER' && !message.undone_at).map((message) => [message.id, message.occurred_at_utc || message.created_at]));
  const last = new Map();
  (base.messageLinks || []).forEach((link) => { const at = customerAt.get(link.message_id); if (at && (!last.get(link.journey_id) || at > last.get(link.journey_id))) last.set(link.journey_id, at); });
  return last;
}
// Requests read from conversations (latest version of each) with their evidence messages.
async function loadConversationRequests(ctx) {
  const env = 'eq.' + ctx.environment;
  const stored = await safe(allRows(ctx, 'vehicle_requests', { select: 'id,chat_id,contact_id,journey_id,request_key', environment: env }), null);
  if (stored === null) return { requests: [], pending: true };
  if (!stored.length) return { requests: [], pending: false };
  const versions = await allRows(ctx, 'vehicle_request_versions', { select: 'id,request_id,criteria_json,missing_fields,evidence_json,confidence,needs_review,review_reason,criteria_hash,created_at', environment: env, order: 'created_at.asc' });
  const latest = new Map();
  const versionCount = new Map();
  versions.forEach((version) => { latest.set(version.request_id, version); versionCount.set(version.request_id, (versionCount.get(version.request_id) || 0) + 1); });
  const ids = [...new Set([...latest.values()].flatMap((version) => Object.values(version.evidence_json || {}).flat()))].filter(isUuid);
  const messages = new Map();
  for (let index = 0; index < ids.length; index += 100) {
    (await rows(ctx, 'messages', { select: 'id,body_text,occurred_at_utc,created_at', environment: env, id: 'in.(' + ids.slice(index, index + 100).join(',') + ')' })).forEach((row) => messages.set(row.id, row));
  }
  const contacts = new Map((await allRows(ctx, 'contacts', { select: 'id,display_name', environment: env })).map((row) => [row.id, row]));
  return { pending: false, requests: stored.filter((request) => latest.has(request.id)).map((request) => {
    const version = latest.get(request.id);
    const evidenceIds = [...new Set(Object.values(version.evidence_json || {}).flat())];
    const evidenceMessages = evidenceIds.map((id) => messages.get(id)).filter(Boolean).map((row) => ({ kind: 'MENSAGEM', id: row.id, at: row.occurred_at_utc || row.created_at, text: String(row.body_text || '').slice(0, 300) }))
      .sort((left, right) => String(left.at).localeCompare(String(right.at)));
    return { ...request, criteria: version.criteria_json || {}, evidence: version.evidence_json || {}, confidence: version.confidence, needs_review: version.needs_review, review_reason: version.review_reason,
      versionCount: versionCount.get(request.id), evidenceMessages, lastMessageAt: evidenceMessages.at(-1)?.at || null,
      person: { name: contacts.get(request.contact_id)?.display_name || 'Contato sem nome', contactId: request.contact_id, journeyId: request.journey_id || null } };
  }) };
}

// ------------------------------------------------------------------ auditoria (só leitura)
async function audit(ctx) {
  const env = 'eq.' + ctx.environment;
  const list = await buildList(ctx);
  const since = search.HISTORY_SINCE;
  const messages = await allRows(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,undone_at,occurred_at_utc', environment: env, occurred_at_utc: 'gte.' + since });
  const chats = new Map((await allRows(ctx, 'chats', { select: 'id,contact_id,is_group', environment: env })).map((row) => [row.id, row]));
  const real = messages.filter((message) => !message.undone_at && !message.is_automatic && String(message.body_text || '').trim());
  const customerChats = new Set(real.filter((message) => message.direction === 'CUSTOMER').map((message) => message.chat_id).filter((id) => chats.get(id) && chats.get(id).is_group === false));
  const people = new Set([...customerChats].map((id) => chats.get(id).contact_id).filter(Boolean));
  const runs = await safe(allRows(ctx, 'vehicle_request_runs', { select: 'chat_id,input_hash,status,error_code,cost_usd,provider', environment: env }), null);
  const readChats = new Set((runs || []).filter((run) => run.status !== 'FAILED').map((run) => run.chat_id));
  const unread = [...customerChats].filter((id) => !readChats.has(id));
  // What the reading of the history would read: up to 60 real messages per unread conversation.
  const perChat = new Map();
  real.forEach((message) => { if (unread.includes(message.chat_id)) { const entry = perChat.get(message.chat_id) || { count: 0, chars: 0 }; entry.count += 1; entry.chars += Math.min(String(message.body_text).length, 500); perChat.set(message.chat_id, entry); } });
  let toRead = 0, chars = 0;
  perChat.forEach((entry) => { const share = Math.min(entry.count, requests.MAX_MESSAGES) / entry.count; toRead += Math.min(entry.count, requests.MAX_MESSAGES); chars += Math.round(entry.chars * share); });
  const inputTokens = Math.round(chars / 4) + unread.length * 700;
  const outputTokens = unread.length * 250;
  const model = process.env.SEARCH_EXTRACTION_MODEL || 'gpt-6-luna';
  const byState = list.counts;
  const grid = list.byCompleteness;
  const conversationItems = list.items.filter((item) => item.source === 'CONVERSA');
  const provider = search.extractionStatus() === 'SIMULADA' ? 'SIMULATED' : 'OPENAI';
  const spentBy = (name) => Math.round((runs || []).filter((run) => run.provider === name).reduce((sum, run) => sum + (Number(run.cost_usd) || 0), 0) * 1e6) / 1e6;
  return {
    since, extraction: list.extraction, tablesPending: list.requestsPending,
    peopleWithMessages: people.size, conversationsWithCustomerMessages: customerChats.size,
    conversationsWithRequest: new Set(conversationItems.map((item) => item.chatId)).size,
    conversationsWithoutRequest: (runs || []).filter((run) => run.status === 'NO_REQUEST').length,
    requests: list.items.length, requestsFromConversations: conversationItems.length, requestsFromFicha: list.items.filter((item) => item.source !== 'CONVERSA').length,
    groups: list.groupCount,
    // Only PRONTO PARA BUSCAR is compared; the rest is counted apart and never as coverage.
    ready: list.items.filter((item) => item.completeness === 'PRONTO').length,
    readyWithOptions: grid.PRONTO.COM_OPCOES, readyWithCandidates: grid.PRONTO.COM_CANDIDATOS, readyWithoutOptions: grid.PRONTO.SEM_OPCAO,
    needsDetail: byState.PRECISA_DETALHE, review: byState.PRECISA_REVISAO, notCompared: byState.FALTA_BUSCAR,
    withoutReliableLink: list.items.filter((item) => !item.person || (!item.person.journeyId && !item.person.contactId && item.source !== 'CALCULADORA')).length,
    unverifiedReadings: (runs || []).filter((run) => run.error_code === 'EXTRACTION_UNVERIFIED').length,
    estimate: { conversationsToRead: unread.length, messagesToRead: toRead, inputTokens, outputTokens, model, costUsd: search.estimateCostUsd(model, inputTokens, outputTokens),
      spentUsd: spentBy('OPENAI'), providerLimitUsd: search.PROVIDER_LIMIT_USD.OPENAI, provider },
    // Tracked: every conversation read and every request compared or waiting on a person. Served
    // is only claimed when every request has at least one valid option.
    trackingComplete: unread.length === 0 && byState.FALTA_BUSCAR === 0 && byState.PRECISA_REVISAO === 0 && !list.requestsPending,
    allServed: list.items.length > 0 && byState.COM_OPCOES === list.items.length && unread.length === 0 && !list.requestsPending
  };
}

// ------------------------------------------------------------------ leitura do histórico
// Reads the next conversations since 09/08/2026 that were never read or got a new customer
// message after the last reading, in resumable batches (the run table is the checkpoint; the same
// content is never read twice). With the AI, each provider uses at most the balance already
// available in it (US$ 50 per provider): the batch stops before passing it, or when the provider
// itself says its quota ended, and the rest stays pending. Each batch is recorded (provider,
// model, conversations, tokens, cost). With the flag off in production nothing is read.
const HISTORY_BATCH = 10;
async function extractHistory(ctx, limit) {
  const status = search.extractionStatus();
  if (status !== 'SIMULADA' && status !== 'LIGADA') return { status: 409, error: 'SEARCH_EXTRACTION_OFF', extraction: status };
  const provider = status === 'LIGADA' ? 'OPENAI' : 'SIMULATED';
  const env = 'eq.' + ctx.environment;
  const runs = await allRows(ctx, 'vehicle_request_runs', { select: 'chat_id,status,provider,cost_usd,created_at', environment: env });
  const limitUsd = provider === 'OPENAI' ? search.PROVIDER_LIMIT_USD.OPENAI : null;
  const spentBefore = runs.filter((run) => run.provider === provider).reduce((sum, run) => sum + (Number(run.cost_usd) || 0), 0);
  const lastRead = new Map();
  runs.filter((run) => run.status !== 'FAILED').forEach((run) => { if (!lastRead.get(run.chat_id) || run.created_at > lastRead.get(run.chat_id)) lastRead.set(run.chat_id, run.created_at); });
  const customer = await allRows(ctx, 'messages', { select: 'chat_id,created_at', environment: env, direction: 'eq.CUSTOMER', undone_at: 'is.null', is_automatic: 'is.false', occurred_at_utc: 'gte.' + search.HISTORY_SINCE });
  const individual = new Set((await allRows(ctx, 'chats', { select: 'id', environment: env, is_group: 'is.false' })).map((row) => row.id));
  const newest = new Map();
  customer.forEach((row) => { if (!newest.get(row.chat_id) || row.created_at > newest.get(row.chat_id)) newest.set(row.chat_id, row.created_at); });
  const pending = [...newest.keys()].filter((id) => individual.has(id) && (!lastRead.has(id) || newest.get(id) > lastRead.get(id)));
  const batch = { conversations: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, stoppedReason: null };
  const done = [];
  for (const chatId of pending.slice(0, Math.min(limit || HISTORY_BATCH, HISTORY_BATCH))) {
    if (limitUsd !== null && spentBefore + batch.costUsd >= limitUsd) { batch.stoppedReason = 'PROVIDER_LIMIT'; break; }
    const out = await search.extractChat(ctx, chatId);
    if (out.error === 'OPENAI_QUOTA') { batch.stoppedReason = 'PROVIDER_QUOTA'; break; }
    batch.conversations += out.alreadyRead ? 0 : 1;
    batch.inputTokens += out.usage?.input || 0; batch.outputTokens += out.usage?.output || 0; batch.costUsd += Number(out.costUsd) || 0;
    done.push({ chatId, requests: out.requests || 0, error: out.error || null });
  }
  await insert(ctx, 'vehicle_request_batches', { environment: ctx.environment, provider, model: provider === 'OPENAI' ? process.env.SEARCH_EXTRACTION_MODEL : null, conversations: batch.conversations,
    input_tokens: batch.inputTokens, output_tokens: batch.outputTokens, cost_usd: Math.round(batch.costUsd * 1e6) / 1e6, stopped_reason: batch.stoppedReason, created_by: ctx.panel.id }, false);
  return { status: 200, provider, read: done.length, remaining: Math.max(0, pending.length - done.length), spentUsd: Math.round((spentBefore + batch.costUsd) * 1e6) / 1e6,
    providerLimitUsd: limitUsd, stoppedReason: batch.stoppedReason, results: done };
}

// ------------------------------------------------------------------ gravação da comparação
const upsertCheck = (ctx, row) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/vehicle_request_checks?on_conflict=environment,request_key,criteria_hash,upload_id', {
  method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) });

async function compare(ctx) {
  const list = await buildList(ctx);
  if (list.checksPending) return { status: 503, error: 'SEARCH_REQUESTS_PENDING' };
  const pending = list.items.filter((item) => item.state === 'FALTA_BUSCAR');
  const result = await search.compareItems(ctx, pending.slice(0, COMPARE_BATCH), { services: { upsertCheck } });
  return { status: 200, uploadId: result.uploadId, compared: result.compared, remaining: Math.max(0, pending.length - result.compared) };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://painel.local');
      if (url.searchParams.get('view') === 'audit') return send(res, 200, await audit(ctx));
      const list = await buildList(ctx);
      return send(res, 200, { ...list, items: list.items.map(({ targets, ...item }) => item) });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 16 * 1024);
    if (body.action === 'compare') { const { status, ...out } = await compare(ctx); return send(res, status, out); }
    if (body.action === 'extract_history') { const { status, ...out } = await extractHistory(ctx, Number(body.limit) || 0); return send(res, status, out); }
    if (body.action === 'extract' || body.action === 'sample') {
      if (!isUuid(body.chatId)) return send(res, 400, { error: 'CHAT_INVALID' });
      const out = await search.extractChat(ctx, body.chatId, { dryRun: body.action === 'sample' });
      return send(res, out.error === 'CHAT_NOT_FOUND' ? 404 : 200, out);
    }
    return send(res, 400, { error: 'ACTION_INVALID' });
  } catch (error) {
    if (search.tableMissing(error)) return send(res, 503, { error: 'SEARCH_REQUESTS_PENDING' });
    console.error('[pesquisas]', String(error && error.message || 'UNKNOWN'));
    return send(res, 500, { error: 'SEARCH_REQUESTS_UNAVAILABLE' });
  }
};
module.exports.buildList = buildList;
module.exports.audit = audit;

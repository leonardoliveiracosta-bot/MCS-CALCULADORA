'use strict';

// PESQUISAS: a lista diária de pedidos de veículo, sem lote, sem upload e sem cartões de opções.
//  GET                 pedidos (ficha, calculadora e conversas lidas), com estado e evidências
//  GET ?view=audit     auditoria desde 09/08/2026 e estimativa da leitura do histórico (só leitura)
//  POST compare        compara os pedidos em FALTA BUSCAR com o lote ativo e grava o resultado
//  POST extract        lê uma conversa (simulada fora de produção; em produção só com a flag nova)
//  POST sample         leitura simulada de uma conversa sem gravar nada
//  POST extract_history próximas conversas não lidas do histórico (retomável, com teto de gasto)
// Nenhum pedido sai da lista por estágio, previsão de compra, prazo ou classificação comercial.
// "Sem opção no lote" continua na lista para a próxima importação. Nada é enviado a ninguém.
const crypto = require('node:crypto');
const { allRows, isUuid, jsonBody, requirePanel, rows, send, supabase } = require('../../panel-server');
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
    const target = demand.active ? { ...matchTarget(demand), reactivation: false } : null;
    const hash = target ? targetHash(target) : crypto.createHash('sha256').update(JSON.stringify([demand.key, demand.mode, demand.wishes, demand.bidCents])).digest('hex').slice(0, 32);
    const key = (journey ? 'ficha:' : 'pedido:') + demand.key;
    const item = { key, source: journey ? 'FICHA' : 'CALCULADORA', person: demandPerson(base, demand), mode: demand.mode,
      criteriaText: wishText({ ...demand, wishes: demand.wishes && demand.wishes.length ? demand.wishes : demand.activeWishes }),
      missing: (demand.issues || []).map((issue) => issue.text), needsReview: demand.mode === 'REVIEW', comparable: Boolean(target), criteriaHash: hash,
      targets: target ? [target] : [], lastMessageAt: journey ? lastCustomer.get(journey.id) || null : null,
      evidence: journey ? [{ kind: 'FICHA', text: journey.vehicle_text ? 'Ficha: ' + String(journey.vehicle_text).slice(0, 300) : 'Critérios preenchidos na ficha' }] : [{ kind: 'CALCULADORA', text: 'Pedido da calculadora, Ref ' + demand.ref }] };
    // Compared at import with the same criterion: the stored result of the batch is the check.
    let check = checkByKey.get(key + '|' + hash) || null;
    if (!check && uploadId && target && importedHash.has(demand.key) && importedHash.get(demand.key) === hash) {
      const row = summaryByKey.get(demand.key);
      const served = row ? (row.bate_count || 0) + (row.por_valor_count || 0) : 0;
      check = { upload_id: uploadId, criteria_hash: hash, result: served ? 'HAS_OPTIONS' : 'NO_OPTIONS', option_count: served, compared_at: upload.uploaded_at, fromImport: true };
    }
    items.push(finish(item, check, uploadId));
  }
  for (const request of conversation.requests) {
    const key = 'conversa:' + request.id;
    const described = requests.describe({ criteria: request.criteria, evidence: request.evidence, confidence: request.confidence, needsReview: request.needs_review, reviewReason: request.review_reason });
    const item = { key, source: 'CONVERSA', person: request.person, mode: null, criteriaText: requests.criteriaText(request.criteria), missing: described.missing,
      needsReview: described.needsReview, reviewReason: described.reviewReason, comparable: described.comparable, criteriaHash: described.criteriaHash,
      targets: requests.targetsOf(request.criteria), lastMessageAt: request.lastMessageAt, evidence: request.evidenceMessages, chatId: request.chat_id, versions: request.versionCount };
    items.push(finish(item, checkByKey.get(key + '|' + described.criteriaHash) || null, uploadId));
  }
  // Same criteria, one operational task; every person stays linked to it.
  const groups = new Map();
  items.forEach((item) => { const groupKey = (item.comparable ? 'c:' : 'x:' + item.key + ':') + item.criteriaHash; item.groupKey = groupKey; if (!groups.has(groupKey)) groups.set(groupKey, []); groups.get(groupKey).push(item.key); });
  const counts = Object.fromEntries(requests.STATES.map((state) => [state, items.filter((item) => item.state === state).length]));
  return { uploadId, upload: upload ? { id: upload.id, uploadedAt: upload.uploaded_at } : null, items, groupCount: groups.size, counts,
    extraction: search.extractionStatus(), requestsPending: conversation.pending, checksPending: checks === null };
}
function finish(item, check, uploadId) {
  const state = requests.stateOf(item, check, uploadId);
  return { ...item, state, stateLabel: requests.STATE_LABELS[state], optionCount: check && ['COM_OPCOES', 'SEM_OPCAO'].includes(state) ? check.option_count : null,
    comparedAt: check && state !== 'FALTA_BUSCAR' ? check.compared_at : null, comparedUploadId: check ? check.upload_id : null, comparedAtImport: Boolean(check && check.fromImport) };
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
  const conversationItems = list.items.filter((item) => item.source === 'CONVERSA');
  return {
    since, extraction: list.extraction, tablesPending: list.requestsPending,
    peopleWithMessages: people.size, conversationsWithCustomerMessages: customerChats.size,
    conversationsWithRequest: new Set(conversationItems.map((item) => item.chatId)).size,
    requests: list.items.length, requestsFromConversations: conversationItems.length, requestsFromFicha: list.items.filter((item) => item.source !== 'CONVERSA').length,
    groups: list.groupCount, withOptions: byState.COM_OPCOES, withoutOptions: byState.SEM_OPCAO, insufficient: byState.CRITERIOS_INSUFICIENTES, review: byState.PRECISA_REVISAO, notCompared: byState.FALTA_BUSCAR,
    withoutReliableLink: list.items.filter((item) => !item.person || (!item.person.journeyId && !item.person.contactId && item.source !== 'CALCULADORA')).length,
    unverifiedReadings: (runs || []).filter((run) => run.error_code === 'EXTRACTION_UNVERIFIED').length,
    estimate: { conversationsToRead: unread.length, messagesToRead: toRead, inputTokens, outputTokens, model, costUsd: search.estimateCostUsd(model, inputTokens, outputTokens),
      spentUsd: Math.round((runs || []).reduce((sum, run) => sum + (Number(run.cost_usd) || 0), 0) * 1e6) / 1e6, budgetUsd: Number(process.env.SEARCH_EXTRACTION_BUDGET_USD) || null },
    // Tracked: every conversation read and every request compared or waiting on a person. Served
    // is only claimed when every request has at least one valid option.
    trackingComplete: unread.length === 0 && byState.FALTA_BUSCAR === 0 && byState.PRECISA_REVISAO === 0 && !list.requestsPending,
    allServed: list.items.length > 0 && byState.COM_OPCOES === list.items.length && unread.length === 0 && !list.requestsPending
  };
}

// ------------------------------------------------------------------ leitura do histórico
// Reads the next unread conversations since 09/08/2026, a few per call. Resumable: a conversation
// already read with the same content is skipped (the run table is the checkpoint). With the AI it
// stops before passing SEARCH_EXTRACTION_BUDGET_USD (default US$ 2). With the flag off in
// production nothing is read.
const HISTORY_BATCH = 10;
async function extractHistory(ctx, limit) {
  const status = search.extractionStatus();
  if (status !== 'SIMULADA' && status !== 'LIGADA') return { status: 409, error: 'SEARCH_EXTRACTION_OFF', extraction: status };
  const env = 'eq.' + ctx.environment;
  const runs = await allRows(ctx, 'vehicle_request_runs', { select: 'chat_id,status,cost_usd', environment: env });
  const budget = Number(process.env.SEARCH_EXTRACTION_BUDGET_USD) || 2;
  let spent = runs.reduce((sum, run) => sum + (Number(run.cost_usd) || 0), 0);
  const read = new Set(runs.filter((run) => run.status !== 'FAILED').map((run) => run.chat_id));
  const customer = await allRows(ctx, 'messages', { select: 'chat_id', environment: env, direction: 'eq.CUSTOMER', undone_at: 'is.null', is_automatic: 'is.false', occurred_at_utc: 'gte.' + search.HISTORY_SINCE });
  const individual = new Set((await allRows(ctx, 'chats', { select: 'id', environment: env, is_group: 'is.false' })).map((row) => row.id));
  const pending = [...new Set(customer.map((row) => row.chat_id))].filter((id) => individual.has(id) && !read.has(id));
  const done = [];
  for (const chatId of pending.slice(0, Math.min(limit || HISTORY_BATCH, HISTORY_BATCH))) {
    if (status === 'LIGADA' && spent >= budget) return { status: 200, stoppedByBudget: true, spentUsd: spent, budgetUsd: budget, read: done.length, remaining: pending.length - done.length };
    // The cost of each reading is in its run row; the next call sums it again before reading more.
    const out = await search.extractChat(ctx, chatId);
    done.push({ chatId, requests: out.requests || 0, error: out.error || null });
  }
  return { status: 200, read: done.length, remaining: Math.max(0, pending.length - done.length), spentUsd: spent, budgetUsd: budget, results: done };
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

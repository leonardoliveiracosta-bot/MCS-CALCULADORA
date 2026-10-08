'use strict';

// PESQUISAS: a lista diária de pedidos de veículo, sem lote, sem upload e sem cartões de opções.
//  GET                 pedidos (ficha, calculadora e conversas lidas), com estado e evidências
//  GET ?view=audit     auditoria desde 09/08/2026 e estimativa da leitura do histórico (só leitura)
//  POST compare        compara só os pedidos PRONTO PARA BUSCAR (por carro: carro + ano + milhagem;
//                      por valor: modelo + lance)
//                      ainda em FALTA BUSCAR com o lote ativo e grava o resultado
//  POST empty_reasons  por que cada pedido SEM OPÇÃO não achou carro, em linguagem simples (só leitura)
//  POST extract        lê uma conversa (simulada fora de produção; em produção só com a flag nova)
//  POST sample         leitura simulada de uma conversa sem gravar nada
//  POST history_status  progresso da auditoria histórica (processadas, pedidos, custo)
//  POST model_check     chamada mínima de teste do modelo, sem dado de cliente (só produção)
//  POST extract_history próximas conversas do histórico (retomável; saldo pré-pago da OpenAI)
// Só entra quem mandou mensagem de verdade (pedido da calculadora sem mensagem não entra) e não
// está encerrado, desligado, descartado, fora do funil ou marcado como "não é lead". Fora isso,
// nenhum pedido sai da lista por estágio, previsão de compra ou prazo.
// "Sem opção no lote" continua na lista para a próxima importação. Nada é enviado a ninguém.
const crypto = require('node:crypto');
const openAiBudget = require('../../panel-openai-budget');
const { allRows, insert, isUuid, jsonBody, requirePanel, rows, rpc, send, supabase } = require('../../panel-server');
const { loadBuscasBase, demandPerson, matchTarget, upper } = require('../../panel-buscas');
const { latestActiveUpload } = require('../../panel-manheim-state');
const { criteriaHash: targetHash } = require('../../panel-manheim-batch');
const requests = require('../../vehicle-requests');
const search = require('../../panel-search-requests');
const toFicha = require('../../panel-search-to-ficha');
const rematch = require('../../panel-rematch');
const { emptyReasons } = require('../../search-empty-reason');
const merge = require('../../panel-request-merge');
const buscasView = require('../../panel-buscas-view');

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
async function buildList(ctx, { includeResults = true } = {}) {
  const started = Date.now(), timing = {};
  const timed = (name, work) => { work.then(() => { timing[name] = Date.now() - started; }, () => {}); return work; };
  // The batch summary only needs the active batch: it starts as soon as the batch is known, while the base loads.
  // Completar pedido uses criteria/completeness, never the result of comparing a ready
  // request with the batch. Build every request and merge its evidence as usual, but
  // do not calculate batch results for this projection. Full lists/counters keep them.
  const uploadRead = includeResults ? latestActiveUpload(ctx, 'id,uploaded_at') : Promise.resolve(null);
  const summaryRead = timed('summary', uploadRead.then((upload) => upload ? buscasView.batchSummary(ctx, upload.id).catch(() => null) : []));
  summaryRead.catch(() => {});
  // The requests read from conversations do not depend on the base either: they load at the same time.
  const conversationRead = timed('conversation', loadConversationRequests(ctx));
  conversationRead.catch(() => {});
  const [base, upload] = await Promise.all([timed('base', loadBuscasBase(ctx, { allRows })), uploadRead]);
  const uploadId = upload ? upload.id : null;
  const [summary, snapshot, syncs, checks, conversation] = await Promise.all([
    summaryRead,
    uploadId ? rows(ctx, 'manheim_uploads', { select: 'targets_json', environment: 'eq.' + ctx.environment, id: 'eq.' + uploadId, limit: '1' }).then((found) => found[0]?.targets_json || []).catch(() => []) : [],
    uploadId ? allRows(ctx, 'manheim_demand_syncs', { select: 'demand_key,criteria_hash,synced_at', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId }).catch(() => []) : [],
    uploadId ? safe(allRows(ctx, 'vehicle_request_checks', { select: 'request_key,criteria_hash,upload_id,result,option_count,compared_at', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId }), null) : [],
    conversationRead
  ]);
  timing.reads = Date.now() - started;
  // Medição fina: cada trecho síncrono com o seu tempo.
  let cpuAt = Date.now();
  const cpu = (name) => { timing['cpu_' + name] = Date.now() - cpuAt; cpuAt = Date.now(); };
  const checkByKey = new Map((checks || []).map((row) => [row.request_key + '|' + row.criteria_hash, row]));
  const summaryByKey = new Map((summary || []).map((row) => [row.demand_key, row]));
  // Proof that a ficha/calculator demand was compared with the active batch with its current
  // criterion: the import snapshot or manheim_demand_syncs (the same proof as ENVIAR OPÇÕES).
  const proven = buscasView.comparedKeys(Array.isArray(snapshot) ? snapshot : [], syncs) || new Set();
  const syncedAt = new Map((syncs || []).map((row) => [row.demand_key + '|' + row.criteria_hash, row.synced_at]));
  // The same targets (and criteriaHash, reactivation included) that ENVIAR OPÇÕES and the rematch use.
  const context = buscasView.demandContext(base);
  const lastCustomer = lastCustomerByJourney(base);
  cpu('context');
  const items = [];
  // Ficha requests: only a client who really wrote (panel-contact.js) and is still workable: not
  // closed, switched off, discarded, out of the funnel or "não é lead". A calculator order with no
  // ficha has no message (a click is never contact), so it is never a request here.
  const workable = (journey) => journey.status !== 'ENCERRADO' && journey.enabled !== false && !journey.triageOut && journey.contact?.is_lead !== false
    && (base.journeyDisposition(journey)?.status || null) !== 'DISCARDED';
  const journeyDemands = base.journeys.filter((journey) => workable(journey) && base.journeyEntered(journey))
    .flatMap((journey) => (base.demands.byJourney.get(journey.id) || []).map((demand) => ({ demand, journey })));
  for (const { demand, journey } of journeyDemands) {
    const key = (journey ? 'ficha:' : 'pedido:') + demand.key;
    const common = { source: journey ? 'FICHA' : 'CALCULADORA', person: demandPerson(base, demand), mode: demand.mode, lastMessageAt: journey ? lastCustomer.get(journey.id) || null : null,
      evidence: journey ? [{ kind: 'FICHA', text: journey.vehicle_text ? 'Ficha: ' + String(journey.vehicle_text).slice(0, 300) : 'Critérios preenchidos na ficha' }] : [{ kind: 'CALCULADORA', text: 'Pedido da calculadora' + (demand.ref ? ', Ref ' + demand.ref : '') }] };
    if (demand.active) {
      // Demand ready in its own mode (CARRO: vehicle, years and mileage; VALOR: model and the official
      // bid): the current matcher, and the import result when the criterion is the same.
      const live = context.targetByKey.get(demand.key);
      const target = live ? { ...live } : { ...matchTarget(demand), reactivation: false };
      const hash = live ? live.criteriaHash : targetHash(target);
      const item = { ...common, key, demandKey: demand.key, criteriaText: wishText({ ...demand, wishes: demand.activeWishes }), completeness: 'PRONTO', searchMode: demand.mode, missing: [], lacks: {}, comparable: true, official: true, criteriaHash: hash, targets: [target] };
      // Out of "Ainda não comparado" only with the proof of this criterion against the active batch;
      // the counts are the options eligible NOW (same summary as ENVIAR OPÇÕES).
      let check = null;
      if (uploadId && proven.has(demand.key + '|' + hash) && summary !== null) {
        const counts = buscasView.batchCounts(summaryByKey.get(demand.key), target.reactivation === true);
        check = { upload_id: uploadId, criteria_hash: hash, result: counts.matchCount ? 'HAS_OPTIONS' : 'NO_OPTIONS', option_count: counts.matchCount,
          expired: counts.expired, compared_at: syncedAt.get(demand.key + '|' + hash) || upload.uploaded_at, fromImport: !syncedAt.has(demand.key + '|' + hash) };
      }
      items.push(finish(item, check, uploadId));
      continue;
    }
    // Demand the official matcher cannot use (a missing range, no bid, mode not defined): still a
    // request. Its own mode decides what it needs (CARRO: vehicle, year and mileage; VALOR: model
    // and the official bid); without a mode, what the criteria support. Nothing is guessed.
    const wishes = (demand.wishes && demand.wishes.length ? demand.wishes : [{}]);
    wishes.forEach((wish, index) => {
      const criteria = Object.fromEntries(Object.entries({ make: wish.make || null, model: wish.model || null, trim: wish.trim || null, yearMin: Number(wish.yearMin) || null, yearMax: Number(wish.yearMax) || null,
        minMiles: Number(wish.minMiles) || null, maxMiles: Number(wish.maxMiles) || null, budgetUsd: demand.mode === 'VALOR' && demand.bidCents ? Math.round(demand.bidCents / 100) : null }).filter(([, value]) => value));
      const knownMode = requests.SEARCH_MODES.includes(demand.mode);
      const described = requests.describe({ criteria }, knownMode ? [demand.mode] : requests.SEARCH_MODES);
      const itemKey = key + (wishes.length > 1 ? '#' + index : '');
      const item = { ...common, key: itemKey, criteria, criteriaText: requests.criteriaText(criteria), completeness: described.completeness, searchMode: described.searchMode, missing: described.missing, lacks: described.lacks, lacksText: described.lacksText, comparable: described.comparable, criteriaHash: described.criteriaHash, targets: [] };
      // The ficha/calculator never said the search type: it goes to review, never to a type picked
      // from the criteria (above all never to "por valor" by default). The key and hash stay the same.
      if (!knownMode && described.completeness === 'PRONTO') Object.assign(item, { completeness: 'PRECISA_REVISAO', searchMode: null, comparable: false, missing: [], typeUnknown: true,
        reviewReason: 'Tipo de busca não definido no pedido: escolha por valor ou por carro' });
      items.push(finish(item, checkByKey.get(itemKey + '|' + described.criteriaHash) || null, uploadId));
    });
  }
  cpu('fichas');
  for (const request of conversation.requests) {
    // Read from a real conversation, so the person wrote; the same exclusions as the fichas apply.
    if (base.contactsById.get(request.contact_id)?.is_lead === false) continue;
    // The ficha is the one its evidence messages are linked to (vehicle_requests.journey_id is not
    // filled): closed, switched off, discarded or out-of-funnel fichas leave the list, and the card
    // can open the ficha.
    const ownerId = request.journey_id || toFicha.fichaOf({ evidence: request.evidenceMessages }, base);
    const owner = ownerId ? base.journeyById.get(ownerId) : null;
    if (owner && !workable(owner)) continue;
    if (owner) request.person = { ...request.person, journeyId: owner.id };
    const key = 'conversa:' + request.id;
    const described = requests.describe({ criteria: request.criteria, evidence: request.evidence, confidence: request.confidence, needsReview: request.needs_review, reviewReason: request.review_reason });
    const item = { key, source: 'CONVERSA', person: request.person, mode: null, criteria: request.criteria, criteriaText: requests.criteriaText(request.criteria), missing: described.missing, lacks: described.lacks, lacksText: described.lacksText, searchMode: described.searchMode,
      completeness: described.completeness, reviewReason: described.reviewReason, comparable: described.comparable, criteriaHash: described.criteriaHash, targets: [],
      typeNotChecked: Boolean(request.criteria && request.criteria.bodyType), versionId: request.versionId, lastMessageAt: request.lastMessageAt, evidence: request.evidenceMessages, chatId: request.chat_id, versions: request.versionCount };
    items.push(finish(item, checkByKey.get(key + '|' + described.criteriaHash) || null, uploadId));
  }
  cpu('conversas');
  // Same criteria, one operational task; every person stays linked to it.
  const groups = new Map();
  items.forEach((item) => { const groupKey = (item.comparable ? 'c:' + (item.searchMode || '') + ':' : 'x:' + item.key + ':') + item.criteriaHash; item.groupKey = groupKey; if (!groups.has(groupKey)) groups.set(groupKey, []); groups.get(groupKey).push(item.key); });
  const counts = Object.fromEntries(STATES.map((state) => [state, items.filter((item) => item.state === state).length]));
  const byCompleteness = Object.fromEntries(requests.COMPLETENESS.map((level) => [level, Object.fromEntries([...requests.RESULTS, 'NONE'].map((result) => [result, items.filter((item) => item.completeness === level && (item.result || 'NONE') === result).length]))]));
  const list = { uploadId, upload: upload ? { id: upload.id, uploadedAt: upload.uploaded_at } : null, items, groupCount: groups.size, counts, byCompleteness,
    extraction: search.extractionStatus(), requestsPending: conversation.pending, checksPending: checks === null };
  // The base goes along for the compare step, never in the JSON answer.
  Object.defineProperty(list, 'base', { value: base, enumerable: false });
  cpu('groups');
  console.log('[pesquisas-timing]', JSON.stringify({ ...timing, total: Date.now() - started, items: items.length, profile: base.profile || null }));
  return list;
}
// State shown and filtered: the readiness when the request is not compared (PRECISA DETALHE,
// PRECISA DE REVISÃO), otherwise its result in the active batch. A request that needs detail has
// no option count, is never compared and never counts as served.
const STATES = Object.freeze(['FALTA_BUSCAR', 'COM_OPCOES', 'COM_CANDIDATOS', 'SEM_OPCAO', 'PRECISA_DETALHE', 'PRECISA_REVISAO']);
// The list's counters recomputed over the requests actually shown (same rules as buildList).
function withCounts(list, items) {
  const counts = Object.fromEntries(STATES.map((state) => [state, items.filter((item) => item.state === state).length]));
  const byCompleteness = Object.fromEntries(requests.COMPLETENESS.map((level) => [level, Object.fromEntries([...requests.RESULTS, 'NONE'].map((result) => [result, items.filter((item) => item.completeness === level && (item.result || 'NONE') === result).length]))]));
  return { ...list, items, counts, byCompleteness };
}
function finish(item, check, uploadId) {
  const unknown = item.comparable && (item.targets?.length ? item.targets.flatMap((t) => t.wishes || []) : [item.criteria || {}]).every((w) => !require('../../vehicle-catalog').recognized(w.model, w.make));
  if (unknown) { check = { result: 'NO_OPTIONS', option_count: 0, upload_id: uploadId, criteria_hash: item.criteriaHash }; item.manualReason = 'modelo não reconhecido'; }
  const result = unknown ? 'SEM_OPCAO' : requests.resultOf(item, check, uploadId);
  const state = result || item.completeness;
  const lackingOne = item.completeness === 'PRECISA_DETALHE' && Object.keys(item.lacks || {}).length === 1 ? item.lacksText.toUpperCase() : null;
  const label = [requests.COMPLETENESS_LABELS[item.completeness], item.searchMode ? requests.MODE_LABELS[item.searchMode] : null, lackingOne, result ? requests.RESULT_LABELS[result] : null].filter(Boolean).join(' · ');
  const counted = result === 'COM_OPCOES' || result === 'COM_CANDIDATOS' || result === 'SEM_OPCAO';
  return { ...item, result, state, stateLabel: label, completenessLabel: requests.COMPLETENESS_LABELS[item.completeness],
    optionCount: counted ? check.option_count : null,
    // Every option found in this batch already expired: never "sem carro no lote".
    expired: result === 'SEM_OPCAO' && check.expired === true,
    comparedAt: result && result !== 'FALTA_BUSCAR' ? check.compared_at : null, comparedUploadId: check ? check.upload_id : null, comparedAtImport: Boolean(check && check.fromImport) };
}
function lastCustomerByJourney(base) {
  const customerAt = new Map((base.messages || []).filter((message) => message.direction === 'CUSTOMER' && !message.undone_at).map((message) => [message.id, message.occurred_at_utc || message.created_at]));
  const last = new Map();
  (base.messageLinks || []).forEach((link) => { const at = customerAt.get(link.message_id); if (at && (!last.get(link.journey_id) || at > last.get(link.journey_id))) last.set(link.journey_id, at); });
  return last;
}
// Requests read from conversations (latest version of each) with their evidence messages.
const MESSAGE_PAGES_AT_ONCE = 6;
async function loadConversationRequests(ctx) {
  const env = 'eq.' + ctx.environment;
  // The requests, their versions and the contact names are read together (they used to be read one after the other).
  const [stored, versionRows, contactRows] = await Promise.all([
    safe(allRows(ctx, 'vehicle_requests', { select: 'id,chat_id,contact_id,journey_id,request_key', environment: env }), null),
    safe(allRows(ctx, 'vehicle_request_versions', { select: 'id,request_id,criteria_json,missing_fields,evidence_json,confidence,needs_review,review_reason,criteria_hash,created_at', environment: env, order: 'created_at.asc,id.asc' }), null),
    allRows(ctx, 'contacts', { select: 'id,display_name', environment: env })
  ]);
  if (stored === null) return { requests: [], pending: true };
  if (!stored.length) return { requests: [], pending: false };
  const versions = versionRows || [];
  // Only the latest version is the active request; the older ones are its history.
  const latest = require('../../panel-request-demands').latestVersions(versions);
  const versionCount = new Map();
  versions.forEach((version) => { versionCount.set(version.request_id, (versionCount.get(version.request_id) || 0) + 1); });
  const ids = [...new Set([...latest.values()].flatMap((version) => Object.values(version.evidence_json || {}).flat()))].filter(isUuid);
  const messages = new Map();
  // The evidence messages in pages of 100 ids, a few pages at a time (they used to go one page after the other).
  const pages = [];
  for (let index = 0; index < ids.length; index += 100) pages.push(ids.slice(index, index + 100));
  for (let index = 0; index < pages.length; index += MESSAGE_PAGES_AT_ONCE) {
    const found = await Promise.all(pages.slice(index, index + MESSAGE_PAGES_AT_ONCE).map((page) => rows(ctx, 'messages', { select: 'id,body_text,occurred_at_utc,created_at', environment: env, id: 'in.(' + page.join(',') + ')' })));
    found.flat().forEach((row) => messages.set(row.id, row));
  }
  const contacts = new Map(contactRows.map((row) => [row.id, row]));
  return { pending: false, requests: stored.filter((request) => latest.has(request.id)).map((request) => {
    const version = latest.get(request.id);
    const evidenceIds = [...new Set(Object.values(version.evidence_json || {}).flat())];
    const evidenceMessages = evidenceIds.map((id) => messages.get(id)).filter(Boolean).map((row) => ({ kind: 'MENSAGEM', id: row.id, at: row.occurred_at_utc || row.created_at, text: String(row.body_text || '').slice(0, 300) }))
      .sort((left, right) => String(left.at).localeCompare(String(right.at)));
    return { ...request, versionId: version.id, criteria: version.criteria_json || {}, evidence: version.evidence_json || {}, confidence: version.confidence, needs_review: version.needs_review, review_reason: version.review_reason,
      versionCount: versionCount.get(request.id), evidenceMessages, lastMessageAt: evidenceMessages.at(-1)?.at || null,
      person: { name: contacts.get(request.contact_id)?.display_name || 'Contato sem nome', contactId: request.contact_id, journeyId: request.journey_id || null } };
  }) };
}

// ------------------------------------------------------------------ auditoria (só leitura)
async function audit(ctx) {
  const env = 'eq.' + ctx.environment;
  const full = await buildList(ctx);
  // The same presentation as the list: a ficha request and the reading of the same request by the AI are ONE request
  // (the reading stays as its unconfirmed evidence), so the audit never counts the same proven request twice.
  const shown = merge.present(full.items);
  const list = withCounts(full, shown.items);
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
    // Same proven request seen twice (ficha/calculator and the AI's reading of its conversation) counts once; people and requests are counted apart.
    mergedReadings: shown.merged, people: merge.counts(list.items, STATES).people,
    // Only PRONTO PARA BUSCAR is compared; the rest is counted apart and never as coverage.
    ready: list.items.filter((item) => item.completeness === 'PRONTO').length,
    readyWithOptions: grid.PRONTO.COM_OPCOES, readyWithCandidates: grid.PRONTO.COM_CANDIDATOS, readyWithoutOptions: grid.PRONTO.SEM_OPCAO,
    needsDetail: byState.PRECISA_DETALHE, review: byState.PRECISA_REVISAO, notCompared: byState.FALTA_BUSCAR,
    withoutReliableLink: list.items.filter((item) => !item.person || (!item.person.journeyId && !item.person.contactId && item.source !== 'CALCULADORA')).length,
    unverifiedReadings: (runs || []).filter((run) => run.error_code === 'EXTRACTION_UNVERIFIED').length,
    estimate: { conversationsToRead: unread.length, messagesToRead: toRead, inputTokens, outputTokens, model, costUsd: search.estimateCostUsd(model, inputTokens, outputTokens),
      spentUsd: spentBy('OPENAI'), providerLimitUsd: null, provider },
    // Tracked: every conversation read and every request compared or waiting on a person. Served
    // is only claimed when every request has at least one valid option.
    trackingComplete: unread.length === 0 && byState.FALTA_BUSCAR === 0 && byState.PRECISA_REVISAO === 0 && !list.requestsPending,
    allServed: list.items.length > 0 && byState.COM_OPCOES === list.items.length && unread.length === 0 && !list.requestsPending
  };
}

// ------------------------------------------------------------------ leitura do histórico
// Auditoria histórica: lê as conversas de clientes desde 09/08/2026 que nunca foram lidas ou que
// receberam mensagem nova do cliente depois da última leitura, em lotes retomáveis de 10 (a tabela
// de leituras é o ponto de retomada; o mesmo conteúdo nunca é lido duas vezes). Com a IA:
//  * antes da primeira conversa real, uma chamada mínima de teste do modelo, sem dado de cliente;
//    modelo indisponível para a auditoria antes de ler qualquer conversa (sem trocar de modelo);
//  * saldo pré-pago da OpenAI: uma chamada só começa se ainda cabe inteira; a cota do próprio
//    provedor também para com segurança; cada lote é registrado (provedor, modelo, tokens, custo).
// Nada é enviado a ninguém. Fora de produção a leitura é sempre simulada.
const HISTORY_BATCH = 10;
const modelChecksOf = (batches, provider) => batches.filter((row) => row.provider === provider && row.conversations === 0 && /^MODEL_CHECK_|^MODEL_UNAVAILABLE/.test(row.stopped_reason || ''));
const BATCH_SECONDS = 30;
// Shortest wait worth starting a reading with.
const MIN_READ_MS = 15000;
const CHECK_OK = 'MODEL_CHECK_OK';
const round6 = (value) => Math.round(value * 1e6) / 1e6;
async function historyState(ctx, provider) {
  const env = 'eq.' + ctx.environment;
  const [runs, customer, chats, batches, requestRows] = await Promise.all([
    allRows(ctx, 'vehicle_request_runs', { select: 'chat_id,status,provider,cost_usd,messages_read,created_at,attempts', environment: env }),
    allRows(ctx, 'messages', { select: 'chat_id,created_at', environment: env, direction: 'eq.CUSTOMER', undone_at: 'is.null', is_automatic: 'is.false', occurred_at_utc: 'gte.' + search.HISTORY_SINCE }),
    allRows(ctx, 'chats', { select: 'id', environment: env, is_group: 'is.false' }),
    allRows(ctx, 'vehicle_request_batches', { select: 'provider,model,conversations,cost_usd,stopped_reason,created_at', environment: env, order: 'created_at.asc' }),
    allRows(ctx, 'vehicle_requests', { select: 'id', environment: env })
  ]);
  const individual = new Set(chats.map((row) => row.id));
  const newest = new Map();
  customer.forEach((row) => { if (individual.has(row.chat_id) && (!newest.get(row.chat_id) || row.created_at > newest.get(row.chat_id))) newest.set(row.chat_id, row.created_at); });
  const lastRead = new Map(), failedAfter = new Map();
  runs.filter((run) => run.status !== 'FAILED').forEach((run) => { if (!lastRead.get(run.chat_id) || run.created_at > lastRead.get(run.chat_id)) lastRead.set(run.chat_id, run.created_at); });
  // A conversation whose current content failed MAX_FAILED_READS times is not read again (it waits
  // for a new message), so it is no longer counted as pending.
  runs.filter((run) => run.status === 'FAILED' && newest.has(run.chat_id) && run.created_at > newest.get(run.chat_id)).forEach((run) => failedAfter.set(run.chat_id, Math.max(failedAfter.get(run.chat_id) || 0, Number(run.attempts) || 1)));
  const unread = (id) => (!lastRead.has(id) || newest.get(id) > lastRead.get(id)) && (failedAfter.get(id) || 0) < search.MAX_FAILED_READS;
  // Whoever wrote last is read first: a reply that just arrived never waits behind old conversations.
  const pending = [...newest.keys()].filter(unread)
    .sort((a, b) => String(newest.get(b)).localeCompare(String(newest.get(a))));
  const ownRuns = runs.filter((run) => run.provider === provider);
  const checks = modelChecksOf(batches, provider);
  const spent = ownRuns.reduce((sum, run) => sum + (Number(run.cost_usd) || 0), 0) + checks.reduce((sum, row) => sum + (Number(row.cost_usd) || 0), 0);
  return { pending, total: newest.size, processed: newest.size - pending.length, requestsFound: requestRows.length,
    messagesRead: ownRuns.filter((run) => run.status !== 'FAILED').reduce((sum, run) => sum + (Number(run.messages_read) || 0), 0), spentUsd: round6(spent), lastCheck: checks.at(-1) || null };
}
function historyContext() {
  const status = search.extractionStatus();
  if (status !== 'SIMULADA' && status !== 'LIGADA') return { error: 'SEARCH_EXTRACTION_OFF', status };
  const provider = status === 'LIGADA' ? 'OPENAI' : 'SIMULATED';
  return { status, provider, model: provider === 'OPENAI' ? process.env.SEARCH_EXTRACTION_MODEL : null, limitUsd: null };
}
const modelChecked = (state, model) => Boolean(state.lastCheck && state.lastCheck.stopped_reason === CHECK_OK && state.lastCheck.model === model);
function progressOf(state, context, extra = {}) {
  return { status: 200, extraction: context.status, provider: context.provider, model: context.model, total: state.total, processed: state.processed, remaining: state.pending.length,
    messagesRead: state.messagesRead, requestsFound: state.requestsFound, spentUsd: state.spentUsd, providerLimitUsd: context.limitUsd,
    modelChecked: context.provider !== 'OPENAI' || modelChecked(state, context.model), ...extra };
}
async function historyStatus(ctx) {
  const context = historyContext();
  if (context.error) return { status: 200, extraction: context.status, available: false };
  return { ...progressOf(await historyState(ctx, context.provider), context), available: true };
}
// The minimal model test. Recorded as a batch with no conversation (model, usage, cost or error).
async function modelCheck(ctx, options = {}) {
  const context = historyContext();
  if (context.error) return { status: 409, error: context.error, extraction: context.status };
  if (context.provider !== 'OPENAI') return { status: 200, ok: true, simulated: true, model: null };
  const state = await historyState(ctx, context.provider);
  // The limit is the OpenAI prepaid balance left (every feature together), never a ceiling of its own.
  const provider = await openAiBudget.spentUsd(ctx);
  if (!openAiBudget.fits(provider, search.MAX_CALL_USD)) return { status: 409, error: 'PROVIDER_LIMIT', spentUsd: state.spentUsd, providerSpentUsd: provider.total };
  let result, failure = null;
  const guard = openAiBudget.guard(ctx, 'MODELO_TESTE', 'pesquisas:' + context.model);
  try { result = await search.checkModel({ ...options, guard }); } catch (error) { failure = error.code || 'OPENAI_FAILED'; }
  if (failure === 'OPENAI_BUDGET_LIMIT') return { status: 409, error: 'PROVIDER_LIMIT', spentUsd: state.spentUsd, providerSpentUsd: provider.total };
  await insert(ctx, 'vehicle_request_batches', { environment: ctx.environment, provider: 'OPENAI', model: context.model, conversations: 0, input_tokens: result?.usage?.input || 0,
    output_tokens: result?.usage?.output || 0, cost_usd: round6(result?.costUsd || 0), stopped_reason: failure ? (failure === 'OPENAI_MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' : 'MODEL_CHECK_' + failure.replace(/^OPENAI_/, '')) : CHECK_OK, created_by: ctx.panel.id }, false);
  await openAiBudget.recorded(guard);
  if (failure) return { status: 200, ok: false, error: failure, model: context.model };
  return { status: 200, ok: true, model: context.model, usage: result.usage, costUsd: result.costUsd };
}
async function extractHistory(ctx, limit, options = {}) {
  const context = historyContext();
  if (context.error) return { status: 409, error: context.error, extraction: context.status };
  const state = await historyState(ctx, context.provider);
  // No real conversation goes to the provider before the model test passed for this model.
  if (context.provider === 'OPENAI' && !modelChecked(state, context.model)) return { status: 409, error: 'MODEL_NOT_CHECKED', model: context.model };
  const started = Date.now();
  const batch = { conversations: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, stoppedReason: null };
  const done = [];
  // The cron passes a small limit and its own deadline; the panel button keeps the 30-second batch.
  const deadlineAt = options.deadlineAt || started + BATCH_SECONDS * 1000;
  // Hard end for a reading in progress: a little after the deadline to start new ones, well inside
  // the 60 s of the function (cron: 58 s; button: 38 s).
  const hardStopAt = deadlineAt + 8000;
  if (!state.pending.length) return progressOf(state, context, { read: 0, failed: 0, stoppedReason: null, batchCostUsd: 0 });
  const provider = context.provider === 'OPENAI' ? await openAiBudget.spentUsd(ctx) : null;
  // The cron reads with no count limit (Infinity), only its time window and the OpenAI prepaid
  // balance; the panel button reads in batches of 10 and goes on by itself until the end.
  const wanted = limit === Infinity ? Infinity : Math.min(limit || HISTORY_BATCH, HISTORY_BATCH);
  const workers = Math.max(1, Math.min(8, Number(options.concurrency) || 1));
  // A conversation whose newer customer message has no text keeps the same content: it is
  // skipped as already read and does not use one of the readings of this batch.
  let attempted = 0, next = 0;
  const stop = (reason) => { if (!batch.stoppedReason) batch.stoppedReason = reason; };
  async function worker() {
    while (!batch.stoppedReason && next < state.pending.length && attempted < wanted) {
      if (provider && !openAiBudget.fits(provider, search.MAX_CALL_USD * workers, batch.costUsd)) { stop('PROVIDER_LIMIT'); return; }
      if (Date.now() > deadlineAt) return;
      // A reading may take up to LONG_TIMEOUT_MS, but never past the function's limit: it starts
      // only with enough time left, and waits at most what is left (a slow reading used to be cut
      // at 20 s and failed again on every retry).
      const left = hardStopAt - Date.now();
      if (left < MIN_READ_MS) return;
      const chatId = state.pending[next++];
      attempted += 1;
      const out = await search.extractChat(ctx, chatId, { ...(options.extract || {}), timeoutMs: Math.min(search.LONG_TIMEOUT_MS, left) });
      // Read by someone else right now (cron and button) or already paid: never a second call.
      if (out.alreadyRead || out.inProgress) { attempted -= 1; continue; }
      if (out.error === 'OPENAI_BUDGET_LIMIT' || out.error === 'OPENAI_BUDGET_UNAVAILABLE') { stop('PROVIDER_LIMIT'); return; }
      if (out.error === 'OPENAI_QUOTA') stop('PROVIDER_QUOTA');
      if (out.error === 'OPENAI_MODEL_UNAVAILABLE') stop('MODEL_UNAVAILABLE');
      batch.conversations += out.error ? 0 : 1;
      batch.inputTokens += out.usage?.input || 0; batch.outputTokens += out.usage?.output || 0; batch.costUsd += Number(out.costUsd) || 0;
      done.push({ chatId, requests: out.requests || 0, error: out.error || null });
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  await insert(ctx, 'vehicle_request_batches', { environment: ctx.environment, provider: context.provider, model: context.model, conversations: batch.conversations,
    input_tokens: batch.inputTokens, output_tokens: batch.outputTokens, cost_usd: round6(batch.costUsd), stopped_reason: batch.stoppedReason, created_by: ctx.panel?.id || null }, false);
  const after = await historyState(ctx, context.provider);
  return progressOf(after, context, { read: done.length, failed: done.filter((item) => item.error).length, stoppedReason: batch.stoppedReason, batchCostUsd: round6(batch.costUsd) });
}

// One conversation read now for PESQUISAS (ficha "Ler conversa agora"), same rules as the batch:
// extraction on, model test passed, OpenAI prepaid balance (inside extractChat). Never sends anything.
async function extractNow(ctx, chatId) {
  const context = historyContext();
  if (context.error) return { skipped: context.status };
  if (context.provider === 'OPENAI') {
    const batches = await allRows(ctx, 'vehicle_request_batches', { select: 'provider,model,conversations,cost_usd,stopped_reason,created_at', environment: 'eq.' + ctx.environment, order: 'created_at.asc' });
    if (!modelChecked({ lastCheck: modelChecksOf(batches, 'OPENAI').at(-1) || null }, context.model)) return { skipped: 'MODEL_NOT_CHECKED' };
  }
  const out = await search.extractChat(ctx, chatId);
  return { read: !out.error && !out.alreadyRead && !out.inProgress, alreadyRead: Boolean(out.alreadyRead), requests: out.requests || 0, error: out.error || null };
}

// ------------------------------------------------------------------ gravação da comparação
const upsertCheck = (ctx, row) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/vehicle_request_checks?on_conflict=environment,request_key,criteria_hash,upload_id', {
  method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(row) });

// Each round answers well inside the 60 s limit; the panel calls again while something remains.
const COMPARE_BUDGET_MS = 35000;
// After the comparison: writing requests on fichas, then comparing them in OPÇÕES (60 s function).
const CARRY_BUDGET_MS = 30000;
const SYNC_BUDGET_MS = 48000;
async function compare(ctx, startedAt = Date.now(), skipKeys = []) {
  const list = await buildList(ctx);
  if (list.checksPending) return { status: 503, error: 'SEARCH_REQUESTS_PENDING' };
  // Requests that failed earlier in this click go last, so they never block the rest.
  const skip = new Set(Array.isArray(skipKeys) ? skipKeys.map(String) : []);
  const pending = list.items.filter((item) => item.state === 'FALTA_BUSCAR' && !skip.has(item.key));
  // A ficha/calculator demand is compared by the one mechanism of ENVIAR OPÇÕES (rematchDemands:
  // manheim_matches + manheim_demand_syncs), so BUSCAR CARROS and ENVIAR OPÇÕES change together.
  // Only a request read from a conversation and not yet on a ficha keeps its own check.
  const demandItems = pending.filter((item) => item.demandKey).slice(0, COMPARE_BATCH);
  const otherItems = pending.filter((item) => !item.demandKey).slice(0, Math.max(0, COMPARE_BATCH - demandItems.length));
  const failed = [];
  let compared = 0, uploadId = list.uploadId;
  if (demandItems.length && uploadId) {
    const done = await rematch.rematchDemands(ctx, [...new Set(demandItems.map((item) => item.demandKey))], { base: list.base, deadlineAt: startedAt + COMPARE_BUDGET_MS });
    const status = new Map(done.map((entry) => [entry.key, entry.status]));
    demandItems.forEach((item) => { const state = status.get(item.demandKey); if (state === 'DONE') compared += 1; else if (state !== 'SKIPPED_TIME') failed.push(item.key); });
  }
  if (otherItems.length && Date.now() < startedAt + COMPARE_BUDGET_MS) {
    const result = await search.compareItems(ctx, otherItems, { services: { upsertCheck }, deadlineAt: startedAt + COMPARE_BUDGET_MS });
    compared += result.compared; failed.push(...(result.failed || [])); uploadId = result.uploadId || uploadId;
  }
  const remaining = Math.max(0, pending.length - compared - failed.length);
  const out = { status: 200, uploadId, compared, failed, remaining, carried: 0, carryLeft: 0, carrySkipped: {}, options: null };
  if (remaining || !uploadId) return out;
  // Then the conversation requests reach the ficha and OPÇÕES: each complete request whose ficha
  // has no car yet is written on the ficha (same path as marking a car on the customer's message),
  // and every request whose criterion was not compared with the active batch is compared now.
  const { plan, skipped } = toFicha.carryPlan(list.items.filter((item) => !skip.has(item.key)), list.base);
  skipped.forEach((item) => { out.carrySkipped[item.reason] = (out.carrySkipped[item.reason] || 0) + 1; });
  for (const entry of plan) {
    if (Date.now() >= startedAt + CARRY_BUDGET_MS) break;
    try { await toFicha.carryOne(ctx, entry); out.carried += 1; }
    catch (error) {
      failed.push(entry.key);
      console.error('[pesquisas] levar para a ficha falhou', entry.key, String(error && (error.code || error.message) || error).slice(0, 200));
    }
  }
  out.carryLeft = Math.max(0, plan.length - out.carried - plan.filter((entry) => failed.includes(entry.key)).length);
  if (Date.now() < startedAt + SYNC_BUDGET_MS) {
    out.options = await rematch.syncStaleDemands(ctx, { deadlineAt: startedAt + SYNC_BUDGET_MS }).catch((error) => {
      console.error('[pesquisas] OPÇÕES não atualizou', String(error && (error.code || error.message) || error).slice(0, 200));
      return { stale: 0, synced: 0, remaining: 0, error: 'OPTIONS_SYNC_FAILED' };
    });
  }
  return out;
}


async function editRequest(ctx, body) {
  const list = await buildList(ctx);
  const item = list.items.find((entry) => entry.key === body.key);
  if (!item) return { status: 404, error: 'REQUEST_NOT_FOUND' };
  if (body.criteriaHash !== item.criteriaHash) return { status: 409, error: 'REQUEST_VERSION_CHANGED' };
  const index = Number(body.wishIndex) || 0;
  const wishes = item.targets?.[0]?.wishes || [item.criteria || {}];
  if (!wishes[index]) return { status: 400, error: 'REQUEST_EDIT_INVALID' };
  const requestId = item.source === 'CONVERSA' ? item.key.slice(9) : wishes[index].requestId;
  try {
    let version;
    if (requestId) {
      const [latest] = await rows(ctx,'vehicle_request_versions',{select:'id',environment:'eq.'+ctx.environment,request_id:'eq.'+requestId,order:'created_at.desc,id.desc',limit:'1'});
      version = await rpc(ctx,'panel_vehicle_request_edit',{p_environment:ctx.environment,p_actor_id:ctx.panel.id,p_request_id:requestId,p_expected_version: item.versionId || latest?.id,p_patch:body.patch});
    } else {
      const journey = list.base.journeyById.get(item.person?.journeyId);
      if (!journey) return { status: 400, error: 'REQUEST_EDIT_INVALID' };
      version = await rpc(ctx,'panel_journey_request_edit',{p_environment:ctx.environment,p_actor_id:ctx.panel.id,p_journey_id:journey.id,p_mode:item.searchMode,p_expected_updated_at:journey.updated_at,p_wishes:wishes,p_index:index,p_patch:body.patch});
    }
    if (ctx.readCache) ctx.readCache.clear();
    const after = await buildList(ctx);
    const updated = after.items.find((entry) => entry.key === item.key);
    // A conversation request keeps its own check; a ficha demand is compared by the rematch below.
    const comparison = updated && !updated.demandKey ? await search.compareItems(ctx,[updated],{services:{upsertCheck}}) : null;
    const journeyId = item.person?.journeyId;
    const keys = journeyId ? (after.base.demands.byJourney.get(journeyId) || []).filter((d) => d.active).map((d) => d.key) : [];
    const options = keys.length ? await rematch.rematchDemands(ctx,keys,{base:after.base}) : [];
    return { status: 200, saved:true, version, comparison, options };
  } catch (error) {
    if (/REQUEST_VERSION_CHANGED/.test(String(error.code || error.message))) return {status:409,error:'REQUEST_VERSION_CHANGED'};
    if (/REQUEST_(EDIT_INVALID|RANGE_INVERTED)/.test(String(error.code || error.message))) return {status:400,error:'REQUEST_EDIT_INVALID'};
    throw error;
  }
}

module.exports = async (req, res) => {
  const startedAt = Date.now();
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://painel.local');
      if (url.searchParams.get('view') === 'audit') return send(res, 200, await audit(ctx));
      const completionOnly = url.searchParams.get('view') === 'completion';
      const list = await buildList(ctx, { includeResults: !completionOnly });
      const presentAt = Date.now();
      // The ficha request and the same request read by the AI from its conversation are one
      // request on screen (the reading stays as its unconfirmed evidence); the counts follow the list.
      const shown = merge.present(list.items);
      const presentMs = Date.now() - presentAt;
      if (completionOnly) return send(res, 200, {
        items: require('../../panel-counter-summary').requestsSummary(shown.items).items,
        requestsPending: list.requestsPending
      });
      if (url.searchParams.get('summary') === '1') return send(res, 200, {
        ...require('../../panel-counter-summary').requestsSummary(shown.items),
        requestsPending: list.requestsPending, checksPending: list.checksPending
      });
      // Only the numbers the "Ordenar" of each column needs (bid, years) leave with the item; the targets stay on the server.
      const sortOf = (item) => { const target = (item.targets || [])[0] || null; const wishes = target ? target.wishes || [] : [item.criteria || {}];
        const years = wishes.flatMap((wish) => [Number(wish.yearMin) || null, Number(wish.yearMax) || null]).filter(Boolean);
        const bid = target && target.bidCents ? Math.round(target.bidCents / 100) : Number(item.criteria?.budgetUsd) || null;
        return { bidUsd: bid, yearMin: years.length ? Math.min(...years) : null, yearMax: years.length ? Math.max(...years) : null }; };
      const items = shown.items.map(({ targets, ...item }) => ({ ...item, editWishes: targets?.[0]?.wishes || (item.criteria ? [item.criteria] : []), sort: sortOf({ targets, ...item }) }));
      const totals = merge.counts(items, STATES);
      console.log('[pesquisas-get-timing]', JSON.stringify({ present: presentMs, rest: Date.now() - presentAt - presentMs }));
      return send(res, 200, { ...list, modelDictionary: ctx.modelDictionary, items, counts: Object.fromEntries(STATES.map((state) => [state, items.filter((item) => item.state === state).length])),
        totals, mergedReadings: shown.merged });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 16 * 1024);
    if (body.action === 'edit') { const { status, ...out } = await editRequest(ctx, body); return send(res, status, out); }
    if (body.action === 'compare') { const { status, ...out } = await compare(ctx, startedAt, body.skip); return send(res, status, out); }
    // Adendo, item 2: the plain-language reason of every "sem carros" (read only, never compares again).
    if (body.action === 'empty_reasons') {
      const list = await buildList(ctx);
      // keys (OPÇÕES): the demands with no car in the stored batch result, whatever PESQUISAS shows.
      const wanted = new Set((Array.isArray(body.keys) ? body.keys : []).map(String).slice(0, 250));
      const empty = list.items.filter((item) => wanted.size ? wanted.has(item.key) && item.comparable : item.state === 'SEM_OPCAO');
      if (!list.uploadId || !empty.length) return send(res, 200, { reasons: {} });
      return send(res, 200, { reasons: await emptyReasons(ctx, empty, list.uploadId, allRows) });
    }
    if (body.action === 'history_status') { const { status, ...out } = await historyStatus(ctx); return send(res, status, out); }
    if (body.action === 'model_check') { const { status, ...out } = await modelCheck(ctx); return send(res, status, out); }
    if (body.action === 'extract_history') { const { status, ...out } = await extractHistory(ctx, Number(body.limit) || 0); return send(res, status, out); }
    if (body.action === 'extract' || body.action === 'sample') {
      if (!isUuid(body.chatId)) return send(res, 400, { error: 'CHAT_INVALID' });
      const out = await search.extractChat(ctx, body.chatId, { dryRun: body.action === 'sample', timeoutMs: search.LONG_TIMEOUT_MS });
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
module.exports.extractHistory = extractHistory;
module.exports.extractNow = extractNow;

module.exports.editRequest = editRequest;

'use strict';

// Triagem da ENTRADA: a OpenAI lê uma conversa e diz se ela é pré-compra de veículo pela My Car
// Scout ou se fica fora do funil comercial (pós-venda, pessoal, outro negócio, não cliente). Só os
// casos claros são decididos; o resto fica em REVISAR, em "Precisa de você".
//
// Regras fixas deste módulo:
//  * A classificação é da conversa (chat), não da pessoa. Nunca marca o contato como não-lead, nunca
//    apaga ou envia mensagem, nunca encerra ficha, nunca mexe em demanda CARRO/VALOR ou em match.
//  * Uma ficha com Ref da calculadora é sempre pré-compra: nunca sai do funil por uma conversa.
//  * OpenAI é o único provedor desta função (a Anthropic segue só nas funções dela, sem duplicar).
//  * Desligada por padrão. Liga só com ENTRADA_OPENAI_ENABLED=1, OPENAI_API_KEY, um modelo da
//    allowlist em ENTRADA_OPENAI_MODEL e a data de corte ENTRADA_OPENAI_SINCE (só conversas com
//    mensagem nova depois dela; o acervo antigo nunca é processado sem autorização). Modelo fora da
//    allowlist desliga tudo, sem trocar por outro.
//  * Falha, tempo esgotado ou resposta inválida viram REVISAR. Mesmo conteúdo e mesma versão da
//    regra nunca são cobrados duas vezes (índice único no banco).

const crypto = require('node:crypto');
const openAiBudget = require('./panel-openai-budget');
const modelCheck = require('./panel-openai-model-check');
const { allRows, supabase } = require('./panel-server');
const aiClaim = require('./panel-ai-claim');
const { undash } = require('./text-dash');

// v2 (adendo, item 4): lê a conversa inteira e diz também se ela trata de carro (sobre_carro).
const RULE_VERSION = 'triagem-v2';
const CATEGORIES = Object.freeze(['PRE_COMPRA_MCS', 'POS_VENDA', 'PESSOAL', 'OUTRO_NEGOCIO', 'NAO_CLIENTE', 'REVISAR']);
const OUT_OF_FUNNEL = Object.freeze(['POS_VENDA', 'PESSOAL', 'OUTRO_NEGOCIO', 'NAO_CLIENTE']);
const LABELS = Object.freeze({ PRE_COMPRA_MCS: 'Pré-compra MCS', POS_VENDA: 'Pós-venda', PESSOAL: 'Pessoal', OUTRO_NEGOCIO: 'Outro negócio', NAO_CLIENTE: 'Não é cliente', REVISAR: 'Revisar' });
// US$ per 1M tokens (standard tier), OpenAI pricing page. Only for the recorded cost estimate.
const PRICES = Object.freeze({
  'gpt-6-luna': { input: 0.10, output: 0.50 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25 }
});
const APPROVED_MODELS = Object.freeze(Object.keys(PRICES));
// The whole conversation, up to 80 real messages (the first 20 and the latest 60 of a longer one),
// each cut to 300 characters: enough to tell whether cars were ever discussed, at a bounded cost.
const MAX_MESSAGES = 80;
const HEAD_MESSAGES = 20;
const MAX_TEXT = 300;
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 20000;
const BATCH_LIMIT = 10;

const decisionOf = (category) => category === 'PRE_COMPRA_MCS' ? 'FUNIL' : category === 'REVISAR' ? 'PENDENTE' : 'FORA_DO_FUNIL';

// ------------------------------------------------------------------ configuração
function model(env = process.env) {
  const configured = String(env.ENTRADA_OPENAI_MODEL || '').trim();
  return APPROVED_MODELS.includes(configured) ? configured : null;
}
function since(env = process.env) {
  const value = Date.parse(String(env.ENTRADA_OPENAI_SINCE || ''));
  return Number.isFinite(value) ? value : null;
}
function status(env = process.env) {
  if (env.ENTRADA_OPENAI_ENABLED !== '1') return 'DESLIGADA';
  if (!env.OPENAI_API_KEY) return 'SEM_CHAVE';
  if (!model(env)) return 'MODELO_INVALIDO';
  if (since(env) === null) return 'SEM_DATA_DE_CORTE';
  return 'LIGADA';
}
const enabled = (env = process.env) => status(env) === 'LIGADA';
function estimateCostUsd(modelId, inputTokens, outputTokens) {
  const price = PRICES[modelId];
  if (!price) return null;
  return Math.round(((Number(inputTokens) || 0) * price.input + (Number(outputTokens) || 0) * price.output) / 1e6 * 1e6) / 1e6;
}

// ------------------------------------------------------------------ evidência
const stampOf = (message) => Date.parse(message.occurred_at_utc || message.occurred_at_local || message.created_at || '') || 0;
// Phones, e-mails and links never leave the server.
function redact(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/https?:\/\/\S+/gi, '[link]')
    // A phone has at least 10 digits; vehicle years such as "2018-2020" stay readable.
    .replace(/\+?\d[\d\s().-]{7,}\d/g, (match) => match.replace(/\D/g, '').length >= 10 ? '[telefone]' : match)
    .replace(/[\u0000-\u001f]/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}
// The real messages of the whole conversation (both sides), oldest first. A very long conversation
// keeps its beginning and its latest part.
function evidenceFor(messages) {
  const real = (messages || []).filter((message) => message && !message.undone_at && !message.is_automatic && String(message.body_text || '').trim())
    .sort((a, b) => stampOf(a) - stampOf(b) || String(a.id).localeCompare(String(b.id)));
  const chosen = real.length > MAX_MESSAGES ? real.slice(0, HEAD_MESSAGES).concat(real.slice(-(MAX_MESSAGES - HEAD_MESSAGES))) : real;
  return chosen.map((message) => ({ id: message.id, from: message.direction === 'MCS' ? 'MCS' : message.direction === 'CUSTOMER' ? 'CLIENTE' : 'SISTEMA', text: redact(message.body_text), at: stampOf(message) }));
}
// The reading key is the newest customer message: a reply from MCS alone never triggers a new
// (paid) reading, and neither does an older message leaving the evidence window.
function contentHash(evidence) {
  const customer = evidence.filter((item) => item.from === 'CLIENTE');
  const newest = customer.at(-1) || evidence.at(-1) || { id: '' };
  return crypto.createHash('sha256').update('triagem:' + newest.id).digest('hex');
}

// ------------------------------------------------------------------ OpenAI
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['category', 'confidence', 'reason', 'evidence_ids', 'sobre_carro', 'sobre_carro_certeza'],
  properties: {
    category: { type: 'string', enum: CATEGORIES },
    sobre_carro: { type: 'boolean' },
    sobre_carro_certeza: { type: 'string', enum: ['alta', 'baixa'] },
    confidence: { type: 'string', enum: ['alta', 'media', 'baixa'] },
    reason: { type: 'string' },
    evidence_ids: { type: 'array', items: { type: 'string' } }
  }
};
const INSTRUCTIONS = [
  'Você faz a triagem de conversas do WhatsApp da My Car Scout (MCS), que compra carros em leilões de concessionárias nos EUA para clientes finais.',
  'Classifique a conversa inteira em uma categoria:',
  'PRE_COMPRA_MCS: a pessoa quer comprar um veículo pela MCS ou pergunta antes de comprar (busca de carro, orçamento, lance, leilão, disponibilidade, processo de compra).',
  'POS_VENDA: conversa sobre um veículo já comprado pela MCS (entrega, documentação, reparo, garantia, problema depois da compra).',
  'PESSOAL: amigos, família ou conversa pessoal sem relação com cliente da MCS.',
  'OUTRO_NEGOCIO: carro vendido fora do fluxo da MCS, loja, atacado, negociação paralela, fornecedor, parceiro ou assunto administrativo sem intenção de compra pela MCS.',
  'NAO_CLIENTE: spam, número errado, contato sem relação comercial.',
  'REVISAR: contexto insuficiente, dúvida real ou sinais conflitantes.',
  'Nunca decida por uma palavra isolada. "Is it sold?" ou "já vendeu?" sobre um carro oferecido é pré-compra. Mencionar um carro vendido não basta para tirar a pessoa do funil. Uma conversa pessoal antiga não impede uma nova intenção de compra: se a parte mais recente mostra intenção de comprar, é PRE_COMPRA_MCS.',
  'Use confidence "alta" só quando o caso for claro. reason: uma frase curta em português, sem nomes e sem dados pessoais. evidence_ids: os ids das mensagens que justificam.',
  'sobre_carro: olhe a conversa inteira, do começo ao fim. true quando em algum momento ela cita um veículo, compra de veículo, financiamento de veículo, orçamento ou um serviço da MCS (busca, leilão, lance, transporte, título). false só quando a conversa nunca tratou de nada disso. sobre_carro_certeza: "alta" só quando tiver certeza; na dúvida use sobre_carro true.'
].join('\n');

async function classify(evidence, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const modelId = model(env);
  if (!enabled(env)) { const failure = new Error('OPENAI_NOT_ENABLED'); failure.code = 'OPENAI_NOT_ENABLED'; throw failure; }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  if (timer.unref) timer.unref();
  const body = {
    model: modelId,
    messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: JSON.stringify({ mensagens: evidence.map((item) => ({ id: item.id, de: item.from, texto: item.text })) }) }],
    response_format: { type: 'json_schema', json_schema: { name: 'triagem_entrada', strict: true, schema: SCHEMA } }
  };
  // The US$ 50 OpenAI reservation around the call (options.guard, panel-openai-budget).
  return require('./panel-openai-budget').paidCall(options.guard, { modelId, body, send: async (capped) => {
  try {
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify(capped)
    });
    if (!response.ok) { const failure = new Error('OPENAI_FAILED'); failure.code = response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_FAILED'; throw failure; }
    const payload = await response.json();
    const usage = { inputTokens: Number(payload?.usage?.prompt_tokens) || 0, outputTokens: Number(payload?.usage?.completion_tokens) || 0 };
    let parsed = null;
    try { parsed = JSON.parse(payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
    return { ...validated(parsed, evidence), usage, model: modelId, costUsd: estimateCostUsd(modelId, usage.inputTokens, usage.outputTokens) };
  } catch (failure) {
    if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
    throw failure;
  } finally { clearTimeout(timer); }
  } });
}

// Server-side check of the structured answer: an unknown category, a missing reason, evidence
// that was not sent or a confidence below "alta" never decides anything (it becomes REVISAR).
// sobre_carro: only a sure "false" takes a conversation out of the main flow; anything else
// (missing, unsure, invalid answer) is null or true and the conversation stays.
function aboutCarOf(parsed) {
  if (!parsed || typeof parsed.sobre_carro !== 'boolean') return null;
  if (parsed.sobre_carro === false && parsed.sobre_carro_certeza !== 'alta') return true;
  return parsed.sobre_carro;
}
function validated(parsed, evidence) {
  return { ...validatedCategory(parsed, evidence), aboutCar: aboutCarOf(parsed) };
}
function validatedCategory(parsed, evidence) {
  const known = new Set(evidence.map((item) => item.id));
  const reason = typeof parsed?.reason === 'string' ? undash(parsed.reason.replace(/[\u0000-\u001f]/g, ' ')).trim().slice(0, 280).replace(/[.\s]+$/, '') : '';
  const ids = Array.isArray(parsed?.evidence_ids) ? [...new Set(parsed.evidence_ids.map(String))].filter((value) => known.has(value)) : [];
  if (!parsed || !CATEGORIES.includes(parsed.category)) return { category: 'REVISAR', reason: 'Resposta da IA inválida', evidence: [], errorCode: 'OPENAI_RESPONSE_INVALID' };
  if (!reason || (parsed.category !== 'REVISAR' && !ids.length)) return { category: 'REVISAR', reason: 'Resposta da IA sem justificativa', evidence: ids, errorCode: 'OPENAI_RESPONSE_INVALID' };
  if (parsed.category !== 'REVISAR' && parsed.confidence !== 'alta') return { category: 'REVISAR', reason: 'Classificação insegura: ' + reason, evidence: ids, errorCode: null };
  return { category: parsed.category, reason, evidence: ids, errorCode: null };
}

// ------------------------------------------------------------------ gravação
async function record(ctx, entry) {
  const result = await recordCategory(ctx, entry);
  // The topic answer goes on the AI row just written (or the same reading found again). Only a real
  // answer is kept; a failure leaves it empty (= no reading, stays in the main flow).
  if (entry.source === 'AI' && typeof entry.aboutCar === 'boolean' && result && result.id) {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/conversation_triage?environment=eq.' + ctx.environment + '&id=eq.' + result.id + '&source=eq.AI', {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ about_car: entry.aboutCar })
    }).catch(() => null);
  }
  return result;
}
async function recordCategory(ctx, entry) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_conversation_triage_record', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      p_environment: ctx.environment, p_chat_id: entry.chatId, p_journey_id: entry.journeyId || null, p_source: entry.source, p_category: entry.category,
      p_reason: entry.reason || '', p_evidence: entry.evidence || [], p_last_message_at: entry.lastMessageAt || null, p_content_hash: entry.contentHash,
      p_rule_version: entry.ruleVersion || RULE_VERSION, p_provider: entry.source === 'AI' ? 'openai' : null, p_model: entry.model || null,
      p_input_tokens: entry.inputTokens ?? null, p_output_tokens: entry.outputTokens ?? null, p_cost_usd: entry.costUsd ?? null,
      p_error_code: entry.errorCode || null, p_actor_id: entry.actorId || null
    })
  });
}
async function undo(ctx, triageId, actorId) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_conversation_triage_undo', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment, p_triage_id: triageId, p_actor_id: actorId })
  });
}

// ------------------------------------------------------------------ leitura
// The table may not exist yet (migration not applied): then nothing is triaged and every list
// stays exactly as before.
// The lists tolerate it; the automatic reading does not (strict): a failed read never looks like
// "nothing classified yet", which would pay again for conversations already read.
async function activeRows(ctx, read = allRows, strict = false) {
  try { return await read(ctx, 'conversation_triage', { select: 'id,chat_id,journey_id,source,category,decision,reason,evidence_message_ids,last_message_at,content_hash,rule_version,model,error_code,attempts,created_at,created_by', environment: 'eq.' + ctx.environment, status: 'eq.ACTIVE' }) || []; }
  catch (error) { if (strict) throw error; if (process.env.MODO_DEBUG) console.warn('[triage] leitura indisponível', error?.code || error?.message); return []; }
}
// A paid answer that came back invalid is final (REVISAR): retrying it would pay again for the
// same content. Only failures without an answer (timeout, HTTP error) are retried.
const FINAL_ERRORS = new Set(['OPENAI_RESPONSE_INVALID']);
const settled = (row) => !row.error_code || FINAL_ERRORS.has(row.error_code) || row.attempts >= MAX_ATTEMPTS;
// A ficha leaves the commercial lists only when every active triage of its conversations is out of
// the funnel and it has no calculator Ref. REVISAR and PRE_COMPRA keep it in.
function outOfFunnelJourneys(triage, journeys, refs) {
  // Every ficha gets an internal reference_code at birth, so only a linked Ref (journey_refs) counts.
  const withRef = new Set((refs || []).map((row) => row.journey_id));
  const byJourney = new Map();
  (triage || []).forEach((row) => { if (!row.journey_id) return; if (!byJourney.has(row.journey_id)) byJourney.set(row.journey_id, []); byJourney.get(row.journey_id).push(row); });
  const out = new Set();
  byJourney.forEach((rows, journeyId) => { if (!withRef.has(journeyId) && rows.every((row) => row.decision === 'FORA_DO_FUNIL')) out.add(journeyId); });
  return out;
}
async function outOfFunnelIndex(ctx, journeys, refs, read = allRows) {
  return outOfFunnelJourneys(await activeRows(ctx, read), journeys, refs);
}

// ------------------------------------------------------------------ execução automática
// Conversations with a real message after the cut-off date whose current content has no reading.
async function candidates(ctx, options = {}) {
  const read = options.allRows || allRows;
  // onlyChats + ignoreCutoff: the separate run for the conversations in "Precisa de você".
  const cutoff = options.ignoreCutoff ? null : options.since ?? since(options.env || process.env);
  const env = 'eq.' + ctx.environment;
  const [chats, messages, links, active, readings] = await Promise.all([
    read(ctx, 'chats', { select: 'id,contact_id,is_group', environment: env }),
    read(ctx, 'messages', { select: 'id,chat_id,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: env, order: 'id.asc' }),
    read(ctx, 'message_journeys', { select: 'message_id,journey_id', environment: env, undone_at: 'is.null', order: 'message_id.asc' }),
    activeRows(ctx, read, true),
    read(ctx, 'conversation_triage', { select: 'chat_id,content_hash,rule_version,source,error_code,attempts', environment: env })
  ]);
  const journeyOf = new Map(links.map((link) => [link.message_id, link.journey_id]));
  const byChat = new Map();
  messages.forEach((message) => { if (!byChat.has(message.chat_id)) byChat.set(message.chat_id, []); byChat.get(message.chat_id).push(message); });
  const done = new Set(readings.filter((row) => row.source === 'AI' && settled(row)).map((row) => row.chat_id + ':' + row.content_hash + ':' + row.rule_version));
  const activeByChat = new Map(active.map((row) => [row.chat_id, row]));
  const list = [];
  chats.filter((chat) => !chat.is_group && (!options.onlyChats || options.onlyChats.has(chat.id))).forEach((chat) => {
    const own = byChat.get(chat.id) || [];
    const customer = own.filter((message) => message.direction === 'CUSTOMER' && !message.undone_at && !message.is_automatic);
    if (!customer.length) return;
    const newest = Math.max(...customer.map((message) => Math.max(stampOf(message), Date.parse(message.created_at || '') || 0)));
    if (cutoff !== null && customer.every((message) => stampOf(message) < cutoff || (Date.parse(message.created_at || '') || 0) < cutoff)) return;
    const evidence = evidenceFor(own);
    if (!evidence.length) return;
    const hash = contentHash(evidence);
    if (done.has(chat.id + ':' + hash + ':' + RULE_VERSION)) return;
    const current = activeByChat.get(chat.id);
    if (current && current.content_hash === hash && settled(current)) return;
    const journeyId = [...own].sort((a, b) => stampOf(b) - stampOf(a)).map((message) => journeyOf.get(message.id)).find(Boolean) || null;
    list.push({ chatId: chat.id, journeyId, evidence, contentHash: hash, lastMessageAt: new Date(newest).toISOString() });
  });
  return list.sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt));
}

// The conversations waiting in "Precisa de você": exactly the source chat of each pending AI
// suggestion (never every chat of the same contact). Read once and apart from the rest of the
// backlog, which is never read without a new authorization.
async function pendingChats(ctx, read = allRows) {
  const suggestions = await read(ctx, 'whatsapp_link_suggestions', { select: 'source_chat_id', environment: 'eq.' + ctx.environment, status: 'eq.PENDING', suggestion_kind: 'eq.AI' });
  return new Set(suggestions.map((row) => row.source_chat_id).filter(Boolean));
}
async function runPending(ctx, options = {}) {
  const chats = await pendingChats(ctx, options.allRows);
  if (!chats.size) return { processed: 0, pendingConversations: 0 };
  return runTriage(ctx, { ...options, onlyChats: chats, ignoreCutoff: true, limit: options.limit || 30 });
}

async function runTriage(ctx, options = {}) {
  const env = options.env || process.env;
  const state = status(env);
  if (state !== 'LIGADA') return { skipped: state, processed: 0 };
  const pending = (await candidates(ctx, { ...options, env })).slice(0, options.limit || BATCH_LIMIT);
  const result = { processed: 0, funnel: 0, out: 0, review: 0, failed: 0, costUsd: 0, inProgress: 0 };
  const claims = options.claims || aiClaim;
  // US$ 50 for all the panel's OpenAI features together (panel-openai-budget).
  const budget = options.budget || openAiBudget;
  const provider = pending.length ? await budget.spentUsd(ctx) : null;
  // The minimal model test (no customer data) must have passed before the first real reading.
  if (pending.length) { const check = await (options.modelCheck || modelCheck.ensureModelChecked)(ctx, model(env)); if (!check.ok) return { ...result, stoppedReason: 'MODEL_NOT_CHECKED', error: check.error }; }
  for (const item of pending) {
    // Never start a paid call that the function could be stopped in the middle of.
    if (options.deadlineAt && Date.now() + TIMEOUT_MS + 5000 > options.deadlineAt) { result.deferred = pending.length - result.processed - result.inProgress; break; }
    if (!budget.fits(provider, budget.MAX_CALL_USD, result.costUsd)) { result.stoppedReason = 'PROVIDER_LIMIT'; result.deferred = pending.length - result.processed - result.inProgress; break; }
    // Only the run that wins the reservation calls OpenAI (cron and button at the same time).
    const claim = await claims.claimTask(ctx, { kind: 'ENTRADA_TRIAGE', subject: item.chatId, hash: item.contentHash, rule: RULE_VERSION });
    if (!claim.claimed) { result.inProgress += 1; continue; }
    let entry, retryable = false;
    const guard = budget.guard ? budget.guard(ctx, 'ENTRADA', item.chatId, options.budgetServices) : null;
    try {
      const answer = await classify(item.evidence, { env, fetchImpl: options.fetchImpl, guard });
      entry = { ...item, source: 'AI', category: answer.category, reason: answer.reason, evidence: answer.evidence, model: answer.model, aboutCar: answer.aboutCar ?? null,
        inputTokens: answer.usage.inputTokens, outputTokens: answer.usage.outputTokens, costUsd: answer.costUsd, errorCode: answer.errorCode };
      result.costUsd += answer.costUsd || 0;
    } catch (failure) {
      // No room in the US$ 50 (or the ceiling could not be read): nothing was called; stop here.
      if (failure && (failure.code === 'OPENAI_BUDGET_LIMIT' || failure.code === 'OPENAI_BUDGET_UNAVAILABLE')) {
        await claims.finishTask(ctx, claim, false).catch(() => null);
        result.stoppedReason = 'PROVIDER_LIMIT'; result.deferred = pending.length - result.processed - result.inProgress; break;
      }
      // Failure, timeout or invalid answer: the conversation stays pending in REVISAR.
      entry = { ...item, source: 'AI', category: 'REVISAR', reason: 'IA indisponível, decidir manualmente', evidence: [], model: model(env), errorCode: failure?.code || 'OPENAI_FAILED' };
      result.failed += 1;
      retryable = true;
    }
    try { await (options.record || record)(ctx, entry); }
    catch (error) {
      // A paid answer that could not be written keeps its cost on the reservation and is not paid
      // again (the reservation of the task stays done); an unpaid failure may be retried.
      await claims.finishTask(ctx, claim, !retryable).catch(() => null); throw error;
    }
    if (budget.recorded) await budget.recorded(guard);
    // A failure without an answer may be retried; an answer (valid or not) is final for this content.
    await claims.finishTask(ctx, claim, !retryable);
    result.processed += 1;
    if (entry.category === 'PRE_COMPRA_MCS') result.funnel += 1; else if (entry.category === 'REVISAR') result.review += 1; else result.out += 1;
  }
  result.costUsd = Math.round(result.costUsd * 1e6) / 1e6;
  return result;
}

// ------------------------------------------------------------------ estimativa do acervo
// Counts what a one-time reading of the existing conversations would cost, without calling anyone.
function estimate(conversations, modelId) {
  const system = Math.ceil(INSTRUCTIONS.length / 4) + 120;
  let input = 0, messages = 0;
  conversations.forEach((evidence) => { messages += evidence.length; input += system + evidence.reduce((sum, item) => sum + Math.ceil(item.text.length / 4) + 18, 0); });
  const output = conversations.length * 100;
  const price = PRICES[modelId];
  return { conversations: conversations.length, messages, inputTokens: input, outputTokens: output, model: modelId || null, costUsd: price ? estimateCostUsd(modelId, input, output) : null };
}

module.exports = {
  RULE_VERSION, CATEGORIES, OUT_OF_FUNNEL, LABELS, APPROVED_MODELS, PRICES, INSTRUCTIONS, MAX_ATTEMPTS,
  decisionOf, model, since, status, enabled, estimateCostUsd, redact, evidenceFor, contentHash, classify, validated, aboutCarOf,
  record, undo, activeRows, outOfFunnelJourneys, outOfFunnelIndex, candidates, runTriage, runPending, pendingChats, estimate
};

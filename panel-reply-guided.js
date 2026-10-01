'use strict';

// Ficha › CONVERSA: duas ferramentas novas, separadas da sugestão automática (panel-reply-suggest.js,
// que continua igual) e que reaproveitam o mesmo caso, o mesmo Brief e o mesmo teto de US$ 50.
//  1. Resposta orientada: o operador escreve em português o que quer transmitir; a IA redige a
//     mensagem no idioma do cliente, com tradução, e aponta o que conflita com a ficha ou a conversa.
//  2. Tradução da conversa: sob demanda, por mensagem (ID + conteúdo), guardada e reaproveitada.
// Nada aqui envia mensagem nem altera as mensagens originais.
const crypto = require('node:crypto');
const { insert, isUuid, rows } = require('./panel-server');
const openAiBudget = require('./panel-openai-budget');
const triage = require('./panel-triage');
const reply = require('./api/panel/reply');
const suggest = require('./panel-reply-suggest');
const { undash } = require('./text-dash');

const I = suggest.internals;
const GUIDANCE_MAX = 1500;
// 20 messages of up to 1000 characters fit the output cap of one call.
const TRANSLATE_MAX_MESSAGES = 20;
const TRANSLATE_MAX_CHARS = 1000;

// ------------------------------------------------------------------ chamada à OpenAI (mesmo modelo e teto)
async function openAiJson({ instructions, input, schema, name }, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const modelId = suggest.model(env);
  const body = {
    model: modelId,
    messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(input) }],
    response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } }
  };
  return openAiBudget.paidCall(options.guard, { modelId, body, send: async (capped) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || I.TIMEOUT_MS);
    try {
      const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: JSON.stringify(capped)
      });
      if (!response.ok) { const failure = new Error('OPENAI_FAILED'); failure.code = response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_FAILED'; throw failure; }
      const payload = await response.json();
      const usage = { inputTokens: Number(payload?.usage?.prompt_tokens) || 0, outputTokens: Number(payload?.usage?.completion_tokens) || 0 };
      let parsed = null;
      try { parsed = JSON.parse(payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
      return { parsed, usage, model: modelId, costUsd: triage.estimateCostUsd(modelId, usage.inputTokens, usage.outputTokens) };
    } catch (failure) {
      if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
      throw failure;
    } finally { clearTimeout(timer); }
  } });
}
// The cost goes to the audit log (counted in the US$ 50 ceiling); then the hold stops counting.
async function recordCost(ctx, guard, entity, entityId, action, result, extra, services) {
  const saved = await (services.insert || insert)(ctx, 'audit_log', { environment: ctx.environment, actor_user_id: ctx.panel.id, entity_type: entity, entity_id: entityId, action,
    after_json: { provider: 'openai', model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.costUsd, ...extra } }, false).then(() => true, () => false);
  if (saved) await openAiBudget.recorded(guard);
}
const aiFailure = (failure) => {
  const code = failure && failure.code || 'OPENAI_FAILED';
  return { status: code === 'OPENAI_BUDGET_LIMIT' ? 402 : 503, error: code === 'OPENAI_BUDGET_LIMIT' ? 'OPENAI_BUDGET_LIMIT' : 'AI_UNAVAILABLE', detail: code };
};

// ------------------------------------------------------------------ 1. resposta orientada
const GUIDED_INSTRUCTIONS = suggest.INSTRUCTIONS + '\n' + [
  'MODO ORIENTADO (modo=ORIENTADA): o operador escreveu em "orientacao", em português, o que quer transmitir ao cliente. Redija UMA mensagem natural de WhatsApp no idioma do cliente que transmita esses pontos, como alguém que trabalha no mercado: não traduza palavra por palavra e não repita mecanicamente a orientação. Siga o mesmo tom, condução e regras acima (incluindo MESA).',
  'Use só fatos da orientação, do histórico e da ficha. Não acrescente dado de veículo (ano, milhagem, preço, lance, condição, título, histórico, disponibilidade) que não esteja na orientação, na conversa ou na ficha.',
  'CONFLITO: se um ponto da orientação contradiz um fato registrado na ficha ou dito na conversa, NÃO escolha em silêncio: deixe esse ponto neutro na resposta (sem nenhum dos dois valores) e liste em conflitos o ponto da orientação, o dado registrado e a fonte ("ficha" ou "conversa").',
  'traducao_resposta_pt: tradução para português da sua resposta (vazio se já for português). conflitos, fatos_usados e alertas sempre em português.'
].join('\n');
const GUIDED_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['idioma_cliente', 'resposta', 'traducao_resposta_pt', 'conflitos', 'fatos_usados', 'alertas'],
  properties: {
    idioma_cliente: { type: 'string', enum: ['pt', 'en', 'es'] },
    resposta: { type: 'string' },
    traducao_resposta_pt: { type: 'string' },
    conflitos: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ponto', 'dado_registrado', 'fonte'], properties: { ponto: { type: 'string' }, dado_registrado: { type: 'string' }, fonte: { type: 'string', enum: ['ficha', 'conversa'] } } } },
    fatos_usados: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fato', 'situacao'], properties: { fato: { type: 'string' }, situacao: { type: 'string', enum: ['CONFIRMADO', 'INFERIDO', 'DESCONHECIDO'] } } } },
    alertas: { type: 'array', items: { type: 'string' } }
  }
};

// Numbers in the guidance that contradict the ficha (checked by the panel, not only by the AI):
// a year outside the ficha's years, a mileage above its limit, a bid different from its bid.
// "25.000" and "25,000" are both twenty-five thousand; "2.5" stays 2.5.
const numberOf = (text) => Number(String(text).replace(/[.,](?=\d{3}(?!\d))/g, '').replace(',', '.').replace(/[^\d.]/g, '')) || null;
function rangeOf(value) {
  const numbers = [...String(value || '').matchAll(/(\d[\d,.]*)\s*(k|mil)?(?![\p{L}])/giu)].map((match) => (numberOf(match[1]) || 0) * (match[2] ? 1000 : 1)).filter((number) => Number.isFinite(number) && number > 0);
  if (!numbers.length) return null;
  const text = String(value).toLowerCase();
  if (/a partir de|from|or newer|ou mais novo/.test(text)) return { min: numbers[0], max: Infinity };
  if (/^at[eé](?![\p{L}])|up to|under|menos de/u.test(text.trim())) return { min: -Infinity, max: numbers[0] };
  return { min: Math.min(...numbers), max: Math.max(...numbers) };
}
function conflictsOf(guidance, fields) {
  const byKey = new Map((fields || []).filter((field) => field && field.value).map((field) => [field.key, field]));
  const text = String(guidance || '');
  const out = [];
  const years = byKey.get('anos') && rangeOf(byKey.get('anos').value);
  if (years) [...text.matchAll(/(?<![\d$.,]\s?)\b(19[89]\d|20[0-3]\d)\b(?![.,]\d)(?!\s*(?:k|mil|milhas|miles|mi|d[oó]lares|usd)\b)/gi)].map((match) => Number(match[1])).forEach((year) => {
    if (year < years.min || year > years.max) out.push({ point: `Ano ${year} na orientação`, recorded: `${byKey.get('anos').label}: ${byKey.get('anos').value}`, source: 'ficha' });
  });
  const miles = byKey.get('milhas') && rangeOf(byKey.get('milhas').value);
  if (miles) [...text.matchAll(/(\d[\d,.]*)\s*(k|mil)?\s*(milhas|miles|mi)\b/gi)].forEach((match) => {
    const value = numberOf(match[1]) * (match[2] ? 1000 : 1);
    if (value && value > miles.max) out.push({ point: `${match[0].trim()} na orientação`, recorded: `${byKey.get('milhas').label}: ${byKey.get('milhas').value}`, source: 'ficha' });
  });
  const bid = byKey.get('valor');
  if (bid && /lance|bid|limite|m[aá]ximo/i.test(text)) {
    const recorded = numberOf(bid.value);
    [...text.matchAll(/(?:US\$|\$)\s*(\d[\d,.]*)\s*(k|mil)?|(\d[\d,.]*)\s*(k|mil)\b(?!\s*(?:milhas|miles|mi)\b)/gi)].forEach((match) => {
      const value = numberOf(match[1] || match[3]) * ((match[2] || match[4]) ? 1000 : 1);
      if (recorded && value && Math.abs(value - recorded) / recorded > 0.02) out.push({ point: `${match[0].trim()} na orientação`, recorded: `${bid.label}: ${bid.value}`, source: 'ficha' });
    });
  }
  return out;
}

function simulatedGuided({ guidance, language, name }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const points = String(guidance).trim().replace(/\s+/g, ' ');
  const text = language === 'en' ? `Hi${first ? ' ' + first : ''}, quick update on your search: ${points}`
    : language === 'es' ? `Hola${first ? ' ' + first : ''}, una actualización sobre tu búsqueda: ${points}`
      : `Oi${first ? ' ' + first : ''}, uma atualização da sua busca: ${points}`;
  return { idioma_cliente: language || 'pt', resposta: text, traducao_resposta_pt: language && language !== 'pt' ? `Oi${first ? ' ' + first : ''}, uma atualização da sua busca: ${points}` : '', conflitos: [], fatos_usados: [], alertas: ['Resposta simulada: neste ambiente a IA não é chamada'] };
}

const runningGuided = new Set();
async function guided(ctx, body, services = {}) {
  const journeyId = String(body.journeyId || '');
  if (!isUuid(journeyId)) return { status: 400, error: 'JOURNEY_INVALID' };
  const guidance = String(body.guidance || '').replace(/\r\n/g, '\n').trim();
  // Empty guidance: nothing is called and nothing is spent.
  if (!guidance) return { status: 400, error: 'GUIDANCE_REQUIRED' };
  if (guidance.length > GUIDANCE_MAX) return { status: 400, error: 'GUIDANCE_TOO_LONG' };
  if (runningGuided.has(journeyId)) return { status: 409, error: 'SUGGESTION_IN_PROGRESS' };
  runningGuided.add(journeyId);
  try {
    const found = await I.loadCase(ctx, journeyId, services);
    if (!found) return { status: 404, error: 'LEAD_NOT_FOUND' };
    const real = I.realOf(found.messages);
    if (!real.length) return { status: 409, error: 'NO_CONVERSATION' };
    const optOut = suggest.optOutOf(found.messages);
    const blocked = suggest.blockOf({ ...found, optOut });
    // Same safety as the suggestion: never a message for someone who asked not to be contacted.
    if (blocked && blocked.code === 'OPT_OUT') return { status: 409, error: 'SUGGESTION_BLOCKED', reason: blocked };
    const shared = await I.sharedRefsOf(ctx, found.journey, services.rows || rows);
    if (shared.length) return { status: 409, error: 'SUGGESTION_BLOCKED', reason: I.ambiguityBlock(shared) };
    const target = await (services.resolveTarget || reply.resolveTarget)(ctx, journeyId, { rows: services.rows || rows });
    const window = target ? await (services.windowState || reply.windowState)(ctx, target.chat.id, { rows: services.rows || rows }) : { allowed: false };
    const context = await (services.clientContext || I.defaultContext)(ctx, journeyId);
    const fields = (context && context.fields || []).map((item) => ({ key: item.key, label: item.label, value: item.value, status: item.status, statusLabel: item.statusLabel }));
    const gap = suggest.searchGap(fields, context);
    const lastCustomer = real.filter((message) => message.direction === 'CUSTOMER').at(-1) || null;
    const last = real.at(-1);
    const language = suggest.detectLanguage(real.filter((message) => message.direction === 'CUSTOMER').slice(-5).map((message) => message.body_text).join(' '));
    const conversation = found.messages.filter((message) => !message.undone_at && String(message.body_text || '').trim() && ['CUSTOMER', 'MCS'].includes(message.direction))
      .sort((a, b) => I.stamp(a) - I.stamp(b)).slice(-I.MAX_CONTEXT_MESSAGES)
      .map((message) => ({ de: message.direction === 'CUSTOMER' ? 'cliente' : 'MCS', automatica: message.is_automatic === true, quando: I.messageAt(message), texto: String(message.body_text).slice(0, I.MAX_MESSAGE_CHARS) }));
    const input = {
      modo: 'ORIENTADA', orientacao: guidance, hoje: new Date().toISOString().slice(0, 10),
      cliente: { nome: found.contact && found.contact.display_name || null, origem: context && context.origin ? context.origin.label : null },
      ficha: fields.filter((item) => item.value).map((item) => ({ campo: item.label, valor: item.value, situacao: item.statusLabel })),
      busca: gap, etapa: context && context.stage ? context.stage.label : null,
      v1_enviada: context && context.v1 && context.v1.at ? { quando: context.v1.at } : null,
      conversa: conversation
    };
    const env = services.env || process.env;
    let raw, simulated = false, costUsd = 0, usedModel = null;
    if (!suggest.enabled(env)) { raw = simulatedGuided({ guidance, language, name: found.contact && found.contact.display_name }); simulated = true; }
    else {
      const check = await (services.modelCheck || require('./panel-openai-model-check').ensureModelChecked)(ctx, suggest.model(env));
      if (!check.ok) return { status: 503, error: 'AI_UNAVAILABLE', detail: check.error || 'MODEL_NOT_CHECKED' };
      const guard = openAiBudget.guard(ctx, 'RESPOSTA_ORIENTADA', 'orientada:' + journeyId, services.budgetServices);
      let result;
      try { result = await (services.openAi || openAiJson)({ instructions: GUIDED_INSTRUCTIONS, input, schema: GUIDED_SCHEMA, name: 'resposta_orientada' }, { env, guard, fetchImpl: services.fetchImpl }); }
      catch (failure) { return aiFailure(failure); }
      await recordCost(ctx, guard, 'reply_guided_openai', journeyId, 'GUIDED', result, {}, services);
      raw = result.parsed; costUsd = result.costUsd; usedModel = result.model;
      if (!raw || typeof raw.resposta !== 'string' || !raw.resposta.trim()) return { status: 502, error: 'AI_RESPONSE_INVALID' };
    }
    const reviewed = suggest.review(raw.resposta);
    const lang = suggest.LANGS[raw.idioma_cliente] ? raw.idioma_cliente : language || 'pt';
    const warnings = [...(raw.alertas || []).map(String).slice(0, 5), ...reviewed.warnings];
    const crossed = suggest.typeViolation(reviewed.text, gap);
    if (crossed) warnings.unshift(crossed + ': revise antes de usar');
    // What conflicts with the record: the panel's own check plus what the AI pointed out.
    const conflicts = [...conflictsOf(guidance, fields), ...(raw.conflitos || []).filter((item) => item && item.ponto).map((item) => ({ point: String(item.ponto).slice(0, 200), recorded: String(item.dado_registrado || '').slice(0, 200), source: item.fonte === 'conversa' ? 'conversa' : 'ficha' }))]
      .filter((item, index, list) => list.findIndex((other) => other.point === item.point && other.recorded === item.recorded) === index).slice(0, 8);
    const facts = (raw.fatos_usados || []).filter((item) => item && item.fato).slice(0, 10).map((item) => ({ text: String(item.fato).slice(0, 200), status: ['CONFIRMADO', 'INFERIDO', 'DESCONHECIDO'].includes(item.situacao) ? item.situacao : 'INFERIDO' }));
    return {
      status: 200, journeyId, mode: 'ORIENTADA', guidance, simulated, model: usedModel, costUsd,
      language: { code: lang, label: suggest.LANGS[lang] },
      received: lastCustomer ? { text: String(lastCustomer.body_text || '').slice(0, 2000), at: I.messageAt(lastCustomer), translationPt: null } : null,
      last: { from: last.direction, at: I.messageAt(last) },
      suggestion: { text: reviewed.text, translationPt: lang === 'pt' ? null : undash(raw.traducao_resposta_pt).trim() || null, questionPurpose: null },
      conflicts, facts, warnings, notice: blocked ? blocked.text : null,
      contact: target ? { name: target.name, phone: target.phone } : null,
      reachable: Boolean(target), path: suggest.pathFor(window), whatsappBase: target ? suggest.waLink(target.phone, '') : null
    };
  } finally { runningGuided.delete(journeyId); }
}

// ------------------------------------------------------------------ 2. tradução da conversa
const TRANSLATE_INSTRUCTIONS = [
  'Você traduz mensagens de WhatsApp de clientes e da equipe da My Car Scout para português do Brasil, só para leitura interna da equipe.',
  'Traduza cada mensagem inteira, com fidelidade: não resuma, não comente, não complete. Mantenha nomes, números, anos, milhagens, valores, modelos e marcas de carro, siglas e links como estão.',
  'idioma: o idioma original da mensagem (pt, en, es ou outro). Se a mensagem já estiver em português, texto_pt fica vazio.',
  'Responda SOMENTE o JSON do esquema, com um item por mensagem recebida e o mesmo id.'
].join('\n');
const TRANSLATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['traducoes'],
  properties: { traducoes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'idioma', 'texto_pt'], properties: { id: { type: 'string' }, idioma: { type: 'string', enum: ['pt', 'en', 'es', 'outro'] }, texto_pt: { type: 'string' } } } } }
};
const contentHash = (text) => crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 32);
// A message worth translating: English or Spanish text (Portuguese and unreadable text never are).
const foreign = (message) => ['en', 'es'].includes(suggest.detectLanguage(message.body_text));

async function messagesOf(ctx, journeyId, services) {
  const found = await I.loadCase(ctx, journeyId, services);
  if (!found) return null;
  return found.messages.filter((message) => !message.undone_at && String(message.body_text || '').trim() && ['CUSTOMER', 'MCS'].includes(message.direction));
}
async function cachedFor(ctx, messages, services) {
  const read = services.rows || rows;
  const ids = messages.map((message) => message.id).filter(isUuid);
  const cached = [];
  for (let index = 0; index < ids.length; index += 100) {
    cached.push(...await read(ctx, 'message_translations', { select: 'message_id,content_hash,source_lang,text_pt', environment: 'eq.' + ctx.environment, ...(ctx.environment === 'production' ? { simulated: 'eq.false' } : {}), message_id: 'in.(' + ids.slice(index, index + 100).join(',') + ')' }));
  }
  const byKey = new Map(cached.map((row) => [row.message_id + '|' + row.content_hash, row]));
  const out = {};
  messages.forEach((message) => {
    const row = byKey.get(message.id + '|' + contentHash(message.body_text));
    if (row && row.text_pt) out[message.id] = { textPt: row.text_pt, lang: row.source_lang };
  });
  return out;
}

// Saved translations of this ficha's messages (no call, no cost) and which messages could be translated.
async function translations(ctx, body, services = {}) {
  const journeyId = String(body.journeyId || '');
  if (!isUuid(journeyId)) return { status: 400, error: 'JOURNEY_INVALID' };
  const messages = await messagesOf(ctx, journeyId, services);
  if (!messages) return { status: 404, error: 'LEAD_NOT_FOUND' };
  let saved;
  try { saved = await cachedFor(ctx, messages, services); } catch (_) { return { status: 503, error: 'TRANSLATION_PENDING' }; }
  return { status: 200, journeyId, translations: saved, translatable: messages.filter((message) => foreign(message) && !saved[message.id]).map((message) => message.id) };
}

const runningTranslation = new Set();
async function translate(ctx, body, services = {}) {
  const journeyId = String(body.journeyId || '');
  if (!isUuid(journeyId)) return { status: 400, error: 'JOURNEY_INVALID' };
  const wanted = Array.isArray(body.messageIds) ? [...new Set(body.messageIds.map(String).filter(isUuid))].slice(0, TRANSLATE_MAX_MESSAGES) : [];
  if (!wanted.length) return { status: 400, error: 'MESSAGES_REQUIRED' };
  if (runningTranslation.has(journeyId)) return { status: 409, error: 'TRANSLATION_IN_PROGRESS' };
  runningTranslation.add(journeyId);
  try {
    const messages = await messagesOf(ctx, journeyId, services);
    if (!messages) return { status: 404, error: 'LEAD_NOT_FOUND' };
    // Only this ficha's messages; never another client's message by id.
    const own = messages.filter((message) => wanted.includes(message.id));
    let saved;
    try { saved = await cachedFor(ctx, own, services); } catch (_) { return { status: 503, error: 'TRANSLATION_PENDING' }; }
    const missing = own.filter((message) => foreign(message) && !saved[message.id]);
    const env = services.env || process.env;
    let simulated = false, costUsd = 0, usedModel = null;
    if (missing.length) {
      let items;
      if (!suggest.enabled(env)) {
        simulated = true;
        items = missing.map((message) => ({ id: message.id, idioma: suggest.detectLanguage(message.body_text), texto_pt: '[tradução simulada] ' + String(message.body_text).slice(0, TRANSLATE_MAX_CHARS) }));
      } else {
        const check = await (services.modelCheck || require('./panel-openai-model-check').ensureModelChecked)(ctx, suggest.model(env));
        if (!check.ok) return { status: 503, error: 'AI_UNAVAILABLE', detail: check.error || 'MODEL_NOT_CHECKED' };
        const guard = openAiBudget.guard(ctx, 'TRADUCAO_CONVERSA', 'traducao:' + journeyId, services.budgetServices);
        let result;
        try { result = await (services.openAi || openAiJson)({ instructions: TRANSLATE_INSTRUCTIONS, input: { mensagens: missing.map((message) => ({ id: message.id, texto: String(message.body_text).slice(0, TRANSLATE_MAX_CHARS) })) }, schema: TRANSLATE_SCHEMA, name: 'traducao_conversa' }, { env, guard, fetchImpl: services.fetchImpl }); }
        catch (failure) { return aiFailure(failure); }
        await recordCost(ctx, guard, 'conversation_translation_openai', journeyId, 'TRANSLATE', result, { messages: missing.length }, services);
        costUsd = result.costUsd; usedModel = result.model;
        if (!result.parsed || !Array.isArray(result.parsed.traducoes)) return { status: 502, error: 'AI_RESPONSE_INVALID', costUsd: result.costUsd };
        items = result.parsed.traducoes;
      }
      // A simulated translation is never kept in production: it would hide the real one later.
      const keep = !(simulated && ctx.environment === 'production');
      const seen = new Set();
      const byId = new Map(missing.map((message) => [message.id, message]));
      for (const item of items) {
        const message = byId.get(String(item && item.id));
        const text = String(item && item.texto_pt || '').trim();
        if (!message || !text || item.idioma === 'pt' || seen.has(message.id)) continue;
        seen.add(message.id);
        const partial = String(message.body_text).length > TRANSLATE_MAX_CHARS;
        const textPt = (partial ? text.slice(0, 3950) + ' […] (tradução parcial: só o início da mensagem)' : text).slice(0, 4000);
        saved[message.id] = { textPt, lang: item.idioma };
        if (!keep) continue;
        // Kept by message and content: a message whose text changes can be translated again.
        // A row that cannot be saved (another tab saved it first, or a database error) still returns
        // its translation: the call was already paid.
        await (services.insert || insert)(ctx, 'message_translations', { environment: ctx.environment, message_id: message.id, content_hash: contentHash(message.body_text), source_lang: ['en', 'es'].includes(item.idioma) ? item.idioma : 'outro', text_pt: textPt, model: usedModel, simulated, created_by: ctx.panel.id }, false)
          .catch((error) => { if (!(error && (error.status === 409 || /duplicate|23505/i.test(String(error.code || error.message || ''))))) console.error('[traducao] falha ao salvar', message.id, error && (error.status || error.message)); });
      }
    }
    return { status: 200, journeyId, translations: saved, translated: missing.length, simulated, model: usedModel, costUsd };
  } finally { runningTranslation.delete(journeyId); }
}

module.exports = { GUIDANCE_MAX, GUIDED_INSTRUCTIONS, GUIDED_SCHEMA, TRANSLATE_INSTRUCTIONS, TRANSLATE_SCHEMA, conflictsOf, contentHash, guided, translate, translations };

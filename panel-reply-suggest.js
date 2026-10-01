'use strict';

// Sugestões de resposta e de retomada nas conversas do WhatsApp, e a fila de conversas antigas.
//
// Nunca envia: a sugestão só aparece no painel, editável. Quem envia é a pessoa, no WhatsApp
// (ou, só na janela de 24 h e só pelo "Responder pelo painel" já existente, depois da revisão).
// A IA é a OpenAI já aprovada no projeto (modelo da allowlist, o mesmo da triagem), sempre dentro
// do teto compartilhado de US$ 50 (reserva antes, custo gravado depois). Fora de produção, ou com a
// função desligada, a sugestão é simulada e marcada como tal: nenhuma chamada paga.
//
// Quem pediu para não receber contato (opt-out), número inválido ou ligação incerta: sem
// sugestão de retomada e fora da fila, sempre com o motivo.
const { allRows, insert, isUuid, rows } = require('./panel-server');
const reply = require('./api/panel/reply');
const openAiBudget = require('./panel-openai-budget');
const triage = require('./panel-triage');

const DAY_MS = 86400000;
const QUEUE_MIN_DAYS = 14;
const MAX_CONTEXT_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 600;
const TIMEOUT_MS = 30000;
const PHONE = /^\+[1-9][0-9]{6,14}$/;

// Pedido para não receber contato, em português, inglês ou espanhol.
const OPT_OUT = /\b(unsubscribe|remove me|take me off (your|the) list|do not (text|message|contact|call) me|don'?t (text|message|contact|call) me( again| anymore)?|stop (texting|messaging|contacting|calling) me|no more (messages|texts)|leave me alone|pare de (me )?(mandar|enviar|chamar|escrever)|n[aã]o (me )?(mande|envie|chame|escreva) mais|n[aã]o quero (mais )?(receber|contato|mensage)|me (tire|remova) da lista|para de (me )?(mandar|enviar)|no me (escribas|escriba|env[ií]es|envie|contactes|contacte|llames) m[aá]s|deja de (escribirme|enviarme|mandarme)|ya no (me )?(escribas|env[ií]es|contactes)|no quiero (m[aá]s )?(mensajes|recibir))\b/i;
// A message that is only the word (STOP, PARE, BAJA…) is an opt-out; inside a sentence it is not
// ("I'll stop by tomorrow").
const OPT_OUT_WORD = /^\s*(stop|unsubscribe|pare|parar|sair|cancelar|baja|alto)\s*[.!]*\s*$/i;
// What the briefing asks never to say on autopilot, and the dash it asks not to use.
const BANNED = [
  { re: /\babsolutely\b/i, text: 'Absolutely' },
  { re: /\bI'?d be happy to\b/i, text: 'I’d be happy to' },
  { re: /\bplease be advised\b/i, text: 'Please be advised' },
  { re: /\bdoes that make sense\??/i, text: 'Does that make sense?' },
  { re: /\breally clean\b/i, text: 'really clean (sem evidência)' },
  { re: /\bnext week\b|\bpr[oó]xima semana\b|\bla pr[oó]xima semana\b/i, text: 'promessa de prazo (próxima semana)' },
  { re: /\bstill interested\??|\bainda tem interesse\??|\bsigue interesad[oa]\??/i, text: 'pergunta padrão de interesse' }
];

const LANGS = { pt: 'Português', en: 'Inglês', es: 'Espanhol' };
// Language of a text by its common words (only a hint for the screen and the simulation; the AI
// decides with the whole conversation).
function detectLanguage(text) {
  const words = String(text || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-zñ¿¡]+/g) || [];
  const score = (list) => words.filter((word) => list.includes(word)).length;
  const pt = score(['voce', 'obrigado', 'obrigada', 'quero', 'nao', 'sim', 'carro', 'tenho', 'estou', 'preciso', 'valor', 'gostaria', 'oi', 'ola', 'bom', 'dia', 'tudo', 'pra', 'para', 'com', 'uma', 'meu']);
  const en = score(['the', 'i', 'you', 'want', 'looking', 'thanks', 'thank', 'car', 'hi', 'hello', 'is', 'are', 'my', 'need', 'budget', 'for', 'and', 'what', 'how', 'can', 'please', 'yes', 'no']);
  const es = score(['hola', 'quiero', 'gracias', 'busco', 'necesito', 'precio', 'usted', 'tengo', 'estoy', 'coche', 'carro', 'para', 'con', 'una', 'que', 'como', 'si', 'buenos', 'dias', 'por', 'favor', 'mi']);
  const best = Math.max(pt, en, es);
  if (!best) return null;
  if (best === en && en > pt && en > es) return 'en';
  if (best === es && es > pt) return 'es';
  return 'pt';
}
const messageAt = (message) => message && (message.occurred_at_utc || message.created_at) || null;
const stamp = (message) => Date.parse(messageAt(message) || '') || 0;
const realOf = (messages) => messages.filter((message) => !message.undone_at && !message.is_automatic && ['CUSTOMER', 'MCS'].includes(message.direction) && String(message.body_text || '').trim())
  .sort((a, b) => stamp(a) - stamp(b));
function optOutOf(messages) {
  const said = (text) => OPT_OUT.test(text) || OPT_OUT_WORD.test(text);
  const found = messages.filter((message) => message.direction === 'CUSTOMER' && !message.undone_at && said(String(message.body_text || ''))).sort((a, b) => stamp(b) - stamp(a))[0];
  return found ? { at: messageAt(found), text: String(found.body_text || '').slice(0, 200) } : null;
}
// Clean a suggestion: never a dash, never the phrases the briefing forbids (said, not hidden).
function review(text) {
  const clean = String(text || '').replace(/\s*[—–]\s*/g, ', ').replace(/[ \t]+\n/g, '\n').trim();
  const warnings = BANNED.filter((item) => item.re.test(clean)).map((item) => 'Contém "' + item.text + '": revise antes de usar');
  const questions = (clean.match(/\?/g) || []).length;
  return { text: clean, warnings, questions };
}
const waLink = (phone, text) => PHONE.test(String(phone || '')) ? 'https://wa.me/' + phone.replace(/^\+/, '') + (text ? '?text=' + encodeURIComponent(text) : '') : null;

// The path allowed for a message now, said in words. The panel never sends a suggestion; the V1
// is the only send by the panel (after an explicit confirmation, inside the window).
function pathFor(window) {
  if (window && window.allowed) {
    return { open: true, until: window.openUntil, api: 'ALLOWED', text: 'Pela API, mensagem livre só sai dentro da janela; a sugestão não é enviada pelo painel.',
      manual: 'Abrir no WhatsApp com o texto preenchido: você revisa e envia no aplicativo.' };
  }
  return { open: false, until: window && window.openUntil || null, api: 'BLOCKED',
    text: 'Janela de 24 h encerrada. Pela API, fora da janela, só sai modelo aprovado pela Meta, e o projeto não tem nenhum modelo aprovado cadastrado: envio pela API bloqueado.',
    manual: 'Caminho manual: abrir a conversa no WhatsApp Business do celular (coexistência com a API) e você mesmo escreve e envia. O painel não envia nada.' };
}

// ------------------------------------------------------------------ IA
function enabled(env = process.env) {
  return env.VERCEL_ENV === 'production' && env.REPLY_SUGGESTION_ENABLED === '1' && Boolean(env.OPENAI_API_KEY) && Boolean(model(env));
}
// Only a model of the project's allowlist; the triage model by default (already approved).
function model(env = process.env) {
  const configured = String(env.REPLY_SUGGESTION_MODEL || env.ENTRADA_OPENAI_MODEL || '').trim();
  return triage.APPROVED_MODELS.includes(configured) ? configured : null;
}

const INSTRUCTIONS = [
  'Você sugere a próxima mensagem de WhatsApp da My Car Scout (MCS), que compra carros em leilão nos EUA para clientes. Você NÃO envia nada: um humano revisa, edita e decide.',
  'POSICIONAMENTO: a MCS conduz a compra com conhecimento de mercado. Não é vendedora insistente, nem suporte genérico, nem buscadora que pede ao cliente para decidir tudo. Tom direto, seguro, natural e cotidiano. Em inglês, escreva como alguém que trabalha no mercado americano. Responda ao ponto que o cliente trouxe e conduza ao próximo passo, sem se defender e sem palestra.',
  'EVITE: linguagem corporativa, explicações longas, urgência falsa, bajulação, repetição, travessões, perguntas automáticas. Nunca use "Absolutely", "I\'d be happy to", "Please be advised" ou "Does that make sense?". Não pergunte "ainda tem interesse?" como padrão.',
  'CONTEXTO: leia todo o histórico. Não repita perguntas já respondidas nem reinicie o atendimento depois da saudação automática (mensagens marcadas automatica=true já foram enviadas pela automação). Use somente fatos do histórico e da ficha recebidos. Não invente condição, disponibilidade, preço, histórico, proteção ou característica de carro. Não use "really clean" sem evidência.',
  'Carro que já passou no leilão: diga que não está mais disponível e use só como referência, sem prometer outro igual. Clean Title não é carro perfeito, sem acidente nem garantia mecânica. Green Light indica que podem existir regras de proteção ou arbitragem, não risco zero; só cite proteção confirmada naquela unidade. MMR é referência, maximum bid é o limite autorizado, winning bid é o lance vencedor; nunca sugira passar do limite autorizado.',
  'VENDA: cliente da calculadora já informou nome, carro e maximum bid: primeiro posicione o orçamento no mercado, não comece pedindo ano, milhagem, cor e trim se não for necessário. Compra distante: ajude com referência de mercado sem dizer que uma busca real começou. Cliente pronto: avance com o inventário disponível naquele momento, se houver dado. Abaixo de US$ 10 mil: muito breve e factual, sem prometer condição. Toda pergunta tem finalidade clara para o próximo passo. Não prometa encontrar algo na próxima semana.',
  'RETOMADA (modo RETOMADA): 1) mostre acompanhamento real da busca ou do mercado só se estiver registrado; 2) dê referência concreta só com evidência; 3) se o carro de exemplo já passou, diga que não está disponível; 4) no máximo UMA pergunta útil; 5) convide a continuar sem pressão. Sem saudação genérica e sem repetir o que a automação já explicou.',
  'IDIOMA: responda no idioma do cliente (pt, en ou es). traducao_recebida_pt: tradução para português da última mensagem do cliente (vazio se já for português). traducao_resposta_pt: tradução para português da sua resposta (vazio se já for português).',
  'fatos_usados: cada fato que a resposta usa, com situacao CONFIRMADO (o cliente disse ou a ficha confirma), INFERIDO (dedução sua) ou DESCONHECIDO (falta saber). pergunta_finalidade: para que serve a pergunta da resposta (vazio se não houver). alertas: riscos que o humano deve conferir antes de enviar.',
  'Responda SOMENTE o JSON do esquema.'
].join('\n');
const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['idioma_cliente', 'traducao_recebida_pt', 'resposta', 'traducao_resposta_pt', 'fatos_usados', 'pergunta_finalidade', 'alertas'],
  properties: {
    idioma_cliente: { type: 'string', enum: ['pt', 'en', 'es'] },
    traducao_recebida_pt: { type: 'string' },
    resposta: { type: 'string' },
    traducao_resposta_pt: { type: 'string' },
    fatos_usados: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fato', 'situacao'], properties: { fato: { type: 'string' }, situacao: { type: 'string', enum: ['CONFIRMADO', 'INFERIDO', 'DESCONHECIDO'] } } } },
    pergunta_finalidade: { type: 'string' },
    alertas: { type: 'array', items: { type: 'string' } }
  }
};

async function openAiSuggest(input, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const modelId = model(env);
  const body = {
    model: modelId,
    messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: JSON.stringify(input) }],
    response_format: { type: 'json_schema', json_schema: { name: 'sugestao_resposta', strict: true, schema: SCHEMA } }
  };
  return openAiBudget.paidCall(options.guard, { modelId, body, send: async (capped) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
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

// Without the AI (Preview, tests, function off): a plain draft built only from what is recorded,
// marked as simulated. It never pretends to know the market.
function simulatedSuggestion({ mode, language, name, fields, lastCustomer }) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  const car = (fields.find((item) => item.key === 'carro' && item.value) || {}).value || null;
  const lang = language || 'en';
  const texts = {
    en: mode === 'RETOMADA'
      ? `Hi${first ? ' ' + first : ''}, picking this back up${car ? ' on the ' + car : ''}. Is the budget you mentioned still where you want to be?`
      : `Hi${first ? ' ' + first : ''}, got it${car ? ' on the ' + car : ''}. I'll check what the current auctions have within that and come back to you with what I find.`,
    es: mode === 'RETOMADA'
      ? `Hola${first ? ' ' + first : ''}, retomo lo${car ? ' del ' + car : ''} que hablamos. ¿El presupuesto que mencionaste sigue igual?`
      : `Hola${first ? ' ' + first : ''}, entendido${car ? ' sobre el ' + car : ''}. Reviso lo que hay ahora en las subastas dentro de eso y te cuento lo que encuentre.`,
    pt: mode === 'RETOMADA'
      ? `Oi${first ? ' ' + first : ''}, retomando${car ? ' o ' + car : ''} que conversamos. O orçamento que você comentou continua o mesmo?`
      : `Oi${first ? ' ' + first : ''}, entendi${car ? ' sobre o ' + car : ''}. Vou olhar o que os leilões têm agora dentro disso e te conto o que encontrar.`
  };
  const pt = texts.pt;
  return {
    idioma_cliente: lang,
    traducao_recebida_pt: lang === 'pt' ? '' : '(tradução simulada) ' + String(lastCustomer && lastCustomer.body_text || '').slice(0, 200),
    resposta: texts[lang] || texts.en,
    traducao_resposta_pt: lang === 'pt' ? '' : pt,
    fatos_usados: car ? [{ fato: 'Carro: ' + car, situacao: 'CONFIRMADO' }] : [{ fato: 'Carro', situacao: 'DESCONHECIDO' }],
    pergunta_finalidade: mode === 'RETOMADA' ? 'Confirmar se o orçamento mudou antes de buscar' : '',
    alertas: ['Sugestão simulada neste ambiente: sem IA e sem custo']
  };
}

// ------------------------------------------------------------------ leitura do caso
async function loadCase(ctx, journeyId, services) {
  const read = services.rows || rows;
  const env = 'eq.' + ctx.environment;
  const [journey] = await read(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,stage,closed_reason', environment: env, id: 'eq.' + journeyId, limit: '1' });
  if (!journey) return null;
  const [contactRows, links, toggles] = await Promise.all([
    read(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: env, id: 'eq.' + journey.contact_id, limit: '1' }),
    read(ctx, 'message_journeys', { select: 'message_id', environment: env, journey_id: 'eq.' + journey.id, undone_at: 'is.null', limit: '5000' }),
    read(ctx, 'journey_toggle_states', { select: 'enabled,off_reason', environment: env, journey_id: 'eq.' + journey.id, limit: '1' })
  ]);
  const ids = links.map((row) => row.message_id).filter(isUuid);
  const messages = [];
  for (let index = 0; index < ids.length; index += 100) {
    messages.push(...await read(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,occurred_at_utc,created_at,undone_at,chat_id', environment: env, id: 'in.(' + ids.slice(index, index + 100).join(',') + ')' }));
  }
  return { journey, contact: contactRows[0] || null, toggle: toggles[0] || null, messages };
}

// Why a case may not get a follow-up suggestion (opt-out, closed, not a lead, off).
function blockOf(item) {
  if (item.optOut) return { code: 'OPT_OUT', text: 'O cliente pediu para não receber contato: "' + item.optOut.text + '"' };
  if (item.contact && item.contact.is_lead === false) return { code: 'NOT_LEAD', text: 'Marcado como "não é lead"' };
  if (item.journey && item.journey.status === 'ENCERRADO') return { code: 'CLOSED', text: 'Caso encerrado' + (item.journey.closed_reason ? ' (' + item.journey.closed_reason + ')' : '') };
  if (item.toggle && item.toggle.enabled === false) return { code: 'OFF', text: 'Caso desligado' + (item.toggle.off_reason ? ' (' + item.toggle.off_reason + ')' : '') };
  return null;
}

// A Ref (ficha code or linked Ref) that is in more than one ficha: whose case it is is unknown, so the
// panel neither queues nor suggests on it until the identity is resolved (same rule as the client context).
const REF_CODE = /^[A-HJ-NP-Z2-9]{5}$/;
const refKey = (value) => String(value || '').trim().toUpperCase();
function sharedRefsFrom(journeyId, refs, owners) {
  return refs.filter((ref) => (owners.get(ref) || new Set([journeyId])).size > 1);
}
function ownersMap(journeys, journeyRefs) {
  const owners = new Map();
  const add = (ref, journeyId) => { const key = refKey(ref); if (!REF_CODE.test(key) || !journeyId) return; if (!owners.has(key)) owners.set(key, new Set()); owners.get(key).add(journeyId); };
  journeys.forEach((row) => add(row.reference_code, row.id));
  journeyRefs.forEach((row) => add(row.ref_code, row.journey_id));
  return owners;
}
async function sharedRefsOf(ctx, journey, read) {
  const env = 'eq.' + ctx.environment;
  const ownLinks = await read(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env, journey_id: 'eq.' + journey.id });
  const refs = [...new Set([journey.reference_code, ...ownLinks.map((row) => row.ref_code)].map(refKey).filter((ref) => REF_CODE.test(ref)))];
  if (!refs.length) return [];
  const list = 'in.(' + refs.join(',') + ')';
  const [codes, links] = await Promise.all([
    read(ctx, 'journeys', { select: 'id,reference_code', environment: env, reference_code: list }),
    read(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env, ref_code: list })
  ]);
  return sharedRefsFrom(journey.id, refs, ownersMap(codes, links));
}
function ambiguityBlock(shared) {
  return { code: 'REF_AMBIGUOUS', refs: shared, text: `Ref ${shared.join(', ')} ligada a mais de uma ficha: confirme de quem é antes de usar este contexto` };
}

// ------------------------------------------------------------------ sugestão
const running = new Set();
async function suggest(ctx, body, services = {}) {
  const journeyId = String(body.journeyId || '');
  if (!isUuid(journeyId)) return { status: 400, error: 'JOURNEY_INVALID' };
  if (running.has(journeyId)) return { status: 409, error: 'SUGGESTION_IN_PROGRESS' };
  running.add(journeyId);
  try {
    const found = await loadCase(ctx, journeyId, services);
    if (!found) return { status: 404, error: 'LEAD_NOT_FOUND' };
    const real = realOf(found.messages);
    if (!real.length) return { status: 409, error: 'NO_CONVERSATION' };
    const optOut = optOutOf(found.messages);
    const blocked = blockOf({ ...found, optOut });
    const lastCustomer = real.filter((message) => message.direction === 'CUSTOMER').at(-1) || null;
    const last = real.at(-1);
    const mode = body.mode === 'RETOMADA' || body.mode === 'RESPOSTA' ? body.mode : last.direction === 'CUSTOMER' ? 'RESPOSTA' : 'RETOMADA';
    // An opt-out blocks every suggestion; a closed, off or "not a lead" case only blocks a follow-up.
    if (blocked && (blocked.code === 'OPT_OUT' || mode === 'RETOMADA')) return { status: 409, error: 'SUGGESTION_BLOCKED', reason: blocked };
    const shared = await sharedRefsOf(ctx, found.journey, services.rows || rows);
    if (shared.length) return { status: 409, error: 'SUGGESTION_BLOCKED', reason: ambiguityBlock(shared) };
    const target = await (services.resolveTarget || reply.resolveTarget)(ctx, journeyId, { rows: services.rows || rows });
    const window = target ? await (services.windowState || reply.windowState)(ctx, target.chat.id, { rows: services.rows || rows }) : { allowed: false };
    const context = await (services.clientContext || defaultContext)(ctx, journeyId);
    const fields = (context && context.fields || []).map((item) => ({ key: item.key, label: item.label, value: item.value, status: item.status, statusLabel: item.statusLabel }));
    const language = detectLanguage(real.filter((message) => message.direction === 'CUSTOMER').slice(-5).map((message) => message.body_text).join(' '));
    const conversation = found.messages.filter((message) => !message.undone_at && String(message.body_text || '').trim() && ['CUSTOMER', 'MCS'].includes(message.direction))
      .sort((a, b) => stamp(a) - stamp(b)).slice(-MAX_CONTEXT_MESSAGES)
      .map((message) => ({ de: message.direction === 'CUSTOMER' ? 'cliente' : 'MCS', automatica: message.is_automatic === true, quando: messageAt(message), texto: String(message.body_text).slice(0, MAX_MESSAGE_CHARS) }));
    const input = {
      modo: mode, hoje: new Date().toISOString().slice(0, 10), dias_sem_atividade: Math.floor((Date.now() - stamp(last)) / DAY_MS),
      cliente: { nome: found.contact && found.contact.display_name || null, origem: context && context.origin ? context.origin.label : null },
      ficha: fields.filter((item) => item.value).map((item) => ({ campo: item.label, valor: item.value, situacao: item.statusLabel })),
      faltando: fields.filter((item) => !item.value && item.key !== 'uso').map((item) => item.label),
      etapa: context && context.stage ? context.stage.label : null,
      conversa: conversation
    };
    const env = services.env || process.env;
    let raw, simulated = false, costUsd = 0, usedModel = null;
    if (!enabled(env)) { raw = simulatedSuggestion({ mode, language, name: found.contact && found.contact.display_name, fields, lastCustomer }); simulated = true; }
    else {
      const check = await (services.modelCheck || require('./panel-openai-model-check').ensureModelChecked)(ctx, model(env));
      if (!check.ok) return { status: 503, error: 'AI_UNAVAILABLE', detail: check.error || 'MODEL_NOT_CHECKED' };
      const guard = openAiBudget.guard(ctx, 'RESPOSTA', 'sugestao:' + journeyId, services.budgetServices);
      let result;
      try { result = await (services.openAi || openAiSuggest)(input, { env, guard, fetchImpl: services.fetchImpl }); }
      catch (failure) {
        const code = failure && failure.code || 'OPENAI_FAILED';
        return { status: code === 'OPENAI_BUDGET_LIMIT' ? 402 : 503, error: code === 'OPENAI_BUDGET_LIMIT' ? 'OPENAI_BUDGET_LIMIT' : 'AI_UNAVAILABLE', detail: code };
      }
      // The cost goes to the audit log (counted in the US$ 50 ceiling); then the hold stops counting.
      const saved = await (services.insert || insert)(ctx, 'audit_log', { environment: ctx.environment, actor_user_id: ctx.panel.id, entity_type: 'reply_suggestion_openai', entity_id: journeyId, action: 'SUGGEST',
        after_json: { provider: 'openai', model: result.model, mode, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, costUsd: result.costUsd } }, false).then(() => true, () => false);
      if (saved) await openAiBudget.recorded(guard);
      raw = result.parsed; costUsd = result.costUsd; usedModel = result.model;
      if (!raw || typeof raw.resposta !== 'string' || !raw.resposta.trim()) return { status: 502, error: 'AI_RESPONSE_INVALID' };
    }
    const reviewed = review(raw.resposta);
    const lang = LANGS[raw.idioma_cliente] ? raw.idioma_cliente : language || 'pt';
    const warnings = [...(raw.alertas || []).map(String).slice(0, 5), ...reviewed.warnings];
    if (mode === 'RETOMADA' && reviewed.questions > 1) warnings.push('Mais de uma pergunta: a retomada pede no máximo uma');
    const facts = (raw.fatos_usados || []).filter((item) => item && item.fato).slice(0, 10).map((item) => ({ text: String(item.fato).slice(0, 200), status: ['CONFIRMADO', 'INFERIDO', 'DESCONHECIDO'].includes(item.situacao) ? item.situacao : 'INFERIDO' }));
    return {
      status: 200, journeyId, mode, simulated, model: usedModel, costUsd,
      language: { code: lang, label: LANGS[lang] },
      received: lastCustomer ? { text: String(lastCustomer.body_text || '').slice(0, 2000), at: messageAt(lastCustomer), translationPt: lang === 'pt' ? null : String(raw.traducao_recebida_pt || '').trim() || null } : null,
      last: { from: last.direction, at: messageAt(last) },
      suggestion: { text: reviewed.text, translationPt: lang === 'pt' ? null : String(raw.traducao_resposta_pt || '').replace(/\s*[—–]\s*/g, ', ').trim() || null, questionPurpose: String(raw.pergunta_finalidade || '').trim() || null },
      facts, warnings, notice: blocked ? blocked.text : null,
      contact: target ? { name: target.name, phone: target.phone } : null,
      reachable: Boolean(target),
      path: pathFor(window),
      whatsappBase: target ? waLink(target.phone, '') : null
    };
  } finally { running.delete(journeyId); }
}

async function defaultContext(ctx, journeyId) {
  try {
    const { buildContexts } = require('./panel-client-context');
    const out = await buildContexts(ctx, { journeyIds: [journeyId] });
    return out.journeys[journeyId] || null;
  } catch (_) { return null; }
}

// ------------------------------------------------------------------ fila de conversas antigas
// Oldest first. Eligible: one ficha, one individual WhatsApp chat with a valid phone owned by this
// contact only, a real conversation, inactive for QUEUE_MIN_DAYS or more, no opt-out, not closed,
// not off, not "not a lead". The rest is listed apart with the reason.
async function queue(ctx, options = {}, services = {}) {
  const read = services.allRows || allRows;
  const env = 'eq.' + ctx.environment;
  const now = options.now || Date.now();
  const minDays = Math.max(1, Math.min(365, Number(options.minDays) || QUEUE_MIN_DAYS));
  const [journeys, contacts, chats, phones, links, messages, toggles, journeyRefs] = await Promise.all([
    read(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,stage,closed_reason', environment: env }),
    read(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: env }),
    read(ctx, 'chats', { select: 'id,contact_id,channel,is_group,canonical_key', environment: env, channel: 'eq.WHATSAPP' }),
    read(ctx, 'contact_phones', { select: 'contact_id,phone_e164,is_current,retired_at', environment: env }),
    read(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null' }),
    read(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,occurred_at_utc,created_at,undone_at', environment: env, undone_at: 'is.null' }),
    read(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason', environment: env }),
    read(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env })
  ]);
  const refOwners = ownersMap(journeys, journeyRefs);
  const refsByJourney = new Map();
  journeyRefs.forEach((row) => { if (!refsByJourney.has(row.journey_id)) refsByJourney.set(row.journey_id, []); refsByJourney.get(row.journey_id).push(refKey(row.ref_code)); });
  const contactById = new Map(contacts.map((row) => [row.id, row]));
  const messageById = new Map(messages.map((row) => [row.id, row]));
  const toggleByJourney = new Map(toggles.map((row) => [row.journey_id, row]));
  const journeysByContact = new Map();
  journeys.forEach((row) => { journeysByContact.set(row.contact_id, (journeysByContact.get(row.contact_id) || 0) + 1); });
  const chatsByContact = new Map();
  chats.forEach((row) => { if (!chatsByContact.has(row.contact_id)) chatsByContact.set(row.contact_id, []); chatsByContact.get(row.contact_id).push(row); });
  const holders = new Map();
  phones.filter((row) => row.is_current !== false && !row.retired_at && row.phone_e164).forEach((row) => { if (!holders.has(row.phone_e164)) holders.set(row.phone_e164, new Set()); holders.get(row.phone_e164).add(row.contact_id); });
  const messagesByJourney = new Map();
  links.forEach((row) => { const message = messageById.get(row.message_id); if (!message) return; if (!messagesByJourney.has(row.journey_id)) messagesByJourney.set(row.journey_id, []); messagesByJourney.get(row.journey_id).push(message); });
  const eligible = [], excluded = [];
  journeys.forEach((journey) => {
    const own = messagesByJourney.get(journey.id) || [];
    const real = realOf(own);
    if (!real.length || !real.some((message) => message.direction === 'CUSTOMER')) return;
    const last = real.at(-1);
    const days = Math.floor((now - stamp(last)) / DAY_MS);
    if (days < minDays) return;
    const contact = contactById.get(journey.contact_id) || null;
    const base = { journeyId: journey.id, name: contact && contact.display_name || 'Contato sem nome', ref: journey.reference_code || null, lastAt: messageAt(last), lastFrom: last.direction, days,
      lastMessage: String(last.body_text || '').slice(0, 280), stage: journey.stage || null };
    const block = blockOf({ journey, contact, toggle: toggleByJourney.get(journey.id), optOut: optOutOf(own) });
    if (block) { excluded.push({ ...base, reason: block }); return; }
    const ownRefs = [...new Set([refKey(journey.reference_code), ...(refsByJourney.get(journey.id) || [])].filter((ref) => REF_CODE.test(ref)))];
    const shared = sharedRefsFrom(journey.id, ownRefs, refOwners);
    if (shared.length) { excluded.push({ ...base, reason: ambiguityBlock(shared) }); return; }
    const contactChats = (chatsByContact.get(journey.contact_id) || []);
    const individual = contactChats.filter((chat) => chat.is_group === false);
    if (!individual.length) { excluded.push({ ...base, reason: { code: 'NO_WHATSAPP', text: 'Sem conversa individual de WhatsApp ligada ao contato' } }); return; }
    if (individual.length > 1) { excluded.push({ ...base, reason: { code: 'MANY_CHATS', text: 'Mais de uma conversa de WhatsApp no contato: destino incerto' } }); return; }
    const phone = String(individual[0].canonical_key || '').replace(/^wa:/, '');
    if (!String(individual[0].canonical_key || '').startsWith('wa:') || !PHONE.test(phone)) { excluded.push({ ...base, reason: { code: 'INVALID_NUMBER', text: 'Número de WhatsApp inválido ou ausente' } }); return; }
    const owners = holders.get(phone) || new Set();
    if (owners.size !== 1 || !owners.has(journey.contact_id)) { excluded.push({ ...base, reason: { code: 'PHONE_UNCERTAIN', text: owners.size > 1 ? 'Número ligado a mais de um contato' : 'Número não confirmado como telefone atual do contato' } }); return; }
    if ((journeysByContact.get(journey.contact_id) || 0) > 1) { excluded.push({ ...base, reason: { code: 'MANY_FICHAS', text: 'O contato tem mais de uma ficha: qual caso retomar é incerto' } }); return; }
    const customerAt = stamp(real.filter((message) => message.direction === 'CUSTOMER').at(-1));
    eligible.push({ ...base, phone, windowOpen: now < customerAt + DAY_MS });
  });
  eligible.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt));
  excluded.sort((a, b) => Date.parse(a.lastAt) - Date.parse(b.lastAt));
  const reasons = {};
  excluded.forEach((item) => { reasons[item.reason.code] = (reasons[item.reason.code] || 0) + 1; });
  return { minDays, eligible, excluded, reasons, generatedAt: new Date(now).toISOString() };
}

module.exports = { BANNED, LANGS, OPT_OUT, OPT_OUT_WORD, QUEUE_MIN_DAYS, SCHEMA, INSTRUCTIONS, blockOf, detectLanguage, enabled, model, openAiSuggest, optOutOf, pathFor, queue, review, simulatedSuggestion, suggest, waLink };

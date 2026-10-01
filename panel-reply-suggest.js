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
const { undash } = require('./text-dash');
const { OPT_OUT, OPT_OUT_WORD, optOutOf } = require('./panel-opt-out');
const { dispositionIndex } = require('./panel-disposition');
const { outOfFunnelIndex } = require('./panel-triage');
const reply = require('./api/panel/reply');
const openAiBudget = require('./panel-openai-budget');
const triage = require('./panel-triage');

const DAY_MS = 86400000;
const QUEUE_MIN_DAYS = 14;
const MAX_CONTEXT_MESSAGES = 30;
const MAX_MESSAGE_CHARS = 600;
const TIMEOUT_MS = 30000;
const PHONE = /^\+[1-9][0-9]{6,14}$/;

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
// Clean a suggestion: never a dash, never the phrases the briefing forbids (said, not hidden).
function review(text) {
  // A dash between numbers is a range (2018–2020, 20,000–80,000): it stays a range, never a comma.
  const clean = undash(text).replace(/[ \t]+\n/g, '\n').trim();
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
  'VENDA: cliente POR VALOR (Calculate My Cost) já informou carro e lance: posicione o lance no mercado, sem pedir ano, milhagem, cor ou trim. Cliente POR CARRO (Find One) já informou carro, anos e milhas: nunca fale de orçamento nem de lance; posicione o pedido no mercado. Carro até US$ 7.000: só à vista (cash), não ofereça financiamento. Compra distante: ajude com referência de mercado sem dizer que uma busca real começou. Cliente pronto: avance com o inventário disponível naquele momento, se houver dado. Abaixo de US$ 10 mil: muito breve e factual, sem prometer condição. Toda pergunta tem finalidade clara para o próximo passo. Não prometa encontrar algo na próxima semana.',
  'RETOMADA (modo RETOMADA): 1) mostre acompanhamento real da busca ou do mercado só se estiver registrado; 2) dê referência concreta só com evidência; 3) se o carro de exemplo já passou, diga que não está disponível; 4) no máximo UMA pergunta útil; 5) convide a continuar sem pressão. Sem saudação genérica e sem repetir o que a automação já explicou.',
  'MESA (regra do tipo de busca, vale acima de qualquer outra): a MCS conduz; o cliente nunca escolhe ao mesmo tempo ano, milhagem e valor, porque isso obriga a procurar um carro que talvez não exista. POR CARRO (Find One): o cliente define carro, faixa de ano e faixa de milhagem; NUNCA pergunte lance, orçamento, valor máximo, preço ou quanto quer gastar. POR VALOR (Calculate My Cost): o cliente define carro e lance máximo; NUNCA pergunte ano nem milhagem, quem enquadra ano e milhagem no valor é a MCS. Com o tipo já definido e os dados dele completos, não peça mais critério nenhum: confirme em uma frase o que ele pediu, responda o que ele perguntou e diga o próximo passo concreto da MCS.',
  'BUSCA INCOMPLETA (busca.completa=false): a conversa deve fluir para obter o que falta para a MCS montar e classificar a busca. Existem só dois tipos: POR CARRO (carro + faixa de ano + faixa de milhagem; valor não é usado) e POR VALOR (carro + lance máximo; ano e milhagem não são usados). Se busca.tipo = NAO_DEFINIDO, a pergunta leva o cliente naturalmente a um dos dois caminhos, a partir do que ele já disse (ex.: se ele tem um teto de lance ou se procura um ano e uma milhagem específicos). Peça só o que está em busca.faltando_por_carro ou busca.faltando_por_valor, começando pelo carro se faltar, no máximo UMA pergunta (que pode juntar dois dados ligados, como ano e milhagem). Nunca pergunte o que já está na ficha ou no histórico; o que está em busca.a_confirmar (lido só pela IA) se confirma, não se pergunta do zero. Se o cliente fez uma pergunta, responda primeiro e depois faça a pergunta da busca. No modo RETOMADA, a pergunta útil é a que destrava a busca. pergunta_finalidade diz qual dado da busca a pergunta obtém. Com busca.completa=true, siga as regras de VENDA e não peça dados de busca.',
  'Os campos fatos_usados, pergunta_finalidade e alertas são para a equipe: escreva-os sempre em português, qualquer que seja o idioma do cliente.',
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

// MESA: a question that crosses the search type. POR CARRO never asks for a value; POR VALOR never
// asks for year or mileage. Only questions count ("we never bid above your max" is a statement).
const ASKS_VALUE = /\b(bid|budget|price|spend|pay|afford|how much)\b|\bmax(imum)?\b(?!\s*(mileage|miles|year))|\b(presupuesto|precio|cu[aá]nto|gastar|or[cç]amento|lance|pre[cç]o|quanto|valor)\b/i;
const ASKS_YEAR_MILES = /\b(years?|mileage|miles|odometer)\b|\ba[nñ]os?\b|millas|kilometraje|milhagem|quilometragem/i;
function typeViolation(text, gap) {
  if (!gap || !gap.tipo) return null;
  const questions = String(text || '').split(/(?<=[?¿])|(?<=[.!])\s+/).filter((part) => /\?/.test(part));
  const types = String(gap.tipo).split(',');
  if (types.includes('POR_CARRO') && !types.includes('POR_VALOR') && questions.some((q) => ASKS_VALUE.test(q))) return 'A busca é POR CARRO (Find One): a pergunta pede valor ou lance, o que a regra da mesa proíbe';
  if (types.includes('POR_VALOR') && !types.includes('POR_CARRO') && questions.some((q) => ASKS_YEAR_MILES.test(q))) return 'A busca é POR VALOR: a pergunta pede ano ou milhagem, o que a regra da mesa proíbe';
  return null;
}

// What the search still needs, per type (the same rule as the client context and vehicle-match):
// POR CARRO needs carro, anos and milhas; POR VALOR needs carro and valor. A field read only by the AI
// counts as present, to be confirmed.
const SEARCH_NEEDS = Object.freeze({ CARRO: ['carro', 'anos', 'milhas'], VALOR: ['carro', 'valor'] });
const NEED_LABELS = Object.freeze({ carro: 'carro (marca e modelo)', anos: 'faixa de ano', milhas: 'faixa de milhagem', valor: 'lance máximo' });
// Fields the search type forbids asking: POR CARRO never value; POR VALOR never year or mileage.
function forbiddenFor(gap) {
  const types = String(gap && gap.tipo || '').split(',');
  if (types.includes('POR_CARRO') && !types.includes('POR_VALOR')) return ['valor', 'teto'];
  if (types.includes('POR_VALOR') && !types.includes('POR_CARRO')) return ['anos', 'milhas'];
  return [];
}
function searchGap(fields, context) {
  const byKey = new Map((fields || []).map((item) => [item.key, item]));
  // A field the sources disagree on (AMBIGUO) was answered: it is confirmed, never asked from scratch.
  const present = (key) => { const item = byKey.get(key); return Boolean(item && (item.status === 'AMBIGUO' || (item.value && item.status !== 'AUSENTE'))); };
  const modes = [...new Set([...((context && context.modes) || []), ...((context && context.searches) || []).map((item) => item.mode), ...(((context && context.links && context.links.orders) || []).map((item) => item.mode))].filter((mode) => SEARCH_NEEDS[mode]))];
  const missing = (mode) => SEARCH_NEEDS[mode].filter((key) => !present(key)).map((key) => NEED_LABELS[key]);
  const complete = modes.length ? modes.some((mode) => !missing(mode).length) : false;
  return {
    completa: complete,
    tipo: modes.length ? modes.map((mode) => mode === 'CARRO' ? 'POR_CARRO' : 'POR_VALOR').join(',') : 'NAO_DEFINIDO',
    faltando_por_carro: !modes.length || modes.includes('CARRO') ? missing('CARRO') : [],
    faltando_por_valor: !modes.length || modes.includes('VALOR') ? missing('VALOR') : [],
    a_confirmar: ['carro', 'anos', 'milhas', 'valor'].filter((key) => present(key) && ['IA', 'AMBIGUO'].includes((byKey.get(key) || {}).status)).map((key) => NEED_LABELS[key])
  };
}
// Without the AI (Preview, tests, function off): a plain draft built only from what is recorded,
// marked as simulated. It never pretends to know the market and follows the MESA rule: it asks only
// what the search type is missing (POR CARRO never value, POR VALOR never year or mileage) and asks
// no criteria at all once the search is complete.
const firstNameOf = (name) => { const first = String(name || '').trim().split(/\s+/)[0] || ''; return /[\d+@]/.test(first) ? '' : first; };
const SIM_TEXT = {
  hi: { en: 'Hi', es: 'Hola', pt: 'Oi' },
  car: { en: 'what car are you looking for? Make and model is enough to start.', es: '¿qué carro buscas? Con marca y modelo podemos empezar.', pt: 'qual carro você procura? Marca e modelo já bastam para começar.' },
  path: { en: (c) => `for the ${c}, do you have a max bid in mind, or a specific year and mileage range?`, es: (c) => `para el ${c}, ¿tienes una oferta máxima o buscas un rango de año y millas específico?`, pt: (c) => `para o ${c}, você tem um lance máximo em mente ou procura um ano e uma milhagem específicos?` },
  years: { en: (c) => `for the ${c}, what year range works for you?`, es: (c) => `para el ${c}, ¿qué rango de años te sirve?`, pt: (c) => `para o ${c}, qual faixa de ano serve para você?` },
  miles: { en: (c) => `for the ${c}, what mileage range works for you?`, es: (c) => `para el ${c}, ¿qué rango de millas te sirve?`, pt: (c) => `para o ${c}, qual faixa de milhagem serve para você?` },
  both: { en: (c) => `for the ${c}, what year range and mileage range work for you?`, es: (c) => `para el ${c}, ¿qué rango de años y de millas te sirve?`, pt: (c) => `para o ${c}, qual faixa de ano e de milhagem serve para você?` },
  bid: { en: (c) => `for the ${c}, what is the max you want to bid?`, es: (c) => `para el ${c}, ¿cuál es el máximo que quieres ofertar?`, pt: (c) => `para o ${c}, qual é o lance máximo que você quer usar?` },
  reply: { en: (c) => `got it${c ? ' on the ' + c : ''}. Let me look at the auction market for that and I'll come back to you with what makes sense.`, es: (c) => `entendido${c ? ' sobre el ' + c : ''}. Reviso el mercado de subastas para eso y te cuento lo que tenga sentido.`, pt: (c) => `entendi${c ? ' sobre o ' + c : ''}. Vou olhar o mercado de leilão para isso e te trago o que fizer sentido.` },
  resume: { en: (c) => `picking this back up${c ? ' on the ' + c : ''}. When you're ready for the next step, I'll put together what the auctions have for what you asked.`, es: (c) => `retomo lo${c ? ' del ' + c : ''} que hablamos. Cuando quieras dar el siguiente paso, reúno lo que hay en las subastas para lo que pediste.`, pt: (c) => `retomando${c ? ' o ' + c : ''} que conversamos. Quando quiser dar o próximo passo, eu junto o que os leilões têm para o que você pediu.` }
};
const PURPOSE = { car: 'Obter o carro (marca e modelo) para montar a busca', path: 'Definir o tipo de busca: por valor (lance máximo) ou por carro (ano e milhagem)', years: 'Obter a faixa de ano para a busca por carro', miles: 'Obter a faixa de milhagem para a busca por carro', both: 'Obter a faixa de ano e de milhagem para a busca por carro', bid: 'Obter o lance máximo para a busca por valor' };
// Which single question (if any) the search still needs, by type.
function simulatedAsk(gap, car) {
  if (!gap || gap.completa) return null;
  const types = String(gap.tipo || '').split(',').filter((type) => type && type !== 'NAO_DEFINIDO');
  if (!car) return 'car';
  if (!types.length) return 'path';
  const carro = gap.faltando_por_carro || [], valor = gap.faltando_por_valor || [];
  const carroAsk = carro.includes('faixa de ano') && carro.includes('faixa de milhagem') ? 'both' : carro.includes('faixa de ano') ? 'years' : carro.includes('faixa de milhagem') ? 'miles' : null;
  const valorAsk = valor.includes('lance máximo') ? 'bid' : null;
  if (types.includes('POR_CARRO') && types.includes('POR_VALOR')) return carroAsk && (!valorAsk || carro.length <= valor.length) ? carroAsk : valorAsk || carroAsk;
  return types.includes('POR_CARRO') ? carroAsk : valorAsk;
}
function simulatedSuggestion({ mode, language, name, fields, lastCustomer, gap = null }) {
  const first = firstNameOf(name);
  const car = (fields.find((item) => item.key === 'carro' && item.value) || {}).value || null;
  const lang = SIM_TEXT.hi[language] ? language : 'en';
  const ask = simulatedAsk(gap, car);
  const body = (code) => ask === 'car' ? SIM_TEXT.car[code] : ask ? SIM_TEXT[ask][code](car) : (mode === 'RETOMADA' ? SIM_TEXT.resume : SIM_TEXT.reply)[code](car);
  const text = (code) => `${SIM_TEXT.hi[code]}${first ? ' ' + first : ''}, ${body(code)}`;
  const types = gap ? String(gap.tipo || 'NAO_DEFINIDO') : 'NAO_DEFINIDO';
  return {
    idioma_cliente: lang,
    traducao_recebida_pt: lang === 'pt' ? '' : '(tradução simulada) ' + String(lastCustomer && lastCustomer.body_text || '').slice(0, 200),
    resposta: text(lang),
    traducao_resposta_pt: lang === 'pt' ? '' : text('pt'),
    fatos_usados: [car ? { fato: 'Carro: ' + car, situacao: 'CONFIRMADO' } : { fato: 'Carro', situacao: 'DESCONHECIDO' }, { fato: 'Tipo de busca: ' + (types === 'NAO_DEFINIDO' ? 'não definido' : types.replace(/POR_CARRO/g, 'por carro').replace(/POR_VALOR/g, 'por valor').replace(',', ' e ')), situacao: types === 'NAO_DEFINIDO' ? 'DESCONHECIDO' : 'CONFIRMADO' }],
    pergunta_finalidade: ask ? PURPOSE[ask] : '',
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
    const gap = searchGap(fields, context);
    const language = detectLanguage(real.filter((message) => message.direction === 'CUSTOMER').slice(-5).map((message) => message.body_text).join(' '));
    const conversation = found.messages.filter((message) => !message.undone_at && String(message.body_text || '').trim() && ['CUSTOMER', 'MCS'].includes(message.direction))
      .sort((a, b) => stamp(a) - stamp(b)).slice(-MAX_CONTEXT_MESSAGES)
      .map((message) => ({ de: message.direction === 'CUSTOMER' ? 'cliente' : 'MCS', automatica: message.is_automatic === true, quando: messageAt(message), texto: String(message.body_text).slice(0, MAX_MESSAGE_CHARS) }));
    const input = {
      modo: mode, hoje: new Date().toISOString().slice(0, 10), dias_sem_atividade: Math.floor((Date.now() - stamp(last)) / DAY_MS),
      cliente: { nome: found.contact && found.contact.display_name || null, origem: context && context.origin ? context.origin.label : null },
      ficha: fields.filter((item) => item.value).map((item) => ({ campo: item.label, valor: item.value, situacao: item.statusLabel })),
      // Never offered as missing what the search type forbids asking (MESA).
      faltando: fields.filter((item) => !item.value && item.key !== 'uso' && !forbiddenFor(gap).includes(item.key)).map((item) => item.label),
      busca: gap,
      etapa: context && context.stage ? context.stage.label : null,
      conversa: conversation
    };
    const env = services.env || process.env;
    let raw, simulated = false, costUsd = 0, usedModel = null;
    if (!enabled(env)) { raw = simulatedSuggestion({ mode, language, name: found.contact && found.contact.display_name, fields, lastCustomer, gap }); simulated = true; }
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
      // MESA: a question that crosses the search type gets one corrected attempt (same ceiling).
      const crossed = typeViolation(raw.resposta, gap);
      if (crossed) {
        const retryGuard = openAiBudget.guard(ctx, 'RESPOSTA', 'sugestao:' + journeyId + ':mesa', services.budgetServices);
        const again = await (services.openAi || openAiSuggest)({ ...input, correcao: crossed + '. Reescreva sem essa pergunta, seguindo a regra MESA.' }, { env, guard: retryGuard, fetchImpl: services.fetchImpl }).catch(() => null);
        if (again) {
          await (services.insert || insert)(ctx, 'audit_log', { environment: ctx.environment, actor_user_id: ctx.panel.id, entity_type: 'reply_suggestion_openai', entity_id: journeyId, action: 'SUGGEST',
            after_json: { provider: 'openai', model: again.model, mode, retry: 'MESA', inputTokens: again.usage.inputTokens, outputTokens: again.usage.outputTokens, costUsd: again.costUsd } }, false).then(() => openAiBudget.recorded(retryGuard), () => null);
          costUsd += again.costUsd || 0;
          if (again.parsed && typeof again.parsed.resposta === 'string' && again.parsed.resposta.trim()) raw = again.parsed;
        }
      }
    }
    const reviewed = review(raw.resposta);
    const lang = LANGS[raw.idioma_cliente] ? raw.idioma_cliente : language || 'pt';
    const warnings = [...(raw.alertas || []).map(String).slice(0, 5), ...reviewed.warnings];
    if (mode === 'RETOMADA' && reviewed.questions > 1) warnings.push('Mais de uma pergunta: a retomada pede no máximo uma');
    const stillCrossed = typeViolation(reviewed.text, gap);
    if (stillCrossed) warnings.unshift(stillCrossed + ': não use esta pergunta');
    const facts = (raw.fatos_usados || []).filter((item) => item && item.fato).slice(0, 10).map((item) => ({ text: String(item.fato).slice(0, 200), status: ['CONFIRMADO', 'INFERIDO', 'DESCONHECIDO'].includes(item.situacao) ? item.situacao : 'INFERIDO' }));
    return {
      status: 200, journeyId, mode, simulated, model: usedModel, costUsd,
      language: { code: lang, label: LANGS[lang] },
      received: lastCustomer ? { text: String(lastCustomer.body_text || '').slice(0, 2000), at: messageAt(lastCustomer), translationPt: lang === 'pt' ? null : String(raw.traducao_recebida_pt || '').trim() || null } : null,
      last: { from: last.direction, at: messageAt(last) },
      suggestion: { text: reviewed.text, translationPt: lang === 'pt' ? null : undash(raw.traducao_resposta_pt).trim() || null, questionPurpose: String(raw.pergunta_finalidade || '').trim() || null },
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
  const [journeys, contacts, chats, phones, links, messages, toggles, journeyRefs, dispositions] = await Promise.all([
    read(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,stage,closed_reason', environment: env }),
    read(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: env }),
    read(ctx, 'chats', { select: 'id,contact_id,channel,is_group,canonical_key', environment: env, channel: 'eq.WHATSAPP' }),
    read(ctx, 'contact_phones', { select: 'contact_id,phone_e164,is_current,retired_at', environment: env }),
    read(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null' }),
    read(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,occurred_at_utc,created_at,undone_at', environment: env, undone_at: 'is.null' }),
    read(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason', environment: env }),
    read(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env }),
    read(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at,cleared_at', environment: env, cleared_at: 'is.null' }).catch(() => [])
  ]);
  // Discarded people and conversations out of the commercial funnel are never retaken.
  const personDisposition = dispositionIndex(dispositions);
  const triageOut = await outOfFunnelIndex(ctx, journeys, journeyRefs, read).catch(() => new Set());
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
    const disposition = personDisposition(journey.id, ownRefs);
    if (disposition && disposition.status === 'DISCARDED') { excluded.push({ ...base, reason: { code: 'DISCARDED', text: 'Descartado' + (disposition.discard_reason ? ' (' + disposition.discard_reason + ')' : '') } }); return; }
    if (triageOut.has(journey.id)) { excluded.push({ ...base, reason: { code: 'TRIAGE_OUT', text: 'Fora do funil comercial (pós-venda, pessoal ou outro assunto)' } }); return; }
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

module.exports = { BANNED, searchGap, typeViolation, LANGS, OPT_OUT, OPT_OUT_WORD, QUEUE_MIN_DAYS, SCHEMA, INSTRUCTIONS, blockOf, detectLanguage, enabled, model, openAiSuggest, optOutOf, pathFor, queue, review, simulatedSuggestion, suggest, waLink };

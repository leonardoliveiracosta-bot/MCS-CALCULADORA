'use strict';

// "Destravar esta venda": dois especialistas, cada um com uma opção concreta de ação para este cliente comprar.
// Especialista em pessoas pela OpenAI e especialista em vendas pelo Claude, com as chaves e os tetos de gasto que o
// painel já usa. Nada é enviado nem gravado na ficha: as duas opções aparecem lado a lado para você escolher.
const { anthropicJson, aiContextWindow, reserveCall } = require('../../panel-ai');
const { leadData } = require('../../panel-lead');
const { requirePanel, send, jsonBody, safeText } = require('../../panel-server');
const guided = require('../../panel-reply-guided');
const suggest = require('../../panel-reply-suggest');
const openAiBudget = require('../../panel-openai-budget');
const feedback = require('../../panel-ai-feedback');
const PROMPT_VERSION = 'destravar-v2';

// Both are specialists in people AND in sales; each answers in its own way (OpenAI and Claude) from the same brief.
const BRIEF = [
  'Você é um especialista em pessoas e em vendas, do nível de quem constrói marcas de desejo, não um atendente atrás do balcão.',
  'Você influencia e não se deixa influenciar; é persuasivo sem pressionar; sabe quebrar o gelo, despertar o interesse da pessoa por você e conhece as premissas que geram conexão entre vendedor e comprador através da venda.',
  'A pessoa compra na emoção e justifica na razão: trabalhe desejo, emoção e percepção. Pense na percepção que cada palavra gera.',
  'A mensagem para o cliente: nunca soa como promoção de loja nem como vendedor de loja; sem emojis; sem listas numeradas; sem "responda com o número"; sem pressa fabricada ("saem em breve", "só hoje") e sem nada que você não saiba pelos dados.',
  'Tom das grandes marcas: desejo, emoção e conexão, nunca pressão de balcão. Nada com cara de máquina.',
  'Quando perguntar, faça uma pergunta aberta, que leve a pessoa a falar do que ela quer viver com o carro. Curta, humana, no tom de uma conversa entre adultos.',
  'Nunca prometa carro, preço, prazo ou disponibilidade.',
  'REGRAS DO PEDIDO: use cliente.tiposBusca e cliente.pedidos, nunca deduza o tipo pelo dinheiro disponível. POR_CARRO (Find One) é carro, anos e milhas: não pergunte lance ou orçamento. POR_VALOR (Calculate) é carro e lance máximo: não pergunte ano ou milhagem. Não peça novamente informação já presente na ficha ou conversa. Com dois tipos, mantenha cada pedido separado; com tipo desconhecido, não escolha em silêncio.',
  'O teto total confirmado e o lance máximo da calculadora são valores diferentes: nunca troque um pelo outro nem autorize ultrapassar nenhum limite. Use o pedido atual do cliente. Se a conversa contradiz a ficha, a ação pode esclarecer essa divergência sem inventar a resposta.',
  'MCS não tem estoque próprio. Uma busca real depende de a pessoa estar pronta para comprar; para compra distante, dê referência sem afirmar que a busca começou. Só apresente como opções atuais os carros fornecidos em carrosNoLote: Lane/Run com leilão ainda aberto, nunca Buy Now ou Make an Offer. Não prometa proteção mecânica por Clean Title, CR ou Green Light.',
  'TEMPO DA CONVERSA: antes de escrever, veja em tempo.diasDesdeUltimaTroca há quanto tempo foi a última troca com o cliente. Conversa recente (até 1 dia): fale direto, continuando de onde parou. Conversa parada há dias ou semanas: comece reaproximando a pessoa com naturalidade, como quem retoma contato de verdade; nunca entre direto no assunto como se tivessem falado ontem.',
  'A mensagem pode vir dividida no mesmo campo, em blocos "Mensagem 1:", "Mensagem 2:" (e "Mensagem 3:", se preciso), separados por uma linha em branco. Com conversa parada, a Mensagem 1 é a reaproximação; imagine a provável resposta da pessoa e escreva a Mensagem 2 (e a 3) a partir dela. Sem precisar de continuação, você ainda pode dividir em 2 ou 3 mensagens curtas: primeiro aborda a pessoa, depois entrega a mensagem principal. mensagemPt segue a mesma divisão de mensagemEn.',
  'Responda SOMENTE JSON {"titulo","acao","porque","mensagemPt","mensagemEn"}: titulo curto; acao é UMA ação concreta para hoje (o que fazer, como e por quê agora); porque em 1 a 2 frases com base nos dados; mensagemEn é o texto pronto para mandar ao cliente, em inglês natural de quem vive nos EUA; mensagemPt é a mesma mensagem em português, fiel ao inglês, para o vendedor ler. Tudo em português, menos a mensagemEn.'
].join(' ');
const OWN_STYLE = ' Gere a sua própria opção, no seu próprio estilo: outro especialista vai propor a dele lado a lado.';
const PEOPLE = BRIEF + OWN_STYLE;
const SALES = BRIEF + OWN_STYLE;
const SCHEMA = { type: 'object', additionalProperties: false, required: ['titulo', 'acao', 'porque', 'mensagemPt', 'mensagemEn'], properties: { titulo: { type: 'string' }, acao: { type: 'string' }, porque: { type: 'string' }, mensagemPt: { type: 'string' }, mensagemEn: { type: 'string' } } };
const clean = (value) => { const source = value && typeof value === 'object' ? value : {}; return { titulo: safeText(source.titulo, 200) || '', acao: safeText(source.acao, 2000) || '', porque: safeText(source.porque, 1200) || '', mensagemPt: safeText(source.mensagemPt, 1500) || '', mensagemEn: safeText(source.mensagemEn || source.mensagem, 1500) || '' }; };

// How long since the last exchange with the customer (any side), so the message never sounds like yesterday after weeks.
function since(messages, now = Date.now()) {
  const last = messages.map((message) => Date.parse(message.occurred_at_utc || message.created_at || '')).filter(Number.isFinite).sort((a, b) => b - a)[0];
  if (!last) return { ultimaTroca: null, diasDesdeUltimaTroca: null, agora: new Date(now).toISOString() };
  return { ultimaTroca: new Date(last).toISOString(), diasDesdeUltimaTroca: Math.floor((now - last) / 86400000), agora: new Date(now).toISOString() };
}

function searchContext(lead) {
  if (Array.isArray(lead.searchRequests) && lead.searchRequests.length) return {
    tiposBusca: [...new Set(lead.searchRequests.map((request) => 'POR_' + request.mode))],
    pedidos: lead.searchRequests.map((request) => ({ tipo: 'POR_' + request.mode, carro: request.wishes,
      ...(request.mode === 'VALOR' ? { lanceMaximo: request.bidCents ? request.bidCents / 100 : null } : {}) }))
  };
  const modes = [...new Set((lead.searchModes?.length ? lead.searchModes : lead.order?.logicalModes || []).filter((mode) => ['CARRO', 'VALOR'].includes(mode)))];
  return { tiposBusca: modes.map((mode) => 'POR_' + mode), pedidos: modes.map((mode) => ({ tipo: 'POR_' + mode,
    carro: lead.wishes, ...(mode === 'VALOR' ? { lanceMaximo: lead.maxBidCents ? lead.maxBidCents / 100 : null } : {}) })) };
}
async function contextOf(ctx, req, body, services = {}) {
  const lead = await (services.leadData || leadData)(ctx, req, String(body.ref || '').toUpperCase(), body.journeyId);
  if (!lead) return null;
  const messages = (lead.record?.conversation || []).filter((message) => !message.is_automatic && !message.undone_at);
  const window = aiContextWindow(messages, lead.maxBidCents ? lead.maxBidCents / 100 : null, lead.timezone || 'America/New_York');
  return { lead, input: {
    cliente: { ...searchContext(lead), nome: lead.record?.contact?.display_name || lead.order?.contactName || null, etapa: lead.record?.stage || null, desejo: lead.wishes, lanceMaximo: lead.maxBidCents ? lead.maxBidCents / 100 : null,
      tetoTotal: lead.totalCeilingCents ? lead.totalCeilingCents / 100 : null, pagamento: lead.paymentKnown || null, prazo: lead.record?.customer_deadline_text || lead.order?.deadlineText || null,
      carrosNoLote: (lead.batchActive ? lead.offers || [] : []).filter((car) => require('../../manheim-offer').purchaseOptions(car).some((sale) => String(sale.lane || '').trim() && String(sale.run || '').trim() && !require('../../manheim-offer').offerExpired(sale))).slice(0, 8).map((car) => ({ ano: car.year, modelo: [car.make, car.model, car.trim].filter(Boolean).join(' '), milhas: car.miles, mmr: car.mmrCents ? car.mmrCents / 100 : null })),
      jaApresentados: (lead.record?.units || []).map((unit) => unit.vehicle_text), anotacoes: (lead.notes || []).slice(-5).map((note) => String(note.body_text || '').slice(0, 600)) },
    tempo: since(messages), conversa: window.messages } };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  if (req.method === 'GET') {
    try { return send(res, 200, await feedback.metrics(ctx)); }
    catch (_) { return send(res, 503, { error: 'AI_METRICS_UNAVAILABLE' }); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const body = await jsonBody(req, 16 * 1024).catch(() => ({}));
  if (body.action === 'feedback') {
    try { const out = await feedback.feedback(ctx, body); return send(res, out.error ? 400 : 200, out); }
    catch (_) { return send(res, 503, { error: 'AI_FEEDBACK_UNAVAILABLE' }); }
  }
  const found = await contextOf(ctx, req, body).catch(() => null);
  if (!found) return send(res, 404, { error: 'LEAD_NOT_FOUND' });
  const subject = String(found.lead.record?.id || found.lead.ref || '-');
  const latency = {};
  // "Tentar de novo" on one failed card asks only that provider again.
  const only = body.only === 'OpenAI' || body.only === 'Claude' ? body.only : null;
  const skipped = Promise.reject(Object.assign(new Error('SKIPPED'), { code: 'SKIPPED' }));
  skipped.catch(() => {});
  const people = only === 'Claude' ? skipped : (async () => {
    const started = Date.now();
    try {
    const env = process.env;
    if (!env.OPENAI_API_KEY || !suggest.model(env)) throw Object.assign(new Error('OPENAI_UNAVAILABLE'), { code: 'OPENAI_UNAVAILABLE' });
    // The budget accepts only registered features: this is a guided reply (same cap and accounting).
    const guard = openAiBudget.guard(ctx, 'RESPOSTA_ORIENTADA', 'destravar:' + subject);
    const result = await guided.openAiJson({ instructions: PEOPLE, input: found.input, schema: SCHEMA, name: 'destravar_pessoas' }, { env, guard, timeoutMs: 40000 });
    await guided.recordCost(ctx, guard, 'unlock_sale_openai', subject, 'UNLOCK', result, {}, {});
    return clean(result.parsed);
    } finally { latency.OpenAI = Date.now() - started; }
  })();
  const sales = only === 'OpenAI' ? skipped : (async () => {
    const started = Date.now();
    try {
    await reserveCall(ctx);
    return clean(await anthropicJson(SALES, JSON.stringify(found.input), fetch, { ctx, feature: 'DESTRAVAR_VENDA', subject }));
    } finally { latency.Claude = Date.now() - started; }
  })();
  const [peopleOut, salesOut] = await Promise.allSettled([people, sales]);
  const pack = (outcome, provider, role) => outcome.status === 'fulfilled' && outcome.value.acao ? { ok: true, provider, role, ...outcome.value } : { ok: false, provider, role, error: (outcome.reason && (outcome.reason.code || outcome.reason.message)) || 'AI_UNAVAILABLE' };
  const options = [pack(peopleOut, 'OpenAI', 'Especialista em pessoas e vendas'), pack(salesOut, 'Claude', 'Especialista em pessoas e vendas')];
  for (const option of options) if (option.ok) option.suggestionId = await feedback.generated(ctx, { provider: option.provider,
    journeyId: found.lead.record?.id, text: option.mensagemEn, latencyMs: latency[option.provider], promptVersion: PROMPT_VERSION });
  return send(res, 200, { options: only ? options.filter((option) => option.provider === only) : options });
};
module.exports.contextOf = contextOf;
module.exports.searchContext = searchContext;
module.exports.BRIEF = BRIEF;

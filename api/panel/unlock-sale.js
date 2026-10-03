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

// Both are specialists in people AND in sales; each answers in its own way (OpenAI and Claude) from the same brief.
const BRIEF = [
  'Você é um especialista em pessoas e em vendas, do nível de quem constrói marcas de desejo, não um atendente atrás do balcão.',
  'Você influencia e não se deixa influenciar; é persuasivo sem pressionar; sabe quebrar o gelo, fazer a pessoa se interessar por você e criar a conexão entre quem vende e quem compra.',
  'A pessoa compra na emoção e justifica na razão: trabalhe desejo, emoção e percepção. Pense na percepção que cada palavra gera.',
  'A mensagem para o cliente: nunca soa como promoção de loja nem como vendedor de loja; sem emojis; sem listas numeradas; sem "responda com o número"; sem pressa fabricada ("saem em breve", "só hoje") e sem nada que você não saiba pelos dados.',
  'Quando perguntar, faça uma pergunta aberta, que leve a pessoa a falar do que ela quer viver com o carro. Curta, humana, no tom de uma conversa entre adultos.',
  'Escreva a mensagem no idioma em que o cliente escreve na conversa. Nunca prometa carro, preço, prazo ou disponibilidade.',
  'Responda SOMENTE JSON {"titulo","acao","porque","mensagem"}: titulo curto; acao é UMA ação concreta para hoje (o que fazer, como e por quê agora); porque em 1 a 2 frases com base nos dados; mensagem é o texto pronto para mandar ao cliente. Tudo em português, menos a mensagem.'
].join(' ');
const PEOPLE = BRIEF;
const SALES = BRIEF;
const SCHEMA = { type: 'object', additionalProperties: false, required: ['titulo', 'acao', 'porque', 'mensagem'], properties: { titulo: { type: 'string' }, acao: { type: 'string' }, porque: { type: 'string' }, mensagem: { type: 'string' } } };
const clean = (value) => { const source = value && typeof value === 'object' ? value : {}; return { titulo: safeText(source.titulo, 200) || '', acao: safeText(source.acao, 2000) || '', porque: safeText(source.porque, 1200) || '', mensagem: safeText(source.mensagem, 1500) || '' }; };

async function contextOf(ctx, req, body) {
  const lead = await leadData(ctx, req, String(body.ref || '').toUpperCase(), body.journeyId);
  if (!lead) return null;
  const messages = (lead.record?.conversation || []).filter((message) => !message.is_automatic && !message.undone_at);
  const window = aiContextWindow(messages, lead.maxBidCents ? lead.maxBidCents / 100 : null, lead.timezone || 'America/New_York');
  return { lead, input: {
    cliente: { nome: lead.record?.contact?.display_name || lead.order?.contactName || null, etapa: lead.record?.stage || null, desejo: lead.wishes, lanceMaximo: lead.maxBidCents ? lead.maxBidCents / 100 : null,
      tetoTotal: lead.totalCeilingCents ? lead.totalCeilingCents / 100 : null, pagamento: lead.paymentKnown || null, prazo: lead.record?.customer_deadline_text || lead.order?.deadlineText || null,
      carrosNoLote: (lead.offers || []).slice(0, 8).map((car) => ({ ano: car.year, modelo: [car.make, car.model, car.trim].filter(Boolean).join(' '), milhas: car.miles, mmr: car.mmrCents ? car.mmrCents / 100 : null })),
      jaApresentados: (lead.record?.units || []).map((unit) => unit.vehicle_text), anotacoes: (lead.notes || []).slice(-5).map((note) => String(note.body_text || '').slice(0, 600)) },
    conversa: window.messages } };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const body = await jsonBody(req, 16 * 1024).catch(() => ({}));
  const found = await contextOf(ctx, req, body).catch(() => null);
  if (!found) return send(res, 404, { error: 'LEAD_NOT_FOUND' });
  const subject = String(found.lead.record?.id || found.lead.ref || '-');
  const people = (async () => {
    const env = process.env;
    if (!env.OPENAI_API_KEY || !suggest.model(env)) throw Object.assign(new Error('OPENAI_UNAVAILABLE'), { code: 'OPENAI_UNAVAILABLE' });
    // The budget accepts only registered features: this is a guided reply (same cap and accounting).
    const guard = openAiBudget.guard(ctx, 'RESPOSTA_ORIENTADA', 'destravar:' + subject);
    const result = await guided.openAiJson({ instructions: PEOPLE, input: found.input, schema: SCHEMA, name: 'destravar_pessoas' }, { env, guard, timeoutMs: 40000 });
    await guided.recordCost(ctx, guard, 'unlock_sale_openai', subject, 'UNLOCK', result, {}, {});
    return clean(result.parsed);
  })();
  const sales = (async () => {
    await reserveCall(ctx);
    return clean(await anthropicJson(SALES, JSON.stringify(found.input), fetch, { ctx, feature: 'DESTRAVAR_VENDA', subject }));
  })();
  const [peopleOut, salesOut] = await Promise.allSettled([people, sales]);
  const pack = (outcome, provider, role) => outcome.status === 'fulfilled' && outcome.value.acao ? { ok: true, provider, role, ...outcome.value } : { ok: false, provider, role, error: (outcome.reason && (outcome.reason.code || outcome.reason.message)) || 'AI_UNAVAILABLE' };
  return send(res, 200, { options: [pack(peopleOut, 'OpenAI', 'Especialista em pessoas e vendas'), pack(salesOut, 'Claude', 'Especialista em pessoas e vendas')] });
};

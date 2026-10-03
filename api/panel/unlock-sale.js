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

const SHAPE = 'Responda SOMENTE JSON {"titulo","acao","porque","mensagem"}: titulo curto; acao é UMA ação concreta e executável hoje (o que fazer, como e quando); porque explica em 1 a 2 frases com base nos dados; mensagem é o texto pronto para mandar ao cliente no idioma dele, ou vazio se a ação não for mensagem. Tudo em português, menos a mensagem. Use só os dados recebidos; nunca prometa carro, preço, prazo ou disponibilidade.';
const PEOPLE = 'Você é especialista em PESSOAS (psicologia do comprador, confiança, objeções, momento de vida). Entregue a ação que destrava a decisão deste cliente. ' + SHAPE;
const SALES = 'Você é especialista em VENDAS de carros em leilão (oferta, urgência real, condição, fechamento). Entregue a ação que leva este cliente a comprar. ' + SHAPE;
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
    const guard = openAiBudget.guard(ctx, 'DESTRAVAR_VENDA', 'destravar:' + subject);
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
  return send(res, 200, { options: [pack(peopleOut, 'OpenAI', 'Especialista em pessoas'), pack(salesOut, 'Claude', 'Especialista em vendas')] });
};

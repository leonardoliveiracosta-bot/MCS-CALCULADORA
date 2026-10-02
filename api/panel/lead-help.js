'use strict';

const { anthropicJson, aiContextWindow, reserveCall } = require('../../panel-ai');
const { ensureJourney, leadData } = require('../../panel-lead');
const { insert, jsonBody, requirePanel, rows, safeText, send } = require('../../panel-server');
const { loadSearchStageIndex } = require('../../panel-search-stage');

function answer(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    situacao: safeText(source.situacao, 3000) || '',
    sugestao: safeText(source.sugestao, 3000) || '',
    mensagem_en: safeText(source.mensagem_en, 1500) || '',
    traducao_pt: safeText(source.traducao_pt, 2000) || ''
  };
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res); if (!ctx) return;
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  try {
    const body = await jsonBody(req, 16 * 1024);
    const question = safeText(body.question, 12000, true);
    if (!question) return send(res, 400, { error: 'HELP_QUESTION_REQUIRED' });
    const lead = await leadData(ctx, req, String(body.ref || '').toUpperCase(), body.journeyId);
    if (!lead) return send(res, 404, { error: 'LEAD_NOT_FOUND' });
    const journey = await ensureJourney(ctx, lead);
    const stageIndex = await loadSearchStageIndex(ctx);
    const stage = stageIndex.get(journey.id);
    const messages = (lead.record?.conversation || []).filter((message) => !message.is_automatic && !message.undone_at);
    const window = aiContextWindow(messages, lead.maxBidCents ? lead.maxBidCents / 100 : null, 'America/New_York');
    const context = {
      perguntaDoDono: question,
      lead: {
        nome: lead.record?.contact?.display_name || lead.order?.contactName || null,
        ref: lead.ref, tipoBusca: lead.order?.logicalModes?.length ? lead.order.logicalModes.map((mode) => mode === 'CARRO' ? 'POR_CARRO' : 'POR_VALOR') : null, desejo: lead.wishes, lanceMaximo: lead.maxBidCents ? lead.maxBidCents / 100 : null,
        tetoTotal: lead.totalCeilingCents ? lead.totalCeilingCents / 100 : null, pagamento: lead.payment,
        prazo: lead.record?.customer_deadline_text || lead.order?.deadlineText || null,
        etapaBusca: stage?.label || '🔍 Busca não salva no Manheim', diasSemResposta: lead.lastCustomerAt ? Math.floor((Date.now() - Date.parse(lead.lastCustomerAt)) / 86400000) : null,
        carrosCompativeisManheim: (lead.fits || []).slice(0, 8)
      },
      conversa: window.messages
    };
    await reserveCall(ctx);
    const parsed = await anthropicJson(
      'Você ajuda o dono da My Car Scout. Responda SOMENTE JSON {situacao,sugestao,mensagem_en,traducao_pt}. situacao e sugestao em português. Use exclusivamente os dados recebidos; nunca prometa carro, preço, prazo ou disponibilidade. Regra da mesa: quem busca POR CARRO (Find One: carro, faixa de ano e de milhagem) nunca recebe pergunta de lance, orçamento ou valor; quem busca POR VALOR (carro e lance máximo) nunca recebe pergunta de ano ou milhagem; não sugira perguntar o que o cliente ou a calculadora já informaram. Abaixo de US$ 10 mil: breve e factual; carro até US$ 7.000 só à vista. mensagem_en deve ser inglês natural e informal, uma única frase corrida ligada por vírgulas, sem tom de vendedor. traducao_pt é a tradução completa da mensagem_en.',
      JSON.stringify(context),fetch,{ctx,feature:'OPINIAO_IA',subject:String(journey.id)}
    );
    const result = answer(parsed);
    await insert(ctx, 'lead_ai_help', { environment: ctx.environment, journey_id: journey.id, ref_code: lead.ref || null, question, answer_json: result, created_by: ctx.panel.id }, false);
    // Destination and 24 h window, so the message takes the same send path as the suggestions.
    let sendInfo = null;
    try {
      const reply = require('./reply'); const suggest = require('../../panel-reply-suggest');
      const target = await reply.resolveTarget(ctx, journey.id, { rows });
      const window = target ? await reply.windowState(ctx, target.chat.id, { rows }) : null;
      sendInfo = { journeyId: journey.id, reachable: Boolean(target), contact: target ? { name: target.name, phone: target.phone } : null, whatsappBase: target ? suggest.waLink(target.phone, '') : null, path: suggest.pathFor(window || {}) };
    } catch (_) { sendInfo = null; }
    return send(res, 201, { answer: result, journeyId: journey.id, send: sendInfo });
  } catch (error) {
    if (error.message === 'AI_DAILY_LIMIT') return send(res, 429, { error: 'AI_DAILY_LIMIT' });
    return send(res, 503, { error: 'AI_UNAVAILABLE' });
  }
};
module.exports.answer = answer;

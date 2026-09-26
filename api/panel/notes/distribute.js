'use strict';
const { digest, validItems } = require('../../../panel-note');
const { jsonBody, requirePanel, safeText, send } = require('../../../panel-server');
const { leadData } = require('../../../panel-lead');
module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  if (!process.env.ANTHROPIC_API_KEY) return send(res, 503, { error: 'ANTHROPIC_KEY_MISSING' });
  try {
    const body = await jsonBody(req, 20 * 1024);
    const ref = String(body.ref || '').trim().toUpperCase();
    const note = safeText(body.note, 12000, true);
    if (!note) return send(res, 400, { error: 'NOTE_REQUIRED' });
    const lead = await leadData(ctx, req, ref, body.journeyId);
    if (!lead) return send(res, 404, { error: 'LEAD_NOT_FOUND' });
    const current = {
      ref: lead.ref, timezone: lead.timezone, name: lead.record?.contact?.display_name || lead.order?.contactName || null,
      budget: lead.ceilingCents ? lead.ceilingCents / 100 : null, payment: lead.payment,
      deadline: lead.record?.customer_deadline_text || lead.order?.deadlineText || null,
      wishes: lead.wishes, checklist: lead.record?.checklist || [], stage: lead.record?.stage || 'NOVO'
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let response, result;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5', max_tokens: 2200,
          system: 'Você organiza anotações de ligação para um painel privado. Retorne SOMENTE JSON válido, sem markdown: {"items":[{"type":"...","value":...,"point":1,"evidence":"trecho literal", "dueAt":"ISO opcional"}]}. Cada item DEVE citar um trecho literal e contínuo da anotação; não inferir fatos nem incluir item sem evidência. Tipos permitidos: call_result com value ANSWERED/NO_ANSWER/LATER/IN_PERSON; checklist com point 1..6 e value OK; budget com value numérico em dólares (confirmado); payment cash/fin; deadline now/30d/3m/none; wishlist com value {cars:[{make,model,yearMin,yearMax,maxMiles}]} em ordem de preferência, preservando carros existentes quando a anotação só mudar a ordem; phone com value {number,owner}; promise e return com value {text,at} em ISO; stage com value NOVO/RESPONDIDO/EM_BUSCA/DECIDINDO/QUALIFICADO; disable com value {reason} apenas como sugestão. Converta datas relativas no fuso do cliente usando o instante atual indicado. Não trate hipóteses como confirmação. Não preencha dados ausentes.',
          messages: [{ role: 'user', content: JSON.stringify({ note, current, now: new Date().toISOString() }) }]
        })
      });
      if (!response.ok) return send(res, 503, { error: 'DISTRIBUTION_UNAVAILABLE' });
      result = await response.json();
    } finally { clearTimeout(timer); }
    const raw = (result.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('');
    const parsed = JSON.parse(raw);
    const items = validItems(note, parsed.items);
    return send(res, 200, { items, signature: digest(ctx.config.secretKey, lead.ref, note, items) });
  } catch (_) {
    return send(res, 503, { error: 'DISTRIBUTION_UNAVAILABLE' });
  }
};

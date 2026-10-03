'use strict';
// Fila das mensagens da calculadora que a regra não decidiu sozinha (motivo e evidência), e a decisão da operadora:
//   POST { action: 'link', messageId, journeyId }  liga a mensagem à ficha escolhida
//   POST { action: 'new', messageId }              cria ficha nova para o contato da mensagem
//   POST { action: 'name_confirm', messageId, journeyId }   Confirmar vínculo: é a mesma pessoa (junta, se ainda não estava junto)
//   POST { action: 'name_separate', messageId, journeyId }  não é a mesma pessoa: a simulação sai desta ficha e vai para uma ficha própria
// A decisão manual fica gravada (manual=true) e a regra nunca a desfaz.
const { isUuid, jsonBody, requirePanel, send, supabase } = require('../../panel-server');
const route = require('../../panel-calc-route');

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'GET') return send(res, 200, { queue: await route.loadQueue(ctx) });
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 4096);
    if (body.action === 'name_confirm' || body.action === 'name_separate') {
      if (!isUuid(body.messageId) || !isUuid(body.journeyId)) return send(res, 400, { error: 'CALC_ROUTE_INVALID' });
      const decided = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_name_link_decide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        p_environment: ctx.environment, p_message_id: body.messageId, p_journey_id: body.journeyId, p_decision: body.action === 'name_confirm' ? 'CONFIRMED' : 'SEPARATED', p_actor: ctx.panel.id, p_rule_version: route.RULE_VERSION }) });
      return send(res, 200, decided);
    }
    if (!isUuid(body.messageId) || !['link', 'new'].includes(body.action) || (body.action === 'link' && !isUuid(body.journeyId))) return send(res, 400, { error: 'CALC_ROUTE_INVALID' });
    const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_calc_route_apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      p_environment: ctx.environment, p_message_id: body.messageId, p_destination: body.action === 'new' ? 'NOVA_FICHA' : 'LIGADA_TELEFONE', p_reason: 'DECISAO_MANUAL',
      p_ref_state: ['REF', 'REF_ILEGIVEL', 'SEM_LINHA_REF'].includes(body.refState) ? body.refState : 'SEM_LINHA_REF', p_ref: typeof body.ref === 'string' ? body.ref : null,
      p_journey_id: body.action === 'link' ? body.journeyId : null, p_evidence: { decidedIn: 'painel' }, p_rule_version: route.RULE_VERSION,
      p_link: body.action === 'link', p_create: body.action === 'new', p_manual: true, p_actor: ctx.panel.id }) });
    if (result && result.skipped) return send(res, 409, { error: 'CALC_ROUTE_' + result.skipped });
    return send(res, 200, result);
  } catch (error) {
    return send(res, 500, { error: 'CALC_ROUTE_FAILED' });
  }
};

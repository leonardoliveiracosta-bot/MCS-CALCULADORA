'use strict';

// Correção manual do assunto de uma conversa (ficha). Vale mais que a leitura do Claude e nunca é sobrescrita por ela;
// subject null devolve a ficha à leitura do Claude. Não envia nada a ninguém.
const { isUuid, jsonBody, requirePanel, send, supabase } = require('../../panel-server');
const { SUBJECT_KEYS } = require('../../panel-classification');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const body = await jsonBody(req, 4 * 1024);
    const subject = body.subject === null ? null : String(body.subject || '').toUpperCase();
    if (!isUuid(body.journeyId) || (subject !== null && !SUBJECT_KEYS.includes(subject))) return send(res, 400, { error: 'SUBJECT_INVALID' });
    const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_subject_set_manual', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_environment: ctx.environment, p_journey_id: body.journeyId, p_subject: subject, p_actor: ctx.panel.id })
    });
    return send(res, 200, result);
  } catch (error) {
    return send(res, 500, { error: 'SUBJECT_UPDATE_FAILED' });
  }
};

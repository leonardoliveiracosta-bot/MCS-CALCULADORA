'use strict';

// MANHEIM_MATCH_AUDIT pelo painel. GET: estado da conferência do lote ativo. POST:
//  run       confere o que falta (chamado logo depois do upload; o cron repete como segurança)
//  check     confere agora uma demanda ainda não conferida (antes do link V1), com as regras
//            automáticas: nunca repete além do limite de tentativas nem passa do teto da OpenAI
//  retry     tenta de novo uma demanda com "Conferência pendente"
//  approve   aprovação manual com motivo registrado (nunca sobre um fato achado pelo servidor)
//  authorize libera um lote parado em "aguardando autorização" (só administrador; nunca acima do teto de US$ 50 da OpenAI)
// Com MANHEIM_MATCH_AUDIT_ENABLED desligada nada é chamado e nada é bloqueado.
const { jsonBody, requirePanel, send } = require('../../panel-server');
const { manheimView } = require('../../panel-buscas-view');
const audit = require('../../panel-manheim-audit');

const KEY = /^(journey:[0-9a-f-]{36}|ref:[A-Z0-9]{5}):(VALOR|CARRO)$/;

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  const startedAt = Date.now();
  try {
    if (!['GET', 'POST'].includes(req.method)) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const state = audit.status();
    // Off: nothing is read, called or blocked.
    if (state !== 'LIGADA') return send(res, 200, req.method === 'GET' ? { state, byDemand: {} } : { skipped: state, processed: 0 });
    const input = await manheimView(ctx, { auditInput: true });
    if (req.method === 'GET') return send(res, 200, await audit.viewState(ctx, input));
    const body = await jsonBody(req, 4096);
    if (body.action === 'approve') {
      if (!KEY.test(String(body.key || ''))) return send(res, 400, { error: 'AUDIT_KEY_INVALID' });
      return send(res, 200, await audit.approve(ctx, input, body.key, body.reason, ctx.panel.id));
    }
    if (body.action === 'run') return send(res, 200, await audit.runAudit(ctx, input, { deadlineAt: startedAt + 55000 }));
    if (body.action === 'check') {
      if (!KEY.test(String(body.key || ''))) return send(res, 400, { error: 'AUDIT_KEY_INVALID' });
      return send(res, 200, await audit.runAudit(ctx, input, { onlyKey: body.key, deadlineAt: startedAt + 55000 }));
    }
    if (body.action === 'retry') {
      if (!KEY.test(String(body.key || ''))) return send(res, 400, { error: 'AUDIT_KEY_INVALID' });
      return send(res, 200, await audit.runAudit(ctx, input, { onlyKey: body.key, manual: true, deadlineAt: startedAt + 55000 }));
    }
    if (body.action === 'authorize') {
      if (ctx.panel.role !== 'admin') return send(res, 403, { error: 'AUDIT_ADMIN_ONLY' });
      if (!input.upload) return send(res, 409, { error: 'AUDIT_NOTHING_TO_AUTHORIZE' });
      const authorized = await audit.authorize(ctx, input.upload.id, ctx.panel.id);
      const result = await audit.runAudit(ctx, input, { deadlineAt: startedAt + 55000 });
      return send(res, 200, { ...authorized, ...result });
    }
    return send(res, 400, { error: 'AUDIT_ACTION_INVALID' });
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error?.code || '')) ? error.code : 'PANEL_AUDIT_ERROR';
    return send(res, code === 'PANEL_AUDIT_ERROR' ? 500 : 409, { error: code });
  }
};

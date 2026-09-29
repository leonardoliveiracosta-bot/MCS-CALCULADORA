'use strict';

// Reserva atômica antes de qualquer chamada paga à OpenAI: tipo da tarefa + conversa ou demanda +
// hash do conteúdo + versão da regra (tabela ai_task_claims, função panel_ai_task_claim). Só quem
// obtém a reserva chama; outra execução ao mesmo tempo (cron e botão, upload e cron) recebe
// "já em processamento" e não chama. Uma reserva abandonada é retomada depois do prazo.
// Sem a tabela (migração não aplicada) a chamada falha e nada é pago.
const { supabase } = require('./panel-server');

const TTL_SECONDS = 300;

async function claimTask(ctx, task) {
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_ai_task_claim', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_environment: ctx.environment, p_task_kind: task.kind, p_subject_key: String(task.subject), p_content_hash: task.hash, p_rule_version: task.rule, p_ttl_seconds: task.ttlSeconds || TTL_SECONDS })
  });
  return result && result.claimed === true ? { claimed: true, id: result.id, token: result.token } : { claimed: false, status: result && result.status || null };
}

// done: the reading is finished for good (CONCLUIDA). Otherwise it may be retried (LIBERADA).
async function finishTask(ctx, claim, done) {
  if (!claim || !claim.claimed) return null;
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_ai_task_finish', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_environment: ctx.environment, p_claim_id: claim.id, p_token: claim.token, p_status: done ? 'CONCLUIDA' : 'LIBERADA' })
  });
}

module.exports = { TTL_SECONDS, claimTask, finishTask };

'use strict';

// Crédito pré-pago de cada IA. OpenAI: US$ 50 já pagos são o teto único, contando todo o gasto desde
// o começo, com aviso em US$ 40 e nenhum limite por função (o dono informa um novo total se carregar
// mais). Claude: os US$ 50 depositados, separados da OpenAI, contando o gasto registrado desde o
// começo; o uso anterior sem custo registrado aparece como desconhecido (nunca zero) até o dono
// informar o saldo do console. Nenhum limite por função. O provedor que disse "sem saldo" para
// até um novo valor ser informado. Nunca chama uma IA.
const { allRows, jsonBody, requirePanel, rpc, send } = require('../../panel-server');
const budget = require('../../panel-openai-budget');

const LABELS = Object.freeze({ pesquisas: 'BUSCAR CARROS (leitura de pedidos)', entrada: 'Triagem do ATENDIMENTO', manheimAudit: 'Conferência do Manheim', manheimCsv: 'Leitura de CSV do Manheim', resposta: 'Sugestão de resposta', respostaOrientada: 'Resposta orientada', traducao: 'Tradução da conversa', destravar: 'Destravar esta venda', rascunhoV2: 'Rascunho da V2', assistente: 'Assistente do painel' });
const CLAUDE_LABELS = Object.freeze({ LEITURA: 'Leitura automática das conversas', LEITURA_MANUAL: 'Ler conversa agora', LEITURA_GERAL: 'Leitura geral das pendências', LIGAR_PEDIDO: 'Sugestão de pedido da conversa', PRINT_SMS: 'Leitura de print de SMS', NOTA: 'Distribuir anotação', OPINIAO_IA: 'Opinião da IA', TRADUCAO_RESPOSTA: 'Tradução da resposta', ASSUNTO: 'Classificar assunto', DESTRAVAR_VENDA: 'Destravar esta venda' });
const round = (value) => Math.round(Number(value || 0) * 1e6) / 1e6;
const view = (state) => ({ balanceUsd: state.balance === null || state.balance === undefined ? null : Number(state.balance), setAt: state.setAt || null,
  spentUsd: round(state.spent), remainingUsd: state.remaining === null || state.remaining === undefined ? null : round(state.remaining),
  warn: Boolean(state.warn), warnAtUsd: state.warnAt === undefined || state.warnAt === null ? null : Number(state.warnAt), exhausted: Boolean(state.exhausted), informed: Boolean(state.informed), sinceStart: Boolean(state.sinceStart),
  // Claude: calls made before the reservations existed have no recorded cost (unknown, never zero).
  priorUnknown: Boolean(state.priorUnknown), priorCalls: state.priorCalls === undefined || state.priorCalls === null ? null : Number(state.priorCalls),
  priorFrom: state.priorFrom || null, priorTo: state.priorTo || null, trackedSince: state.trackedSince || null });

async function claudeByFeature(ctx, since) {
  const rows = await allRows(ctx, 'anthropic_budget_holds', { select: 'feature,status,amount_usd,actual_usd', environment: 'eq.' + ctx.environment, status: 'neq.LIBERADA', ...(since ? { created_at: 'gte.' + since } : {}) });
  const by = new Map();
  rows.forEach((row) => by.set(row.feature, (by.get(row.feature) || 0) + Number(row.status === 'ABERTA' ? row.amount_usd : row.actual_usd || 0)));
  return [...by].map(([key, value]) => ({ key, label: CLAUDE_LABELS[key] || key, spentUsd: round(value) }));
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (req.method === 'POST') {
      // Informar o saldo do console (só o dono): passa a valer a partir de agora.
      if (ctx.panel.role !== 'admin') return send(res, 403, { error: 'AI_BALANCE_ADMIN_ONLY' });
      const body = await jsonBody(req, 4 * 1024);
      const provider = String(body.provider || '').toUpperCase();
      const amount = Number(String(body.balanceUsd ?? '').replace(',', '.'));
      if (!['OPENAI', 'ANTHROPIC'].includes(provider)) return send(res, 400, { error: 'AI_PROVIDER_INVALID' });
      if (!Number.isFinite(amount) || amount < 0 || amount > 100000) return send(res, 400, { error: 'AI_BALANCE_INVALID' });
      const state = await rpc(ctx, 'panel_ai_set_balance', { p_environment: ctx.environment, p_provider: provider, p_balance: Math.round(amount * 100) / 100, p_actor: ctx.panel.id });
      return send(res, 200, { provider, ...view(state || {}) });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const [openai, anthropic, spent] = await Promise.all([
      rpc(ctx, 'panel_ai_balance_state', { p_environment: ctx.environment, p_provider: 'OPENAI' }),
      rpc(ctx, 'panel_ai_balance_state', { p_environment: ctx.environment, p_provider: 'ANTHROPIC' }),
      budget.spentUsd(ctx)
    ]);
    // Same window as the spend shown: since the informed balance, else since the start.
    const claude = await claudeByFeature(ctx, anthropic && anthropic.setAt ? anthropic.setAt : anthropic && anthropic.sinceStart ? null : new Date(Date.now() - 30 * 86400000).toISOString()).catch(() => []);
    return send(res, 200, {
      openai: { ...view(openai || {}), features: Object.entries(spent.byFeature || {}).map(([key, value]) => ({ key, label: LABELS[key] || key, spentUsd: round(value) })) },
      anthropic: { ...view(anthropic || {}), features: claude }
    });
  } catch (_) {
    return send(res, 503, { error: 'AI_BALANCE_UNAVAILABLE' });
  }
};

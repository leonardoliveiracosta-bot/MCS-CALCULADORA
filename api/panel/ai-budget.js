'use strict';

// O teto único de US$ 50 da OpenAI, com o gasto de cada função visível (sem sublimite por função).
// Só leitura: nunca chama a OpenAI.
const { requirePanel, send } = require('../../panel-server');
const budget = require('../../panel-openai-budget');

const LABELS = Object.freeze({ pesquisas: 'PESQUISAS (leitura de pedidos)', entrada: 'Triagem da ENTRADA', manheimAudit: 'Conferência do Manheim', manheimCsv: 'Leitura de CSV do Manheim', resposta: 'Sugestão de resposta', respostaOrientada: 'Resposta orientada', traducao: 'Tradução da conversa' });

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const spent = await budget.spentUsd(ctx);
    const limit = budget.LIMIT_USD;
    return send(res, 200, { limitUsd: limit, warnAtUsd: limit * 0.8, spentUsd: spent.total, warn: spent.total >= limit * 0.8,
      features: Object.entries(spent.byFeature || {}).map(([key, value]) => ({ key, label: LABELS[key] || key, spentUsd: Math.round(Number(value) * 1e6) / 1e6 })) });
  } catch (_) {
    return send(res, 503, { error: 'OPENAI_BUDGET_UNAVAILABLE' });
  }
};

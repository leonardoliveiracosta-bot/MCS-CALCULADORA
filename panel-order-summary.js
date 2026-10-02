'use strict';
// Resumo da IA por PEDIDO, nunca por conversa.
//   orders:    as Refs de pedido que a ficha realmente tem
//   summaries: o que o Claude escreveu por pedido (panel_conversation_class.request_summaries): [{ref, summary, ambiguous}]
// Resultado:
//   POR_PEDIDO  cada pedido com o próprio resumo
//   AMBIGUO     há mais de um pedido e a leitura não os distingue: a ambiguidade é declarada, o texto não vai a nenhum pedido
//   SEM_LEITURA ainda não há resumo por pedido
const up = (value) => String(value || '').trim().toUpperCase();

function orderSummaries({ orders = [], summaries = [] } = {}) {
  const refs = [...new Set(orders.map(up).filter(Boolean))];
  const list = (Array.isArray(summaries) ? summaries : []).filter((entry) => entry && String(entry.summary || '').trim());
  if (!list.length) return { state: 'SEM_LEITURA', items: [], text: 'Ainda não há resumo da IA por pedido.' };
  const named = list.filter((entry) => entry.ref && refs.includes(up(entry.ref)));
  const unnamed = list.filter((entry) => !entry.ref || !refs.includes(up(entry.ref)));
  if (refs.length <= 1) {
    const only = refs[0] || null;
    const first = named[0] || unnamed[0];
    return { state: 'POR_PEDIDO', items: [{ ref: only, summary: String(first.summary).trim() }], text: null };
  }
  if (named.length >= 1) {
    const seen = new Set();
    const items = named.filter((entry) => !seen.has(up(entry.ref)) && seen.add(up(entry.ref))).map((entry) => ({ ref: up(entry.ref), summary: String(entry.summary).trim() }));
    const missing = refs.filter((ref) => !seen.has(ref));
    return { state: missing.length ? 'AMBIGUO' : 'POR_PEDIDO', items, missing, text: missing.length ? `A leitura não distingue o pedido ${missing.join(', ')}: ambiguidade declarada, nenhum resumo foi atribuído a ele.` : null };
  }
  return { state: 'AMBIGUO', items: [], missing: refs, text: `Esta ficha tem ${refs.length} pedidos (${refs.join(', ')}) e a leitura não os distingue: ambiguidade declarada, o resumo da conversa não foi atribuído a nenhum pedido.` };
}

module.exports = { orderSummaries };

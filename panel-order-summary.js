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


// Pendências: each item is one conversation of a ficha.
//   0 orders  -> the summary is of the conversation and says so (scope 'conversa')
//   1 order   -> that order's summary
//   2+ orders -> one summary per order; what the reading cannot tell apart is declared ambiguous, waiting for the AI.
// The old conversation-level text (conversation_pending_insights) only fills the case without orders, marked as conversation.
const AMBIGUOUS_TEXT = 'Ambíguo · aguardando a IA separar os pedidos';
function pendingSummary({ orders = [], summaries = [], conversationSummary = '' } = {}) {
  const refs = [...new Set(orders.map(up).filter(Boolean))];
  if (!refs.length) {
    const own = (Array.isArray(summaries) ? summaries : []).find((entry) => entry && String(entry.summary || '').trim());
    const text = String(own ? own.summary : conversationSummary || '').trim();
    return text ? { state: 'CONVERSA', items: [{ ref: null, scope: 'conversa', summary: text }], text: null } : { state: 'SEM_LEITURA', items: [], text: null };
  }
  const base = orderSummaries({ orders: refs, summaries });
  if (base.state === 'SEM_LEITURA') {
    // One order in one conversation: the conversation's reading is that order's only text, kept marked as the conversation's.
    const text = String(conversationSummary || '').trim();
    return refs.length === 1 && text ? { state: 'CONVERSA', items: [{ ref: refs[0], scope: 'conversa', summary: text }], text: null } : { state: 'SEM_LEITURA', items: [], text: null };
  }
  const items = base.items.map((entry) => ({ ...entry, scope: 'pedido' }));
  if (base.state === 'AMBIGUO') return { state: 'AMBIGUO', items, missing: base.missing, text: AMBIGUOUS_TEXT };
  return { state: 'PEDIDO', items, text: null };
}

module.exports = { orderSummaries, pendingSummary, AMBIGUOUS_TEXT };

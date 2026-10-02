(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MCSAttention = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // O que vem primeiro no padrão ("Pronto para ligar"): quem espera resposta, depois retornos vencidos, depois o resto.
  // Uma classificação (quer este carro, temperatura, pontuação) nunca passa na frente de um cliente que aguarda resposta;
  // ela só ordena dentro do mesmo grau. A escolha de ordenação do usuário continua mandando nas demais ordens.
  //  0 = resposta pendente (mensagem do cliente sem resposta, inclusive depois de um agendamento) ou retorno/promessa vencida;
  //      dentro do grau, quem espera ou está vencido há mais tempo vem primeiro
  //  1 = outra decisão que é sua (vínculo, revisão, vitrine), sem item de conversa
  //  2 = o resto
  const stamp = (value) => { const at = Date.parse(value || ''); return Number.isFinite(at) ? at : 0; };

  function nextAt(item) { return stamp(item && (item.next_action_at || item.nextActionAt)); }

  function rankOf(item, now = Date.now()) {
    const group = item && item.group || {};
    const unattended = group.unattended;
    if (unattended && unattended.reason === 'NO_RESPONSE') return 0;
    // An older message of a case scheduled for later is handled by that schedule (see atendimento.js).
    if (item && item.awaitingReply && !(nextAt(item) > now)) return 0;
    const reasons = (item && item.todayReasons) || [];
    const overdue = reasons.some((reason) => ['NEXT_ACTION', 'PROMISE', 'MISSING_NEXT_ACTION'].includes(reason.kind)) || Boolean(item && item.promiseToday)
      || Boolean(nextAt(item) && nextAt(item) <= now);
    return overdue ? 0 : 2;
  }

  // When the wait began (rank 0) or the return fell due (rank 1); 0 when unknown.
  function sinceOf(item, now = Date.now()) {
    const rank = rankOf(item, now);
    const group = item && item.group || {};
    if (rank !== 0) return 0;
    // A pending reply counts from the customer's message; an overdue return from the day it fell due.
    const waiting = stamp(group.unattended && group.unattended.since) || stamp(item && item.lastCustomerAt) || stamp(item && item.lastCustomerMessage && item.lastCustomerMessage.at) || 0;
    const due = ((item && item.todayReasons) || []).map((reason) => stamp(reason.dueAt)).filter(Boolean);
    const overdueAt = Math.min(...due, nextAt(item) && nextAt(item) <= now ? nextAt(item) : Infinity);
    return Math.min(waiting || Infinity, Number.isFinite(overdueAt) ? overdueAt : Infinity) === Infinity ? 0 : Math.min(waiting || Infinity, Number.isFinite(overdueAt) ? overdueAt : Infinity);
  }

  // Negative when left goes first. Equal for two items in the same grade without a longer wait.
  function compare(left, right, now = Date.now()) {
    const a = rankOf(left, now), b = rankOf(right, now);
    if (a !== b) return a - b;
    if (a === 2) return 0;
    const first = sinceOf(left, now), second = sinceOf(right, now);
    if (first && second) return first - second;
    return first ? -1 : second ? 1 : 0;
  }

  return { rankOf, sinceOf, compare };
}));

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCSGroups = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Grupos de contato em HOJE, ENTRADA e CLIENTES. Só apresentação: nada aqui grava, envia ou muda regra.
  // Um contato fica em um grupo só, nesta ordem de precedência:
  //   1. FORA_DO_ASSUNTO  a conversa nunca tratou de carro (triagem da IA ou correção sua)
  //   2. NAO_ATENDIDO     mensagem do cliente sem resposta, ou nenhuma ação registrada há 7 dias ou mais
  //   3. origem           calculadora por valor, calculadora por carro, financiamento ou direto
  // Origem: calculadora quando há pedido da calculadora ligado ao contato; senão, a origem da primeira
  // mensagem. Contato com as duas (pedido da calculadora e conversa que começou direto) fica com a mais recente.
  const DAY = 86400000;
  const STALE_DAYS = 7;
  const DIRECT_SOURCES = new Set(['WHATSAPP_DIRECT', 'SMS_DIRECT']);
  // As duas mensagens prontas do formulário de financiamento do site (index.html, bloco 4).
  const FINANCING_RE = /talk about financing a car|want to finance a car/i;

  const GROUPS = {
    NAO_ATENDIDO: { key: 'NAO_ATENDIDO', label: 'Não atendidos', hint: 'Mensagem do cliente sem resposta, ou nenhuma ação registrada há 7 dias ou mais', order: 0 },
    CALC_VALOR: { key: 'CALC_VALOR', label: 'Calculadora · por valor', hint: 'Pedido da calculadora com lance máximo (VALOR)', order: 1 },
    CALC_CARRO: { key: 'CALC_CARRO', label: 'Calculadora · por carro', hint: 'Pedido da calculadora com carro, anos e milhagem (CARRO)', order: 2 },
    FINANCIAMENTO: { key: 'FINANCIAMENTO', label: 'Financiamento', hint: 'Começou pelo formulário de financiamento do site', order: 3 },
    DIRETO: { key: 'DIRETO', label: 'Direto pelo WhatsApp ou SMS', hint: 'Escreveu direto, sem pedido da calculadora', order: 4 },
    FORA_DO_ASSUNTO: { key: 'FORA_DO_ASSUNTO', label: 'Fora do assunto', hint: 'A conversa nunca tratou de carro, compra, financiamento, orçamento ou serviço da MCS · Nada foi apagado', order: 5 }
  };
  const ORDER = Object.values(GROUPS).sort((a, b) => a.order - b.order).map((group) => group.key);

  const stamp = (value) => { if (typeof value === 'number') return Number.isFinite(value) ? value : 0; const parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? parsed : 0; };
  const isFinancing = (text) => FINANCING_RE.test(String(text || ''));

  function originOf(facts) {
    const f = facts || {};
    const modes = (f.calcModes || []).filter((mode) => mode === 'VALOR' || mode === 'CARRO');
    const financing = Boolean(f.financing);
    const directKey = financing ? 'FINANCIAMENTO' : 'DIRETO';
    if (!modes.length) return directKey;
    const calcKey = (f.calcMode === 'CARRO' || f.calcMode === 'VALOR' ? f.calcMode : modes[0]) === 'CARRO' ? 'CALC_CARRO' : 'CALC_VALOR';
    // Com as duas origens, vale a mais recente: a conversa direta só ganha quando começou depois do pedido.
    const direct = financing || DIRECT_SOURCES.has(String(f.source || '').toUpperCase());
    if (direct && stamp(f.firstCustomerAt) > stamp(f.calcAt)) return directKey;
    return calcKey;
  }

  function waited(ms) {
    const minutes = Math.max(1, Math.floor(ms / 60000));
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h`;
    return `${Math.floor(hours / 24)} dias`;
  }

  // Não atendido: a mesma "Sem resposta" da PENDÊNCIAS (a última mensagem real é do cliente), ou nenhuma
  // ação registrada há 7 dias ou mais. Próxima ação marcada para o futuro conta como ação registrada.
  // Caso encerrado, desligado, tratado ou descartado depois do último fato não entra pela regra dos 7 dias.
  function unattendedOf(facts, now = Date.now()) {
    const f = facts || {};
    const disposedAt = f.disposition ? stamp(f.dispositionAt) : 0;
    const lastCustomer = stamp(f.lastCustomerAt);
    if (f.awaitingReply && lastCustomer && !(disposedAt && disposedAt >= lastCustomer)) {
      return { since: new Date(lastCustomer).toISOString(), waitedMs: now - lastCustomer, waitedText: waited(now - lastCustomer), reason: 'NO_RESPONSE', missing: 'Resposta à última mensagem do cliente', next: 'Responder o cliente' };
    }
    if (f.closed || disposedAt) return null;
    const next = stamp(f.nextActionAt);
    if (next && next > now) return null;
    const lastAction = Math.max(stamp(f.lastMcsAt), stamp(f.lastActionAt));
    const base = lastAction || stamp(f.createdAt) || stamp(f.firstCustomerAt);
    if (!base || now - base < STALE_DAYS * DAY) return null;
    return {
      since: new Date(base).toISOString(), waitedMs: now - base, waitedText: waited(now - base), reason: 'NO_ACTION',
      missing: next ? `A próxima ação venceu${f.nextActionText ? ': ' + f.nextActionText : ''}` : lastAction ? 'Nenhuma ação registrada desde o último contato da MCS' : 'Nenhuma ação registrada desde a entrada',
      next: next ? 'Fazer a próxima ação vencida ou marcar outra data' : 'Retomar o contato ou marcar a próxima ação'
    };
  }

  function classify(facts, now = Date.now()) {
    const f = facts || {};
    const origin = originOf(f);
    const unattended = unattendedOf(f, now);
    const key = f.offTopic ? 'FORA_DO_ASSUNTO' : unattended ? 'NAO_ATENDIDO' : origin;
    return { key, label: GROUPS[key].label, origin, originLabel: GROUPS[origin].label, unattended: f.offTopic ? null : unattended, offTopic: Boolean(f.offTopic), offTopicSource: f.offTopic ? f.offTopicSource || null : null };
  }

  // The facts above from what the screens already read: the person's real messages (automatic ones
  // never count), the calculator orders linked to them (newest simulation first), the ficha and its
  // disposition. Used by the server; the browser only reads the resulting group.
  const messageAt = (message) => stamp(message && (message.occurred_at_utc || message.occurred_at_local || message.created_at));
  function factsFor({ messages = [], orders = [], journey = null, disposition = null, dispositionAt = null, offTopic = null } = {}) {
    const real = (messages || []).filter((message) => message && !message.undone_at && !message.is_automatic && ['CUSTOMER', 'MCS'].includes(message.direction))
      .slice().sort((a, b) => messageAt(a) - messageAt(b));
    const customer = real.filter((message) => message.direction === 'CUSTOMER');
    const mcs = real.filter((message) => message.direction === 'MCS');
    const firstCustomer = customer[0] || null, lastCustomer = customer.at(-1) || null, last = real.at(-1) || null;
    const simulations = (orders || []).filter(Boolean).flatMap((order) => order.simulations && order.simulations.length ? order.simulations : [order])
      .slice().sort((a, b) => stamp(b.occurredAt) - stamp(a.occurredAt));
    const calcModes = [...new Set(simulations.map((item) => item.logicalMode).concat((orders || []).flatMap((order) => (order && order.logicalModes) || [])).filter((mode) => mode === 'CARRO' || mode === 'VALOR'))];
    const toggledOff = journey && (journey.enabled === false || journey.status === 'ENCERRADO');
    return {
      calcModes, calcMode: simulations.find((item) => item.logicalMode === 'CARRO' || item.logicalMode === 'VALOR')?.logicalMode || null,
      calcAt: simulations[0] ? simulations[0].occurredAt || null : null,
      source: journey ? journey.source || null : null,
      financing: Boolean(firstCustomer && isFinancing(firstCustomer.body_text)),
      firstCustomerAt: firstCustomer ? new Date(messageAt(firstCustomer)).toISOString() : null,
      lastCustomerAt: lastCustomer ? new Date(messageAt(lastCustomer)).toISOString() : null,
      lastMcsAt: mcs.length ? new Date(messageAt(mcs.at(-1))).toISOString() : null,
      lastActionAt: journey ? journey.last_effective_contact_at || null : null,
      nextActionAt: journey ? journey.next_action_at || null : null,
      nextActionText: journey ? journey.next_action_text || null : null,
      createdAt: journey ? journey.created_at || null : null,
      awaitingReply: Boolean(last && last.direction === 'CUSTOMER'),
      closed: Boolean(toggledOff),
      disposition: disposition || null, dispositionAt: dispositionAt || null,
      offTopic: Boolean(offTopic && offTopic.offTopic), offTopicSource: offTopic && offTopic.offTopic ? offTopic.source || null : null
    };
  }

  // The latest customer message, for the card of a contact without a calculator order.
  function latestCustomerMessage(messages) {
    const customer = (messages || []).filter((message) => message && !message.undone_at && !message.is_automatic && message.direction === 'CUSTOMER' && String(message.body_text || '').trim());
    const latest = customer.sort((a, b) => messageAt(b) - messageAt(a))[0];
    return latest ? { id: latest.id, text: String(latest.body_text).slice(0, 600), at: new Date(messageAt(latest)).toISOString() } : null;
  }

  // Splits a list into the ordered groups (empty groups included, so every label is stable).
  function split(items, groupOf = (item) => item && item.group) {
    const buckets = new Map(ORDER.map((key) => [key, []]));
    (items || []).forEach((item) => { const group = groupOf(item); const key = group && buckets.has(group.key) ? group.key : 'DIRETO'; buckets.get(key).push(item); });
    // Não atendidos: quem espera há mais tempo primeiro.
    buckets.get('NAO_ATENDIDO').sort((a, b) => ((groupOf(b)?.unattended?.waitedMs) || 0) - ((groupOf(a)?.unattended?.waitedMs) || 0));
    return ORDER.map((key) => ({ ...GROUPS[key], items: buckets.get(key) }));
  }

  return { GROUPS, ORDER, STALE_DAYS, FINANCING_RE, isFinancing, originOf, unattendedOf, classify, split, waited, factsFor, latestCustomerMessage };
}));

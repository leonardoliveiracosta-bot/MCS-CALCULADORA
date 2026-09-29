(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MCSOrigin = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Lote 4 (PEDIDOS fundido em CLIENTES): where a ficha came from and what the calculator asked.
  //  Origem: CALCULADORA when a calculator Ref belongs to the ficha, plus the ficha's own channel.
  //  Tipo:   BUSCA (calculator "busca", mode CARRO), SIMULACAO (mode VALOR), or SEM_CALCULADORA.
  //  Última atividade: the latest real message or calculator event, the same rule PEDIDOS used (B4).
  const stamp = (value) => { const parsed = Date.parse(value || ''); return Number.isFinite(parsed) ? parsed : 0; };

  function clientOrigin(journey, orders, lastRealMessageAt) {
    const own = Array.isArray(orders) ? orders.filter(Boolean) : [];
    const source = String(journey && journey.source || '').toUpperCase();
    const origins = [];
    if (own.length || source === 'CALCULATOR') origins.push('CALCULADORA');
    if (source === 'WHATSAPP_DIRECT') origins.push('WHATSAPP');
    if (source === 'SMS_DIRECT') origins.push('SMS');
    const modes = own.flatMap((order) => order.logicalModes || [order.logicalMode]);
    const types = [...new Set(modes.map((mode) => mode === 'CARRO' ? 'BUSCA' : mode === 'VALOR' ? 'SIMULACAO' : null).filter(Boolean))];
    const latest = Math.max(stamp(lastRealMessageAt), ...own.map((order) => stamp(order.occurredAt)), 0);
    return {
      origins,
      calculatorTypes: own.length || source === 'CALCULATOR' ? types : ['SEM_CALCULADORA'],
      lastActivityAt: latest ? new Date(latest).toISOString() : null
    };
  }

  // The three CLIENTES filters. "all" keeps everything; days is 7, 30 or "all".
  function matchesClientFilters(item, filters, now = Date.now()) {
    const origin = filters && filters.origin || 'all', type = filters && filters.type || 'all', days = filters && filters.days || 'all';
    if (origin !== 'all' && !(item.origins || []).includes(origin)) return false;
    if (type !== 'all' && !(item.calculatorTypes || []).includes(type)) return false;
    if (days !== 'all') {
      const at = stamp(item.lastActivityAt);
      if (!at || now - at > Number(days) * 86400000) return false;
    }
    return true;
  }

  return { clientOrigin, matchesClientFilters };
}));

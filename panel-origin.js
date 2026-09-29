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

  // CLIENTES period: a number of days ("30", "90") or calendar months ("6m", "12m"); "all" has no cut.
  // Periods are cumulative: every ficha inside 30 days is also inside 90 days, 6 months and 1 year.
  function periodCutoff(period, now = Date.now()) {
    const value = String(period || 'all');
    if (value === 'all') return null;
    const months = value.match(/^(\d{1,2})m$/);
    if (months) { const date = new Date(now); date.setMonth(date.getMonth() - Number(months[1])); return date.getTime(); }
    const days = Number(value);
    return Number.isFinite(days) && days > 0 ? now - days * 86400000 : null;
  }
  const PERIOD_LABELS = { 30: 'nos últimos 30 dias', 90: 'nos últimos 90 dias', '6m': 'nos últimos 6 meses', '12m': 'no último ano', all: 'em qualquer data' };
  function periodLabel(period) { return PERIOD_LABELS[String(period || 'all')] || `nos últimos ${period} dias`; }
  function insidePeriod(item, period, now = Date.now()) {
    const cutoff = periodCutoff(period, now);
    if (cutoff === null) return true;
    const at = stamp(item && item.lastActivityAt);
    return Boolean(at) && at >= cutoff;
  }

  // The CLIENTES filters. "all" keeps everything; days is the period above.
  function matchesClientFilters(item, filters, now = Date.now()) {
    const origin = filters && filters.origin || 'all', type = filters && filters.type || 'all', days = filters && filters.days || 'all';
    if (origin !== 'all' && !(item.origins || []).includes(origin)) return false;
    if (type !== 'all' && !(item.calculatorTypes || []).includes(type)) return false;
    return insidePeriod(item, days, now);
  }

  return { clientOrigin, matchesClientFilters, periodCutoff, periodLabel, insidePeriod };
}));

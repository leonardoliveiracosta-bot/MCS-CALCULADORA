(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory(node ? require('../panel-sort') : root.MCSSort, node ? require('../panel-attention') : root.MCSAttention, node ? require('../panel-groups') : root.MCSGroups);
  if (node) module.exports = api;
  if (root) root.MCSCompleting = api;
}(typeof self !== 'undefined' ? self : this, function (sort, attention, groups) {
  'use strict';
  const DAY = 86400000;
  const timestamp = (value) => { const at = Date.parse(value || ''); return Number.isFinite(at) ? at : null; };

  // Presentation only: never changes a case's bucket, reasons or counters. An import date
  // can identify an undated message, but is never presented as its original sending time.
  function lastMessage(messages) {
    const real = (messages || []).filter((message) => message && !message.undone_at && !message.is_automatic && !message.is_edit_marker && !message.is_delete_marker && ['CUSTOMER', 'MCS'].includes(message.direction));
    real.sort((a, b) => (timestamp(a.occurred_at_utc) ?? timestamp(a.created_at) ?? 0) - (timestamp(b.occurred_at_utc) ?? timestamp(b.created_at) ?? 0) || Number(a.original_order || 0) - Number(b.original_order || 0) || String(a.id || '').localeCompare(String(b.id || '')));
    const last = real.at(-1);
    return last ? { at: timestamp(last.occurred_at_utc) !== null ? last.occurred_at_utc : null, direction: last.direction, channel: last.channel || null, source: last.source_kind || null } : null;
  }

  function wait(identity, now = Date.now()) {
    if (identity === 'loading' || identity === undefined) return { tone: '', main: 'Carregando conversa…', sub: '' };
    if (!identity) return { tone: '', main: 'Conversa indisponível', sub: '' };
    const last = identity.listMessage;
    if (!last) return { tone: '', main: 'Sem mensagem', sub: '' };
    const channel = last.channel === 'SMS' || /^SMS/.test(last.source || '') ? 'SMS' : last.channel === 'WHATSAPP' || /^WHATSAPP/.test(last.source || '') ? 'WhatsApp' : '';
    const at = timestamp(last.at), customer = last.direction === 'CUSTOMER';
    if (at === null) return { tone: '', main: customer ? 'Sem resposta' : 'Aguardando o cliente', sub: [channel, 'data original desconhecida'].filter(Boolean).join(' · ') };
    const ms = Math.max(0, now - at), elapsed = groups.waited(ms);
    return customer
      ? { tone: ms < DAY ? 'new' : ms <= 7 * DAY ? 'mid' : 'old', main: `${elapsed} · sem resposta`, sub: channel }
      : { tone: '', main: `Aguardando o cliente · há ${elapsed}`, sub: channel };
  }

  function orderItem(entry, identities) {
    if (entry.item) return entry.item;
    const identity = identities.get(entry.journeyId);
    const known = identity && identity !== 'loading' ? identity : {};
    const last = known.listMessage;
    return { id: entry.journeyId || entry.key, key: entry.key, sortAt: last?.at || null, awaitingReply: last?.direction === 'CUSTOMER', lastCustomerAt: last?.direction === 'CUSTOMER' ? last.at : null,
      reference_code: known.calcRef || '', refAt: known.refAt || null, contact: { display_name: known.name || '', location_text: known.location || '' } };
  }

  // Insert only the completar rows. The other rows keep their current relative order and
  // grouping; the selected server comparator decides where each incomplete lead belongs.
  function insert(order, completing, identities, mode = 'ready', now = Date.now()) {
    const result = order.slice();
    const itemOf = (row) => orderItem(row.entry, identities);
    const compare = (a, b) => {
      if (mode === 'ready') {
        const rank = (row) => !row.entry.item && row.entry.bucket !== 'completar' ? 1 : attention.rankOf(itemOf(row), now);
        const difference = rank(a) - rank(b);
        if (difference) return difference;
      }
      return sort.compare(mode, itemOf(a), itemOf(b));
    };
    completing.slice().sort((a, b) => compare(a, b) || a.entry.key.localeCompare(b.entry.key)).forEach((row) => {
      const index = result.findIndex((other) => compare(row, other) < 0);
      result.splice(index < 0 ? result.length : index, 0, row);
    });
    return result;
  }
  return { lastMessage, wait, orderItem, insert };
}));

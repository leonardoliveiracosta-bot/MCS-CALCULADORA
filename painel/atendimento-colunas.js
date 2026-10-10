(function (root, factory) {
  const node = typeof module === 'object' && module.exports;
  const api = factory();
  if (node) module.exports = api;
  if (root) root.MCSAttendColumns = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Ordenar a lista do Atendimento pelo cabeçalho (Espera, Canal, Ref, Telefone, Carro, Valor, Ano, Milha, Origem,
  // Estado). O valor de cada coluna sai dos mesmos dados que a linha mostra; vale no servidor (lista paginada inteira)
  // e no navegador (lista sem paginação). Campo vazio vai sempre para o fim; empate mantém a ordem que já estava.
  const KEYS = ['espera', 'canal', 'ref', 'telefone', 'carro', 'valor', 'ano', 'milha', 'origem', 'estado'];
  const DAY = 86400000;
  const CHANNELS = { WHATSAPP: 'WhatsApp', SMS: 'SMS' };
  const text = (value) => String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLocaleLowerCase('pt-BR');
  const time = (value) => { const at = Date.parse(value || ''); return Number.isFinite(at) ? at : null; };
  const firstNumber = (value) => { const found = /\d[\d.,]*/.exec(String(value || '')); if (!found) return null; const n = Number(found[0].replace(/\D/g, '')); return Number.isFinite(n) ? n : null; };
  const calcRefOf = (item) => typeof item?.hasCalcRef === 'boolean' ? (item.calcRef || null) : (item?.referenceCode || item?.reference_code || item?.ref || null);
  const primaryPhone = (item) => (item.phones || []).find((one) => one.is_primary) || (item.phones || []).find((one) => one.is_current !== false) || (item.phones || [])[0] || null;
  const phoneText = (phone) => typeof phone === 'string' ? phone : phone ? (phone.phone_e164 || phone.phone_raw || '') : '';

  // O que a calculadora pediu (o mesmo que as colunas Carro, Valor, Ano, Milha e Estado mostram).
  function request(item) {
    const facts = item.cardFacts || {}, per = facts.perMode || {};
    const modes = (facts.modes || []).filter((mode) => per[mode]);
    const out = { cars: [], cents: null, years: '', miles: '', zip: facts.zipText || '' };
    const car = (value) => { const one = String(value || '').replace(/\bnot sure\b/gi, '').replace(/\bother model\b/gi, 'Outro modelo').replace(/\s{2,}/g, ' ').trim(); if (one && !out.cars.includes(one)) out.cars.push(one); };
    if (modes.includes('VALOR')) { car(per.VALOR.vehicleText); out.cents = Number(per.VALOR.budgetCents) || null; }
    if (modes.includes('CARRO')) { car(per.CARRO.vehicleText); out.years = per.CARRO.yearsText || ''; out.miles = per.CARRO.mileageText || ''; }
    if (!modes.length) { car(facts.vehicleText || item.vehicleText); out.cents = Number(facts.budgetCents || item.budgetCents) || null; }
    return out;
  }
  // Espera e Canal: o tempo e o canal que a coluna Espera mostra (cliente sem resposta, ou o pedido a completar).
  function wait(entry, item, identity, now) {
    if (!item && entry.bucket === 'completar') {
      const last = identity && identity !== 'loading' ? identity.listMessage : null;
      if (!last) return { ms: null, channel: '' };
      const channel = last.channel === 'SMS' || /^SMS/.test(last.source || '') ? 'SMS' : last.channel === 'WHATSAPP' || /^WHATSAPP/.test(last.source || '') ? 'WhatsApp' : '';
      const at = time(last.at);
      return { ms: at === null ? null : Math.max(0, now - at), channel };
    }
    const kinds = new Set((entry.reasons || []).map((reason) => reason.kind));
    const unattended = item?.group?.unattended;
    const label = unattended && unattended.timeLabel;
    const noAction = unattended?.reason === 'NO_ACTION' && !kinds.has('RESPONDER');
    const shown = label && (kinds.has('NAO_ATENDIDO') || kinds.has('RESPONDER')) && (noAction || unattended.reason === 'NO_RESPONSE');
    const parts = shown ? /^(.+?) há (.+?) · (.+)$/.exec(label) : null;
    if (!parts) return { ms: null, channel: '' };
    const fromText = (value) => { const found = /^(\d+)\s*(min|h|dias?)\b/.exec(String(value || '').trim()); if (!found) return NaN; const n = Number(found[1]); return found[2] === 'min' ? n * 60000 : found[2] === 'h' ? n * 3600000 : n * DAY; };
    const since = time(unattended.since);
    const ms = [Number(unattended.waitedMs), since !== null ? now - since : NaN, fromText(parts[2])].find((value) => Number.isFinite(value) && value >= 0);
    return { ms: ms === undefined ? null : ms, channel: Object.values(CHANNELS).includes(parts[1].trim()) ? parts[1].trim() : '' };
  }
  function origin(item, from) {
    const facts = (item && item.cardFacts && item.cardFacts.modes) || [];
    const modes = facts.length ? facts : (item && item.logicalModes) || [item && item.group && item.group.calcMode].filter(Boolean);
    const names = [modes.includes('VALOR') && 'Calculate My Cost', modes.includes('CARRO') && 'Find One For Me'].filter(Boolean);
    if (names.length) return names.join(' · ');
    if (from && from.financing) return 'Financiamento';
    return (from ? from.group || String(from.key || '').split(':')[0] : '') === 'CALCULADORA' ? 'Site' : '';
  }
  // Estado escrito pela calculadora ("33101 — Miami, FL"); só com o número, o estado sai da faixa do ZIP.
  const ZIP3 = [[5, 5, 'NY'], [6, 9, 'PR'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'], [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'], [200, 205, 'DC'], [206, 219, 'MD'], [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'], [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'], [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'], [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'], [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'], [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'], [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'], [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'], [995, 999, 'AK']];
  function state(value) {
    const raw = String(value || '').trim();
    const written = /(?:^|[\s,·—-])([A-Z]{2})\s*$/.exec(raw.replace(/^\d{5}(?:-\d{4})?/, ''));
    if (written && !/^\d/.test(written[1])) return written[1];
    const zip = (/^(\d{5})/.exec(raw) || [])[1];
    if (!zip) return '';
    const prefix = Number(zip.slice(0, 3));
    const range = ZIP3.find(([from, to]) => prefix >= from && prefix <= to);
    return range ? range[2] : '';
  }
  // Valor de cada coluna para um caso; null quando a célula fica em branco.
  function values(entry, identity, now = Date.now()) {
    const item = entry.item || null;
    const known = identity && identity !== 'loading' ? identity : null;
    const from = item && item.group && item.group.origin || known?.origin || null;
    const fromSub = from ? from.sub || String(from.key || '').split(':')[1] || '' : '';
    const waited = wait(entry, item, identity, now);
    let phone = '', ref = '';
    if (item) { phone = phoneText(primaryPhone(item)); ref = calcRefOf(item) || ''; }
    else {
      phone = [...(entry.decisions || []), ...(entry.requests || [])].map((one) => one.phone || '').find(Boolean) || '';
      ref = known?.calcRef || '';
      if (entry.bucket === 'completar' && known) phone = phoneText(known.phones[0]) || phone;
    }
    const asked = item ? request(item) : { cars: [], cents: null, years: '', miles: '', zip: '' };
    const blank = (value) => value === '' || value === null || value === undefined ? null : value;
    const digits = String(phone || '').replace(/\D/g, '');
    return {
      espera: waited.ms,
      canal: blank(text(waited.channel || CHANNELS[fromSub] || '')),
      ref: /^[A-Z0-9]{5}$/.test(ref) ? ref : null,
      telefone: blank(digits),
      carro: blank(text(asked.cars.join(' · '))),
      valor: asked.cents,
      ano: firstNumber(asked.years),
      milha: firstNumber(asked.miles),
      origem: blank(text(origin(item, from))),
      estado: blank(state(asked.zip))
    };
  }
  const parse = (column) => { const found = typeof column === 'string' ? /^([a-z]+):(asc|desc)$/.exec(column) : null; return found && KEYS.includes(found[1]) ? { key: found[1], dir: found[2] } : null; };
  // Ordena as linhas ({ entry, data }) pela coluna "chave:asc" ou "chave:desc"; coluna inválida devolve a mesma ordem.
  function sortOrder(order, column, identityOf, now = Date.now()) {
    const chosen = parse(column);
    if (!chosen) return order;
    const sign = chosen.dir === 'desc' ? -1 : 1;
    const keyed = order.map((row, index) => ({ row, index, value: values(row.entry, row.entry.journeyId ? identityOf(row.entry.journeyId) : null, now)[chosen.key] }));
    keyed.sort((a, b) => {
      if (a.value === null) return b.value === null ? a.index - b.index : 1;
      if (b.value === null) return -1;
      const diff = typeof a.value === 'number' && typeof b.value === 'number' ? a.value - b.value : String(a.value).localeCompare(String(b.value), 'pt-BR', { numeric: true });
      return diff ? diff * sign : a.index - b.index;
    });
    return keyed.map((one) => one.row);
  }
  return { KEYS, parse, values, sortOrder, state };
}));

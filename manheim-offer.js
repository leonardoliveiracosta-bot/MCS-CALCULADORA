(function attachManheimOffer(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.MCSManheimOffer = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
  'use strict';

  // Seleção de opções Manheim para o cliente. Match interno não é opção: nada entra em V1/V2 sem
  // seleção do operador. Estas regras só ORDENAM e CLASSIFICAM carros já compatíveis; a
  // compatibilidade (ano, marca, modelo, milhagem, modo, MMR) continua sendo do matcher.
  // O banco repete as mesmas regras (migração 20261006010000) para paginar sem trazer o lote.
  const MAX_SELECTED = 10;
  const GROUPS = Object.freeze(['LANE', 'OFFLANE', 'INCOMPLETE']);
  const GROUP_LABELS = Object.freeze({
    LANE: 'Passa em Lane/Run',
    OFFLANE: 'Buy Now / Make Offer / fora de Lane-Run',
    INCOMPLETE: 'Informação incompleta'
  });
  // CR mínimo recomendado pelo MMR do carro (teto da faixa em centavos, inclusive).
  const CR_MINIMUMS = Object.freeze([[2000000, 2.0], [3000000, 2.5], [5000000, 3.0], [7000000, 3.5], [Infinity, 4.0]]);
  // Acréscimo padrão sobre o MMR (teto da faixa em centavos, inclusive).
  const MARKUPS = Object.freeze([[500000, 12.5], [1000000, 10], [1500000, 8], [2000000, 6], [3000000, 5], [4000000, 3.5], [6000000, 2.5], [10000000, 2], [Infinity, 1.5]]);
  const SALE_MARKER = /buy\s*-?\s*now|make\s*-?\s*(an\s+)?offer/i;

  const text = (value) => value === null || value === undefined ? '' : String(value).trim();
  const validMmr = (cents) => Number.isInteger(Number(cents)) && Number(cents) > 0;
  const band = (table, cents) => table.find(([ceiling]) => Number(cents) <= ceiling)[1];

  // CR do CSV (escala 0 a 5). Qualquer outra coisa não é CR verificável.
  function crOf(parsed) {
    const raw = text(parsed && parsed.conditionGrade);
    if (!/^\d(\.\d{1,2})?$/.test(raw)) return null;
    const value = Number(raw);
    return value >= 0 && value <= 5 ? value : null;
  }
  const crMinimum = (mmrCents) => validMmr(mmrCents) ? band(CR_MINIMUMS, mmrCents) : null;
  const defaultPct = (mmrCents) => validMmr(mmrCents) ? band(MARKUPS, mmrCents) : null;
  // Percentual digitado pelo operador: 0 a 50, até duas casas.
  function validPct(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(String(value).replace(',', '.'));
    return Number.isFinite(number) && number >= 0 && number <= 50 && Math.abs(Math.round(number * 100) - number * 100) < 1e-9 ? Math.round(number * 100) / 100 : NaN;
  }
  const finalCents = (mmrCents, pct) => validMmr(mmrCents) && Number.isFinite(pct) ? Math.round(Number(mmrCents) * (100 + pct) / 100) : null;
  function buyNowCents(parsed) {
    const raw = text(parsed && parsed.buyNowPrice).replace(/[$,\s]/g, '');
    return /^\d+(\.\d+)?$/.test(raw) && Number(raw) > 0 ? Math.round(Number(raw) * 100) : 0;
  }
  // Indicação de Buy Now / Make Offer no CSV (preço de Buy Now ou o texto da venda). Sozinha ela não
  // tira um carro de Lane/Run: só vale quando Lane ou Run não são verificáveis.
  const saleMarked = (parsed) => buyNowCents(parsed) > 0 || [parsed && parsed.saleType, parsed && parsed.eventSaleName, parsed && parsed.saleStatus].some((value) => SALE_MARKER.test(text(value)));
  // Os dados de venda do CSV foram lidos para este carro (Lane/Run presentes como campo, mesmo vazios).
  // Um lote importado antes disso não tem esses campos até ser complementado.
  const saleRead = (parsed) => Boolean(parsed) && ['lane', 'run'].some((key) => Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key] !== null && parsed[key] !== undefined);

  // LANE: Lane e Run verificáveis, mesmo com Buy Now Price maior que zero.
  // OFFLANE: Lane ou Run não verificável e o CSV indica Buy Now / Make Offer.
  // INCOMPLETE: o resto, inclusive carro sem os dados de venda lidos (nada é inventado).
  // CR não muda o grupo: só ordena (sem CR vai para o fim).
  function classify(parsed, mmrCents) {
    const cr = crOf(parsed);
    const minimum = crMinimum(mmrCents);
    const laneRun = Boolean(text(parsed && parsed.lane) && text(parsed && parsed.run));
    const missing = [];
    if (!laneRun) missing.push('Lane/Run');
    if (cr === null) missing.push('CR');
    const group = laneRun ? 'LANE' : buyNowCents(parsed) > 0 ? 'OFFLANE' : 'INCOMPLETE';
    return { group, cr, crMinimum: minimum, belowMinimum: cr !== null && minimum !== null ? cr < minimum : null, missing };
  }
  const priceFor = (mmrCents, manualPct) => {
    const base = defaultPct(mmrCents);
    const pct = manualPct === null || manualPct === undefined ? base : manualPct;
    return { defaultPct: base, pct, finalCents: finalCents(mmrCents, pct) };
  };

  const parsedOf = (row) => row?.vehicle_json?.parsed || row?.vehicle_json || row?.vehicle_snapshot || row || {};
  const vinOf = (row) => text(parsedOf(row).vin || row?.vin).toUpperCase();
  const saleActive = (sale, now = Date.now()) => !Number.isFinite(Date.parse(sale?.endsAt)) || Date.parse(sale.endsAt) > now;
  const SALE_FIELDS = ['lane','run','buyNowPrice','saleType','saleStatus','eventSaleName','startsAt','saleDate','endsAt','location'];
  const saleOption = (p) => Object.fromEntries(SALE_FIELDS.filter(k => p[k] !== undefined).map(k => [k,p[k]]));
  // Leilão passado (migrações 20261027010000 e 20261029020000, panel_manheim_offer_expired): endsAt
  // passado, ou carro com Lane/Run cujo horário de início (startsAt, senão saleDate) já chegou; só data,
  // sem hora: o dia começa à 0h da Flórida. Buy Now só pelo endsAt: a data de um Buy Now é o dia em que
  // entrou na lista. Sem data ou ilegível: não expira.
  const floridaDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  function offerExpired(sale, now = Date.now()) {
    const ends = Date.parse(text(sale?.endsAt));
    if (Number.isFinite(ends) && ends <= now) return true;
    if (!text(sale?.lane) || !text(sale?.run)) return false;
    const raw = text(sale.startsAt) || text(sale.saleDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw <= floridaDay(now);
    const starts = Date.parse(raw);
    return Number.isFinite(starts) && starts <= now;
  }
  // Carro agrupado (purchaseOptions): expirado só quando todas as vendas expiraram.
  const carExpired = (p, now = Date.now()) => { const sales = Array.isArray(p?.purchaseOptions) && p.purchaseOptions.length ? p.purchaseOptions : [p || {}]; return sales.every((sale) => offerExpired(sale, now)); };
  const purchaseOptions = (p, now = Date.now()) => (Array.isArray(p?.purchaseOptions) ? p.purchaseOptions : [saleOption(p || {})]).filter(s => saleActive(s, now));
  // One physical car per demand. Never merge unknown VINs; retain every source ID, including
  // expired sales, so an earlier human selection still belongs to the surviving car.
  function groupVehicles(rows, now = Date.now()) {
    const groups = new Map();
    (rows || []).forEach((row,index) => {
      const scope = row.demandKey || row.demand_key || [row.journey_id || row.calc_ref || '',row.logical_mode || ''].join(':');
      const key = scope + '|' + (vinOf(row) || row.id || row.row_fingerprint || 'unknown:' + index);
      if (!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(row);
    });
    return [...groups.values()].flatMap(members => {
      const live = members.filter(r => purchaseOptions(parsedOf(r),now).length);
      const rank = r => { const p=parsedOf(r);return text(p.lane)&&text(p.run)?0:buyNowCents(p)>0?1:2; };
      live.sort((a,b)=>rank(a)-rank(b)||text(a.id||a.row_fingerprint).localeCompare(text(b.id||b.row_fingerprint)));
      if (!live.length) return [];
      const primary=live[0], p=parsedOf(primary);
      const sales=[...new Map(live.flatMap(r=>purchaseOptions(parsedOf(r),now)).map(s=>[JSON.stringify(SALE_FIELDS.map(k=>s[k]||'')),s])).values()];
      const memberMatchIds=[...new Set(members.flatMap(r=>parsedOf(r).memberMatchIds || (r.id?[r.id]:[])))];
      const parsed={...p,purchaseOptions:sales,...(memberMatchIds.length?{memberMatchIds}:{})};
      return [primary.vehicle_json?.parsed?{...primary,vehicle_json:{...primary.vehicle_json,parsed}}:primary.vehicle_json?{...primary,vehicle_json:parsed}:primary.vehicle_snapshot?{...primary,vehicle_snapshot:parsed}:parsed];
    });
  }
  return { groupVehicles, parsedOf, vinOf, saleActive, offerExpired, carExpired, purchaseOptions, GROUPS, GROUP_LABELS, MAX_SELECTED, buyNowCents, classify, crMinimum, crOf, defaultPct, finalCents, priceFor, saleMarked, saleRead, validPct };
}));

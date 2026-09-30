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
    const group = laneRun ? 'LANE' : saleRead(parsed) && saleMarked(parsed) ? 'OFFLANE' : 'INCOMPLETE';
    return { group, cr, crMinimum: minimum, belowMinimum: cr !== null && minimum !== null ? cr < minimum : null, missing };
  }
  const priceFor = (mmrCents, manualPct) => {
    const base = defaultPct(mmrCents);
    const pct = manualPct === null || manualPct === undefined ? base : manualPct;
    return { defaultPct: base, pct, finalCents: finalCents(mmrCents, pct) };
  };

  return { GROUPS, GROUP_LABELS, MAX_SELECTED, buyNowCents, classify, crMinimum, crOf, defaultPct, finalCents, priceFor, saleMarked, saleRead, validPct };
}));

(function attachVehicleMatch(root, factory) {
  'use strict';
  const catalog = typeof MCSVehicleCatalog === 'object' ? MCSVehicleCatalog : (typeof require === 'function' ? require('./vehicle-catalog') : null);
  const api = factory(catalog);
  if (root) root.MCSVehicleMatch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, (catalog) => {
  'use strict';

  // Shared permanent rules for all request and option paths (v3.2).
  const RULE_VERSION = 'manheim-v3.4';
  const VALUE_THRESHOLD_CENTS = 6000000;
  const MODES = Object.freeze(['VALOR', 'CARRO']);
  const NOTICE = {
    NO_MMR: 'sem MMR para comparar',
    NO_ODOMETER: 'milhagem não informada no leilão'
  };
  const ISSUE_TEXT = {
    MODEL_MISSING: 'marca ou modelo não informado',
    YEAR_MISSING: 'ano mínimo ou máximo não informado',
    YEAR_INVERTED: 'ano mínimo maior que o máximo',
    MILES_MISSING: 'milhagem mínima ou máxima não informada',
    MILES_INVERTED: 'milhagem mínima maior que a máxima',
    BID_MISSING: 'lance não informado',
    MODE_UNKNOWN: 'tipo de busca indefinido'
  };

  function clean(value) {
    return String(value === null || value === undefined ? '' : value).normalize('NFC').trim();
  }

  function fold(value) {
    return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function integer(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim();
    if (!/\d/.test(text)) return null;
    const parsed = Number(text.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed) : null;
  }

  function positive(value) {
    const parsed = integer(value);
    return parsed !== null && parsed > 0 ? parsed : null;
  }

  // Valid MMR in cents: a finite positive number, or a plain money text ("21500", "$21,500",
  // "21500.00"). Anything else (null, "", 0, negative, "N/A", "desconhecido", "21k") is null.
  function validMmrCents(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    const text = clean(value);
    if (!/^\$?\s*\d[\d,]*(\.\d+)?$/.test(text)) return null;
    const number = Number(text.replace(/[$,\s]/g, ''));
    return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
  }
  const hasValidMmr = (vehicle) => validMmrCents(vehicle && vehicle.mmrCents) !== null;

  function normalizedMode(value) {
    const mode = clean(value).toUpperCase();
    return MODES.includes(mode) ? mode : null;
  }

  // MMR range for the bid, in cents. Integer math keeps the edges exact.
  function valueBand(bidCents) {
    const bid = positive(bidCents);
    if (!bid) return null;
    const [low, high] = bid <= VALUE_THRESHOLD_CENTS ? [70, 115] : [75, 110];
    return { bidCents: bid, low, high, minCents: Math.ceil(bid * low / 100), maxCents: Math.floor(bid * high / 100) };
  }

  function inBand(mmrCents, band) {
    return mmrCents * 100 >= band.bidCents * band.low && mmrCents * 100 <= band.bidCents * band.high;
  }

  // FIND with a budget has only a ceiling. Cheaper cars remain valid options; the
  // two-sided MMR band belongs exclusively to VALOR.
  function withinClientBudget(mmrCents, budgetCents) {
    const mmr = validMmrCents(mmrCents), budget = positive(budgetCents);
    if (!mmr || !budget) return false;
    const ceilingPercent = budget <= VALUE_THRESHOLD_CENTS ? 115 : 110;
    return mmr * 100 <= budget * ceilingPercent;
  }

  function usd(cents) {
    return 'US$ ' + Math.round(Number(cents) / 100).toLocaleString('en-US');
  }

  function searchableModel(wish) {
    const bad = /^(other brand|other model|outro modelo|outra marca|not sure|n[ãa]o tenho certeza|no estoy seguro)$/i;
    return Boolean(clean(wish && wish.model) && !bad.test(clean(wish.model)));
  }

  function sameVehicle(vehicle, wish) {
    if (!clean(wish && wish.model) || !clean(vehicle && vehicle.model)) return false;
    return catalog ? catalog.modelsMatch(vehicle.model, wish.model, vehicle.make, wish.make) : fold(vehicle.model) === fold(wish.model);
  }

  function carroWishIssue(wish) {
    if (!searchableModel(wish)) return 'MODEL_MISSING';
    const yearMin = positive(wish.yearMin), yearMax = positive(wish.yearMax);
    const minMiles = integer(wish.minMiles), maxMiles = integer(wish.maxMiles);
    if (!yearMin && !yearMax && minMiles === null && maxMiles === null) return 'YEAR_MISSING';
    if (yearMin && yearMax && yearMin > yearMax) return 'YEAR_INVERTED';
    if (minMiles !== null && maxMiles !== null && minMiles > maxMiles) return 'MILES_INVERTED';
    return null;
  }
  function mileageCap(bidCents) {
    const bid = positive(bidCents);
    return !bid ? null : bid <= 1000000 ? 135000 : bid <= 2000000 ? 115000 : bid <= 3000000 ? 105000 : 95000;
  }
  function conditionGrade(vehicle) {
    const raw = clean(vehicle && vehicle.conditionGrade);
    if (!/^\d(?:\.\d+)?$/.test(raw)) return null;
    const n = Number(raw); return n >= 0 && n <= 5 ? n : null;
  }
  function buyNowCents(vehicle) {
    const raw = clean(vehicle && vehicle.buyNowPrice).replace(/[$,\s]/g, '');
    return /^\d+(?:\.\d+)?$/.test(raw) && Number(raw) > 0 ? Math.round(Number(raw) * 100) : 0;
  }
  function saleEligible(vehicle) {
    return Boolean(clean(vehicle && vehicle.lane) && clean(vehicle && vehicle.run)) || buyNowCents(vehicle) > 0;
  }
  function qualityEligible(vehicle, criteria = {}) {
    if (!saleEligible(vehicle)) return false;
    if (criteria.acceptAnyTitleCondition === true) return true;
    const grade = conditionGrade(vehicle);
    if (grade !== null && grade < 1.9) return false;
    if (vehicle.cleanTitle === false) return false;
    return !/salvage|rebuilt|\btmu\b|lemon|not actual|junk|parts only/i.test([vehicle.title, vehicle.titleStatus, vehicle.titleBrand, vehicle.odometerStatus].filter(Boolean).join(' '));
  }
  // Limits of a CARRO request. The search is a little wider than asked, so the person also sees
  // cars close to the request: years one each side, miles floor(min×0.85) and ceil(max×1.15). Only
  // a limit the person set is widened; none is created. strict: the limits exactly as asked.
  function carroLimits(wish, strict = false) {
    const yearMin = positive(wish.yearMin), yearMax = positive(wish.yearMax), minMiles = integer(wish.minMiles), maxMiles = integer(wish.maxMiles);
    if (strict) return { yearMin, yearMax, minMiles, maxMiles };
    return { yearMin: yearMin ? yearMin - 1 : null, yearMax: yearMax ? yearMax + 1 : null,
      minMiles: minMiles === null ? null : Math.floor(minMiles * 85 / 100), maxMiles: maxMiles === null ? null : Math.ceil(maxMiles * 115 / 100) };
  }
  function rangesFit(vehicle, wish, mode, bidCents, strict = false) {
    const year = positive(vehicle.year), miles = integer(vehicle.miles);
    const limits = mode === 'CARRO' ? carroLimits(wish, strict) : { minMiles: integer(wish.minMiles) };
    if (mode === 'CARRO') {
      if (!year || year < (limits.yearMin || 1) || year > (limits.yearMax || new Date().getUTCFullYear() + 1)) return false;
    }
    const min = limits.minMiles;
    const max = mode === 'VALOR' ? Math.min(mileageCap(bidCents), integer(wish.maxMiles) ?? Infinity) : limits.maxMiles;
    if ((min !== null || max !== null) && (miles === null || miles < 0)) return false;
    return (min === null || miles >= min) && (max === null || miles <= max);
  }
  function characteristicsFit(vehicle, wish, mode, bidCents) {
    return sameVehicle(vehicle, wish) && rangesFit(vehicle, wish, mode, bidCents);
  }
  // Inside the limits exactly as asked (only orders the list: the closest cars come first).
  function withinAsked(vehicle, wish) {
    return rangesFit(vehicle, wish, 'CARRO', null, true);
  }
  function wishBudgetCents(wish, bidCents) { return wish.budgetExplicit ? (positive(wish.budgetUsd) || 0) * 100 : positive(wish.budgetUsd) ? positive(wish.budgetUsd) * 100 : positive(bidCents); }
  function valorWishIssue(wish, bidCents) {
    if (!searchableModel(wish)) return 'MODEL_MISSING';
    return valueBand(wishBudgetCents(wish,bidCents)) ? null : 'BID_MISSING';
  }

  function baseResult(vehicle, wish, index, mode) {
    return {
      mode,
      matchedWishlistIndex: index,
      matchedWishlistLabel: clean([wish.make, wish.model].filter(Boolean).join(' ')),
      makeNotice: clean(vehicle.makeNotice)
    };
  }

  // Fixed order: sale active, MMR, permanent exclusions with the title/CR exception, then the
  // request's criteria. "Aceita qualquer título/condição" frees only title and CR.
  function matchCarroWish(vehicle, wish, index = 0, demand = {}) {
    if (carroWishIssue(wish) || !saleEligible(vehicle) || !hasValidMmr(vehicle) || !qualityEligible(vehicle, { ...demand, ...wish }) || !characteristicsFit(vehicle, wish, 'CARRO')) return null;
    const budget = wishBudgetCents(wish,demand.bidCents);
    const outside = budget && !withinClientBudget(vehicle.mmrCents, budget);
    if (outside && !demand.allowBudgetFallback) return null;
    const notices = [];
    if (outside) notices.push('acima do valor informado');
    if (budget && /(?:includ|inclu|com).*(?:frete|tax|shipping|transport|fee)|(?:frete|tax|shipping|transport|fee).*(?:includ|inclu)/i.test(clean(wish.notes || demand.notes))) notices.push('valor informado inclui frete/taxas');
    return { kind: 'BATE', reason: notices.join(' · ') || null, notice: notices.join(' · ') || null, gaps: [], dataGap: false, basis: outside ? 'CRITERIA_FALLBACK' : 'CRITERIA', budgetFallback: Boolean(outside), bidCents: budget, mmrStatus: null, ...baseResult(vehicle, wish, index, 'CARRO') };
  }
  function matchValorWish(vehicle, wish, bidCents, index = 0, demand = {}) {
    bidCents = wishBudgetCents(wish,bidCents);
    if (valorWishIssue(wish, bidCents) || !qualityEligible(vehicle, { ...demand, ...wish }) || !characteristicsFit(vehicle, wish, 'VALOR', bidCents)) return null;
    const band = valueBand(bidCents), mmrCents = validMmrCents(vehicle.mmrCents);
    if (!mmrCents || mmrCents < 175000 || !inBand(mmrCents, band)) return null;
    const notice = buyNowCents(vehicle) > band.bidCents ? 'Buy Now acima do lance' : null;
    return { kind: 'POR_VALOR', reason: `por valor: MMR ${usd(mmrCents)} na faixa do lance ${usd(band.bidCents)}`, notice, gaps: [], dataGap: false, basis: 'VALUE',
      budgetFallback: false, bidCents: band.bidCents, mmrStatus: mmrCents > band.bidCents ? 'MMR acima do teto' : 'MMR dentro do teto', ...baseResult(vehicle, wish, index, 'VALOR') };
  }
  function rank(result) {
    return result.kind === 'BATE' ? 0 : result.kind === 'POR_VALOR' ? 1 : result.dataGap ? 3 : 2;
  }

  function wishesOf(value) {
    return Array.isArray(value) ? value : value && Array.isArray(value.wishlists) ? value.wishlists : value ? [value] : [];
  }

  // Each wish keeps its own budget; FIND may relax that budget only after a full-lot comparison.
  function matchDemand(vehicle, demand) {
    const mode = normalizedMode(demand && demand.mode);
    if (!mode || !vehicle) return null;
    const results = wishesOf(demand.wishes).map((wish, index) => mode === 'CARRO' ? matchCarroWish(vehicle, wish || {}, index, demand) : matchValorWish(vehicle, wish || {}, demand.bidCents, index, demand)).filter(Boolean);
    return results.sort((left, right) => Number(left.budgetFallback) - Number(right.budgetFallback) || rank(left) - rank(right) || left.matchedWishlistIndex - right.matchedWishlistIndex)[0] || null;
  }

  // The fallback decision belongs to the complete lot, never to an individual block.
  function matchLot(vehicles, demand) {
    const selected = new Map();
    wishesOf(demand.wishes).forEach((wish,wishIndex) => {
      const single = { ...demand, wishes: [wish], allowBudgetFallback: false };
      let matches = vehicles.map((vehicle,index) => ({index,result:matchDemand(vehicle,single)})).filter((item) => item.result);
      if (!matches.length && demand.mode === 'CARRO') matches = vehicles.map((vehicle,index) => ({index,result:matchDemand(vehicle,{...single,allowBudgetFallback:true})})).filter((item) => item.result);
      matches.forEach((item) => { item.result.matchedWishlistIndex=wishIndex; const old=selected.get(item.index); if (!old || old.result.budgetFallback && !item.result.budgetFallback) selected.set(item.index,item); });
    });
    return [...selected.values()];
  }
  // Display label for the stored kind codes.
  function kindLabel(kind) {
    return kind === 'POR_VALOR' ? 'POR VALOR · ligar' : kind || '';
  }

  // BATE and POR_VALOR are real opportunities; QUASE never counts as serving a customer.
  function countsAsServed(kind) {
    return kind === 'BATE' || kind === 'POR_VALOR';
  }

  function modeLabel(mode) {
    return mode === 'VALOR' ? 'POR VALOR' : mode === 'CARRO' ? 'POR ANO E MILHAGEM' : 'TIPO INDEFINIDO';
  }

  // Display label for the stored mmr_status codes (the amount is the maximum bid, R2).
  function mmrStatusLabel(code) {
    return code === 'MMR acima do teto' ? 'MMR acima do lance' : code === 'MMR dentro do teto' ? 'MMR dentro do lance' : code || '';
  }

  return { carroLimits, withinAsked, withinClientBudget, wishBudgetCents, RULE_VERSION, mileageCap, conditionGrade, buyNowCents, saleEligible, qualityEligible, characteristicsFit, matchLot, ISSUE_TEXT, MODES, NOTICE, VALUE_THRESHOLD_CENTS, validMmrCents, hasValidMmr, carroWishIssue, countsAsServed, fold, integer, kindLabel, matchCarroWish, matchDemand, matchValorWish, mmrStatusLabel, modeLabel, normalizedMode, positive, sameVehicle, searchableModel, valorWishIssue, valueBand };
}));

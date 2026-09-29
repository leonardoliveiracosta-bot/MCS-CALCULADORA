(function attachVehicleMatch(root, factory) {
  'use strict';
  const catalog = typeof MCSVehicleCatalog === 'object' ? MCSVehicleCatalog : (typeof require === 'function' ? require('./vehicle-catalog') : null);
  const api = factory(catalog);
  if (root) root.MCSVehicleMatch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, (catalog) => {
  'use strict';

  // One rule per mode for every place that compares a car with what a customer wants (browser
  // CSV import, server revalidation, ficha offers, score, saved searches). The two modes never
  // share criteria:
  //  MMR is mandatory in both modes: a car without a valid MMR (empty, zero, negative, "N/A",
  //    "desconhecido" or any text that is not a number) is never an option, in any mode.
  //  VALOR (Calculate My Cost): make, model and the bid of the VALOR flow only. The car is an
  //    option when its MMR is inside the bid range: bid <= US$ 60.000: MMR between 70% and 115%;
  //    above: 75% to 110% (POR_VALOR). Year and mileage are never used.
  //  CARRO (Find One For Me): make, model, minimum and maximum year, minimum and maximum
  //    mileage, all given and in order. Every limit is inclusive, there is no tolerance, the
  //    odometer must be a number (BATE). The MMR must exist but its amount never includes or
  //    excludes a car, and bid or budget are never read. Trim is kept as information only.

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

  function usd(cents) {
    return 'US$ ' + Math.round(Number(cents) / 100).toLocaleString('en-US');
  }

  function searchableModel(wish) {
    const bad = /^(other brand|other model|outro modelo|outra marca|not sure|n[ãa]o tenho certeza|no estoy seguro)$/i;
    return Boolean(clean(wish && wish.make) && clean(wish && wish.model) && !bad.test(clean(wish.make)) && !bad.test(clean(wish.model)));
  }

  function sameVehicle(vehicle, wish) {
    if (!clean(wish && wish.model) || !clean(vehicle && vehicle.model)) return false;
    if (clean(vehicle.make) && clean(wish.make) && fold(vehicle.make) !== fold(wish.make)) return false;
    return catalog ? catalog.modelsMatch(vehicle.model, wish.model, vehicle.make, wish.make) : fold(vehicle.model) === fold(wish.model);
  }

  // CARRO: the four limits are required and must be in order. Nothing is swapped or invented.
  function carroWishIssue(wish) {
    if (!searchableModel(wish)) return 'MODEL_MISSING';
    const yearMin = positive(wish.yearMin), yearMax = positive(wish.yearMax);
    const minMiles = positive(wish.minMiles), maxMiles = positive(wish.maxMiles);
    if (!yearMin || !yearMax) return 'YEAR_MISSING';
    if (yearMin > yearMax) return 'YEAR_INVERTED';
    if (!minMiles || !maxMiles) return 'MILES_MISSING';
    if (minMiles > maxMiles) return 'MILES_INVERTED';
    return null;
  }

  function valorWishIssue(wish, bidCents) {
    if (!searchableModel(wish)) return 'MODEL_MISSING';
    return valueBand(bidCents) ? null : 'BID_MISSING';
  }

  function baseResult(vehicle, wish, index, mode) {
    return {
      mode,
      matchedWishlistIndex: index,
      matchedWishlistLabel: clean([wish.make, wish.model].filter(Boolean).join(' ')),
      makeNotice: clean(vehicle.makeNotice)
    };
  }

  function matchCarroWish(vehicle, wish, index = 0) {
    if (carroWishIssue(wish) || !sameVehicle(vehicle, wish)) return null;
    // MMR is required in CARRO too (its amount never decides the match).
    if (!hasValidMmr(vehicle)) return null;
    const year = positive(vehicle && vehicle.year);
    const miles = integer(vehicle && vehicle.miles);
    // An unknown odometer is never 0 and never a match in CARRO.
    if (!year || miles === null || miles < 0 || (vehicle.miles === '' || vehicle.miles === null || vehicle.miles === undefined)) return null;
    if (year < positive(wish.yearMin) || year > positive(wish.yearMax)) return null;
    if (miles < positive(wish.minMiles) || miles > positive(wish.maxMiles)) return null;
    return { kind: 'BATE', reason: null, notice: null, gaps: [], dataGap: false, basis: 'CRITERIA', mmrStatus: null, ...baseResult(vehicle, wish, index, 'CARRO') };
  }

  function matchValorWish(vehicle, wish, bidCents, index = 0) {
    if (valorWishIssue(wish, bidCents) || !sameVehicle(vehicle, wish)) return null;
    const band = valueBand(bidCents);
    const mmrCents = validMmrCents(vehicle && vehicle.mmrCents);
    const miles = integer(vehicle && vehicle.miles);
    const notes = [];
    // No valid MMR: never an option (it used to be QUASE "sem MMR").
    if (!mmrCents) return null;
    if (!inBand(mmrCents, band)) return null;
    // A POR VALOR car with an unknown odometer is still an opportunity; the gap is said out loud.
    if (miles === null || miles < 0) notes.push(NOTICE.NO_ODOMETER);
    return {
      kind: 'POR_VALOR', reason: `por valor: MMR ${usd(mmrCents)} na faixa do lance ${usd(band.bidCents)}`,
      notice: notes.join(' · ') || null, gaps: [], dataGap: false, basis: 'VALUE',
      mmrStatus: mmrCents > band.bidCents ? 'MMR acima do teto' : 'MMR dentro do teto',
      ...baseResult(vehicle, wish, index, 'VALOR')
    };
  }

  function rank(result) {
    return result.kind === 'BATE' ? 0 : result.kind === 'POR_VALOR' ? 1 : result.dataGap ? 3 : 2;
  }

  function wishesOf(value) {
    return Array.isArray(value) ? value.slice(0, 5) : value && Array.isArray(value.wishlists) ? value.wishlists.slice(0, 5) : value ? [value] : [];
  }

  // A demand is { mode: 'CARRO' | 'VALOR', wishes, bidCents }. CARRO ignores bidCents entirely.
  function matchDemand(vehicle, demand) {
    const mode = normalizedMode(demand && demand.mode);
    if (!mode || !vehicle) return null;
    const results = wishesOf(demand.wishes).map((wish, index) => mode === 'CARRO' ? matchCarroWish(vehicle, wish || {}, index) : matchValorWish(vehicle, wish || {}, demand.bidCents, index)).filter(Boolean);
    return results.sort((left, right) => rank(left) - rank(right) || left.matchedWishlistIndex - right.matchedWishlistIndex)[0] || null;
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

  return { ISSUE_TEXT, MODES, NOTICE, VALUE_THRESHOLD_CENTS, validMmrCents, hasValidMmr, carroWishIssue, countsAsServed, fold, integer, kindLabel, matchCarroWish, matchDemand, matchValorWish, mmrStatusLabel, modeLabel, normalizedMode, positive, sameVehicle, searchableModel, valorWishIssue, valueBand };
}));

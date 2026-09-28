(function attachVehicleMatch(root, factory) {
  'use strict';
  const catalog = typeof MCSVehicleCatalog === 'object' ? MCSVehicleCatalog : (typeof require === 'function' ? require('./vehicle-catalog') : null);
  const api = factory(catalog);
  if (root) root.MCSVehicleMatch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, (catalog) => {
  'use strict';

  // One rule for every place that compares a car with what a customer wants (browser CSV
  // import, server revalidation, ficha offers, score and saved searches).
  // R3: an unknown criterion is never "any".
  //  a) year and/or mileage the customer gave are used as given (BATE);
  //  b) a missing year/mileage is replaced by the MMR range of the bid (POR_VALOR):
  //     bid <= US$ 60.000: MMR between 70% and 115% of the bid; above: 75% to 110%;
  //  c) rule b with a car without MMR: QUASE "sem MMR para comparar";
  //  d) missing year/mileage and no bid: QUASE "precisa qualificar";
  //  e) unknown odometer is never 0: with a mileage limit it is QUASE;
  //  f) a QUASE caused by missing data (dataGap) never counts as "atende".

  const VALUE_THRESHOLD_CENTS = 6000000;
  const NOTICE = {
    NO_MMR: 'sem MMR para comparar',
    NEEDS_QUALIFY: 'precisa qualificar: ano/milhagem não informados',
    NO_ODOMETER: 'milhagem não informada no leilão'
  };

  function clean(value) {
    return String(value === null || value === undefined ? '' : value).normalize('NFC').trim();
  }

  function fold(value) {
    return clean(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
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

  function sameVehicle(vehicle, wish) {
    if (!clean(wish && wish.model) || !clean(vehicle && vehicle.model)) return false;
    if (clean(vehicle.make) && clean(wish.make) && fold(vehicle.make) !== fold(wish.make)) return false;
    return catalog ? catalog.modelsMatch(vehicle.model, wish.model, vehicle.make, wish.make) : fold(vehicle.model) === fold(wish.model);
  }

  function matchWish(vehicle, wish, bidCents, index = 0) {
    const year = positive(vehicle && vehicle.year);
    if (!year || !sameVehicle(vehicle, wish)) return null;
    const miles = integer(vehicle.miles);
    const mmrCents = positive(vehicle.mmrCents);
    const yearMin = positive(wish.yearMin);
    const yearMax = positive(wish.yearMax);
    const maxMiles = positive(wish.maxMiles);
    const failures = [];
    const gaps = [];
    let valueReason = null;
    if (yearMin && year < yearMin) failures.push({ kind: 'year', delta: yearMin - year, reason: `ano ${yearMin - year} abaixo` });
    if (yearMax && year > yearMax) failures.push({ kind: 'year', delta: year - yearMax, reason: `ano ${year - yearMax} acima` });
    if (maxMiles) {
      if (miles === null || miles < 0) gaps.push('NO_ODOMETER');
      else if (miles > maxMiles) failures.push({ kind: 'miles', delta: miles - maxMiles, reason: `milhas ${(miles - maxMiles).toLocaleString('pt-BR')} acima` });
    }
    const missingCriteria = !(yearMin || yearMax) || !maxMiles;
    let basis = 'CRITERIA';
    if (missingCriteria) {
      const band = valueBand(bidCents);
      if (band) {
        basis = 'VALUE';
        if (!mmrCents) gaps.push('NO_MMR');
        else if (inBand(mmrCents, band)) valueReason = `por valor: MMR ${usd(mmrCents)} na faixa do lance ${usd(band.bidCents)}`;
        else return null;
      } else {
        basis = 'QUALIFY';
        gaps.push('NEEDS_QUALIFY');
      }
    }
    if (failures.length > 1) return null;
    if (failures.length === 1) {
      const failure = failures[0];
      const tolerated = (failure.kind === 'year' && failure.delta <= 1) || (failure.kind === 'miles' && failure.delta <= maxMiles * 0.1);
      if (!tolerated) return null;
    }
    // BATE: the criteria the customer gave are met (no lance or MMR needed). POR_VALOR: year
    // and/or mileage were not given and the MMR is inside the bid range (the natural path of
    // the Simulação tab). QUASE: tolerance or missing data, always with a reason.
    const kind = failures.length === 0 && gaps.length === 0 ? (valueReason ? 'POR_VALOR' : 'BATE') : 'QUASE';
    const bid = positive(bidCents);
    // A POR VALOR car with an unknown odometer is still an opportunity, but the missing mileage is
    // said out loud (Anexo A, surpresa 7).
    const notes = gaps.map((gap) => NOTICE[gap]);
    if (kind === 'POR_VALOR' && (miles === null || miles < 0)) notes.push(NOTICE.NO_ODOMETER);
    return {
      kind,
      reason: failures[0] ? failures[0].reason : valueReason,
      notice: notes.join(' · ') || null,
      gaps,
      dataGap: gaps.length > 0,
      basis,
      mmrStatus: mmrCents && bid ? (mmrCents > bid ? 'MMR acima do teto' : 'MMR dentro do teto') : null,
      matchedWishlistIndex: index,
      matchedWishlistLabel: clean([wish.make, wish.model].filter(Boolean).join(' ')),
      makeNotice: clean(vehicle.makeNotice)
    };
  }

  function rank(result) {
    return result.kind === 'BATE' ? 0 : result.kind === 'POR_VALOR' ? 1 : result.dataGap ? 3 : 2;
  }

  // Display label for the stored kind codes.
  function kindLabel(kind) {
    return kind === 'POR_VALOR' ? 'POR VALOR · ligar' : kind || '';
  }

  // BATE and POR_VALOR are real opportunities; QUASE never counts as serving a customer.
  function countsAsServed(kind) {
    return kind === 'BATE' || kind === 'POR_VALOR';
  }

  function matchVehicle(vehicle, wishlist, bidCents) {
    const wishes = Array.isArray(wishlist) ? wishlist.slice(0, 5) : wishlist && Array.isArray(wishlist.wishlists) ? wishlist.wishlists.slice(0, 5) : [wishlist || {}];
    const results = wishes.map((wish, index) => matchWish(vehicle, wish || {}, bidCents, index)).filter(Boolean);
    return results.sort((left, right) => rank(left) - rank(right) || left.matchedWishlistIndex - right.matchedWishlistIndex)[0] || null;
  }

  // How a customer's wish can be searched: by the criteria given, by the MMR range of the bid,
  // or not at all until qualified. Used by "Quais buscas salvar".
  function wishSearchBasis(wish, bidCents) {
    const hasYear = Boolean(positive(wish && wish.yearMin) || positive(wish && wish.yearMax));
    const hasMiles = Boolean(positive(wish && wish.maxMiles));
    if (hasYear && hasMiles) return { basis: 'CRITERIA' };
    const band = valueBand(bidCents);
    if (band) return { basis: 'VALUE', band };
    return { basis: 'QUALIFY' };
  }

  // Display label for the stored mmr_status codes (the amount is the maximum bid, R2).
  function mmrStatusLabel(code) {
    return code === 'MMR acima do teto' ? 'MMR acima do lance' : code === 'MMR dentro do teto' ? 'MMR dentro do lance' : code || '';
  }

  return { NOTICE, VALUE_THRESHOLD_CENTS, countsAsServed, fold, integer, kindLabel, matchVehicle, matchWish, mmrStatusLabel, sameVehicle, valueBand, wishSearchBasis };
}));

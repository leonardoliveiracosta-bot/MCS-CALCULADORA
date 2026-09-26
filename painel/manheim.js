(function attachManheim(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.MCSManheim = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
  'use strict';

  const catalog = typeof MCSVehicleCatalog === 'object' ? MCSVehicleCatalog : (typeof require === 'function' ? require('../vehicle-catalog') : null);

  const HEADER_ALIASES = Object.freeze({
    vin: ['vin', 'vehicle identification number', 'vehicle id number'],
    year: ['year', 'yr', 'model year', 'ano'],
    make: ['make', 'manufacturer', 'marca'],
    model: ['model', 'modelo'],
    trim: ['trim', 'series', 'style', 'version', 'versao'],
    miles: ['odometer', 'odometer miles', 'odometer value', 'mileage', 'mileage value', 'miles', 'mi', 'milhas'],
    location: ['location', 'location name', 'vehicle location', 'pickup location', 'auction', 'auction location', 'sale location', 'local', 'leilao'],
    saleDate: ['sale date', 'auction date', 'date of sale', 'data da venda', 'data venda'],
    mmr: ['mmr', 'adjusted mmr', 'base mmr', 'manheim market report'],
    exteriorColor: ['exterior color', 'exterior colour'],
    interiorColor: ['interior color', 'interior colour'],
    buyNowPrice: ['buy now price', 'buy now'],
    conditionGrade: ['condition report grade', 'condition grade', 'cr grade']
  });

  function clean(value) {
    return String(value === null || value === undefined ? '' : value).normalize('NFC').trim();
  }

  function fold(value) {
    return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  function parseCsv(text) {
    const source = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quoted) {
        if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field === '') quoted = true;
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[index + 1] === '\n') index += 1;
        row.push(field); field = '';
        if (row.some((value) => clean(value))) rows.push(row);
        row = [];
      } else field += char;
    }
    row.push(field);
    if (row.some((value) => clean(value))) rows.push(row);
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map(clean);
    return {
      headers,
      rows: rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, clean(values[index])])))
    };
  }

  function mapHeaders(headers) {
    const available = new Map((Array.isArray(headers) ? headers : []).map((header) => [fold(header), header]));
    const fields = {};
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      const exact = aliases.map(fold).find((alias) => available.has(alias));
      if (exact) fields[field] = available.get(exact);
    }
    const missing = ['year', 'model', 'miles'].filter((field) => !fields[field]);
    return { fields, missing };
  }

  function number(value) {
    const parsed = Number(clean(value).replace(/[$,\s]/g, '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeRows(parsed, mapping) {
    return parsed.rows.map((raw, index) => {
      const fields = mapping.fields;
      const mmr = fields.mmr ? number(raw[fields.mmr]) : null;
      const model = clean(raw[fields.model]);
      const suppliedMake = fields.make ? clean(raw[fields.make]) : '';
      const inferred = !suppliedMake && catalog ? catalog.inferMake(model) : { make: '', ambiguous: false };
      const location = fields.location ? clean(raw[fields.location]) : '';
      return {
        rowNumber: index + 2,
        raw,
        headers: parsed.headers.slice(),
        vin: fields.vin ? clean(raw[fields.vin]).toUpperCase() : '',
        year: number(raw[fields.year]),
        make: suppliedMake || inferred.make,
        makeInferred: Boolean(!suppliedMake && inferred.make),
        makeNotice: !suppliedMake && !inferred.make ? 'marca não informada no arquivo' : '',
        model,
        trim: fields.trim ? clean(raw[fields.trim]) : '',
        miles: number(raw[fields.miles]),
        location,
        locationDisplay: catalog ? catalog.readableLocation(location) : location,
        saleDate: fields.saleDate ? clean(raw[fields.saleDate]) : '',
        mmrCents: mmr === null ? null : Math.round(mmr * 100),
        exteriorColor: fields.exteriorColor ? clean(raw[fields.exteriorColor]) : '',
        interiorColor: fields.interiorColor ? clean(raw[fields.interiorColor]) : '',
        buyNowPrice: fields.buyNowPrice ? clean(raw[fields.buyNowPrice]) : '',
        conditionGrade: fields.conditionGrade ? clean(raw[fields.conditionGrade]) : ''
      };
    }).filter((row) => row.year && row.model && row.miles !== null);
  }

  function fingerprint(vehicle) {
    const vin = clean(vehicle && vehicle.vin).toUpperCase().replace(/[^A-HJ-NPR-Z0-9]/g, '');
    if (vin) return 'vin:' + vin;
    const value = [vehicle.year, fold(vehicle.make), fold(vehicle.model), fold(vehicle.trim), vehicle.miles, fold(vehicle.location), clean(vehicle.saleDate)].join('|');
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0') + ':' + value.length;
  }

  function matchOne(vehicle, wish, budgetCents, index) {
    if (!clean(wish && wish.model) || !vehicle.year || !clean(vehicle.model)) return null;
    if (clean(vehicle.make) && clean(wish.make) && fold(vehicle.make) !== fold(wish.make)) return null;
    if (!(catalog ? catalog.modelsMatch(vehicle.model, wish.model, vehicle.make, wish.make) : fold(vehicle.model) === fold(wish.model))) return null;
    const failures = [];
    if (wish.yearMin && vehicle.year < Number(wish.yearMin)) failures.push({ kind: 'year', delta: Number(wish.yearMin) - vehicle.year, reason: `ano ${Number(wish.yearMin) - vehicle.year} abaixo` });
    if (wish.yearMax && vehicle.year > Number(wish.yearMax)) failures.push({ kind: 'year', delta: vehicle.year - Number(wish.yearMax), reason: `ano ${vehicle.year - Number(wish.yearMax)} acima` });
    if (wish.maxMiles && vehicle.miles > Number(wish.maxMiles)) failures.push({ kind: 'miles', delta: vehicle.miles - Number(wish.maxMiles), reason: `milhas ${(vehicle.miles - Number(wish.maxMiles)).toLocaleString('pt-BR')} acima` });
    const kind = failures.length === 0 ? 'BATE' : failures.length === 1 && ((failures[0].kind === 'year' && failures[0].delta <= 1) || (failures[0].kind === 'miles' && failures[0].delta <= Number(wish.maxMiles) * 0.1)) ? 'QUASE' : null;
    if (!kind) return null;
    return {
      kind, reason: failures[0] ? failures[0].reason : null,
      mmrStatus: vehicle.mmrCents && Number(budgetCents) > 0 ? (vehicle.mmrCents > Number(budgetCents) ? 'MMR acima do teto' : 'MMR dentro do teto') : null,
      matchedWishlistIndex: index,
      matchedWishlistLabel: clean([wish.make, wish.model].filter(Boolean).join(' ')),
      makeNotice: clean(vehicle.makeNotice)
    };
  }

  function matchVehicle(vehicle, wishlist, budgetCents) {
    const wishes = Array.isArray(wishlist) ? wishlist.slice(0, 5) : wishlist && Array.isArray(wishlist.wishlists) ? wishlist.wishlists.slice(0, 5) : [wishlist || {}];
    const results = wishes.map((wish, index) => matchOne(vehicle, wish, budgetCents, index)).filter(Boolean);
    return results.sort((left, right) => (left.kind === right.kind ? left.matchedWishlistIndex - right.matchedWishlistIndex : left.kind === 'BATE' ? -1 : 1))[0] || null;
  }

  function csvCell(value) {
    const text = String(value === null || value === undefined ? '' : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(headers, rows) {
    const columns = Array.isArray(headers) ? headers : [];
    const lines = [columns.map(csvCell).join(',')];
    for (const row of Array.isArray(rows) ? rows : []) lines.push(columns.map((header) => csvCell(row && row[header])).join(','));
    return '\uFEFF' + lines.join('\r\n');
  }

  return { HEADER_ALIASES, fingerprint, fold, mapHeaders, matchVehicle, normalizeRows, parseCsv, toCsv };
}));

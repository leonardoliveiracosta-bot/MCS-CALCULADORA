(function attachManheim(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.MCSManheim = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
  'use strict';

  const catalog = typeof MCSVehicleCatalog === 'object' ? MCSVehicleCatalog : (typeof require === 'function' ? require('../vehicle-catalog') : null);
  const vehicleMatch = typeof MCSVehicleMatch === 'object' ? MCSVehicleMatch : (typeof require === 'function' ? require('../vehicle-match') : null);

  const HEADER_ALIASES = Object.freeze({
    vin: ['vin', 'vehicle identification number', 'vehicle id number'],
    year: ['year', 'yr', 'model year', 'ano'],
    make: ['make', 'manufacturer', 'marca'],
    model: ['model', 'modelo'],
    trim: ['trim', 'series', 'style', 'version', 'versao'],
    miles: ['odometer', 'odometer miles', 'odometer value', 'mileage', 'mileage value', 'miles', 'mi', 'milhas'],
    location: ['location', 'location name', 'vehicle location', 'pickup location', 'auction', 'auction location', 'sale location', 'local', 'leilao'],
    saleDate: ['sale date', 'auction date', 'date of sale', 'data da venda', 'data venda', 'starts at', 'start at'],
    endsAt: ['ends at', 'end at'],
    mmr: ['mmr', 'adjusted mmr', 'base mmr', 'manheim market report'],
    exteriorColor: ['exterior color', 'exterior colour'],
    interiorColor: ['interior color', 'interior colour'],
    buyNowPrice: ['buy now price', 'buy now'],
    conditionGrade: ['condition report grade', 'condition grade', 'cr grade']
    ,drivetrain: ['drivetrain', 'drive train']
    ,transmission: ['transmission type', 'transmission']
    ,engine: ['engine type', 'engine']
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

  // Empty, "TMU", "Exempt" and other text without digits are unknown, never 0 (R3e).
  function number(value) {
    const text = clean(value);
    if (!/\d/.test(text)) return null;
    const parsed = Number(text.replace(/[$,\s]/g, '').replace(/[^0-9.-]/g, ''));
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
        startsAt: fields.saleDate ? clean(raw[fields.saleDate]) : '',
        endsAt: fields.endsAt ? clean(raw[fields.endsAt]) : '',
        mmrCents: mmr === null || mmr <= 0 ? null : Math.round(mmr * 100),
        exteriorColor: fields.exteriorColor ? clean(raw[fields.exteriorColor]) : '',
        interiorColor: fields.interiorColor ? clean(raw[fields.interiorColor]) : '',
        buyNowPrice: fields.buyNowPrice ? clean(raw[fields.buyNowPrice]) : '',
        conditionGrade: fields.conditionGrade ? clean(raw[fields.conditionGrade]) : ''
        ,drivetrain: fields.drivetrain ? clean(raw[fields.drivetrain]) : ''
        ,transmission: fields.transmission ? clean(raw[fields.transmission]) : ''
        ,engine: fields.engine ? clean(raw[fields.engine]) : ''
      };
    }).filter((row) => row.year && row.model).map((row) => (row.miles !== null && row.miles < 0 ? { ...row, miles: null } : row));
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

  // R3 lives in vehicle-match.js, the same module the server uses.
  function matchVehicle(vehicle, wishlist, budgetCents) {
    return vehicleMatch.matchVehicle(vehicle, wishlist, budgetCents);
  }

  function matchOrder(vehicle, order) {
    if (!order) return null;
    const wishlists = Array.isArray(order.wishlists) ? order.wishlists : order.wishlist ? [order.wishlist] : [];
    const result = vehicleMatch.matchVehicle(vehicle, wishlists, order.budgetCents);
    return result ? { ...result, logicalMode: order.logicalMode || null, ref: order.ref || null } : null;
  }

  function csvCell(value) {
    const raw = String(value === null || value === undefined ? '' : value);
    const text = /^[=+\-@\t\r]/.test(raw) && !/^[+-]?[\d\s().,-]+$/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function toCsv(headers, rows) {
    const columns = Array.isArray(headers) ? headers : [];
    const lines = [columns.map(csvCell).join(',')];
    for (const row of Array.isArray(rows) ? rows : []) lines.push(columns.map((header) => csvCell(row && row[header])).join(','));
    return '\uFEFF' + lines.join('\r\n');
  }

  function chooseAuctionRows(rows) {
    const byVin=new Map();
    for (const row of rows||[]) { const key=clean(row.vin)||fingerprint(row); const prior=byVin.get(key); if (!prior || (/simulcast/i.test(row.raw?.Inventory||'') && !/simulcast/i.test(prior.raw?.Inventory||''))) byVin.set(key,row); }
    return [...byVin.values()].map((row)=>({ ...row, hasBuyNow:Boolean((rows||[]).find((candidate)=>clean(candidate.vin)===clean(row.vin)&&clean(candidate.buyNowPrice))?.buyNowPrice) }));
  }
  return { HEADER_ALIASES, chooseAuctionRows, fingerprint, fold, mapHeaders, matchOrder, matchVehicle, normalizeRows, parseCsv, toCsv };
}));

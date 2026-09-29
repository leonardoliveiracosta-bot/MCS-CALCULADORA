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

  // Ambiguous rows (buscas-split, OpenAI). A row is ambiguous when a cell the parser needs has
  // text it cannot read with safety: a year that is not a plain model year, a missing model, or
  // a mileage/MMR with letters mixed with digits ("12k mi", "45,000 km", "$21.5k"). A cell with no
  // digit at all ("TMU", "Exempt", empty) is a known unknown, never ambiguous. Ambiguous rows never
  // enter the comparison as they are; they go to OpenAI (when on) and then back through this parser.
  const AI_FIELDS = ['year', 'make', 'model', 'trim', 'miles', 'mmr'];
  const maxModelYear = () => new Date().getFullYear() + 2;
  const plainYear = (text) => /^\s*\d{4}\s*$/.test(text) && Number(text) >= 1980 && Number(text) <= maxModelYear();
  const plainMiles = (text) => /^\s*\d[\d,.\s]*\s*(mi|miles)?\s*$/i.test(text);
  const plainMoney = (text) => /^\s*\$?\s*\d[\d,.\s]*\s*$/.test(text);

  function rowCells(raw, fields) {
    return Object.fromEntries(AI_FIELDS.map((field) => [field, fields[field] ? clean(raw[fields[field]]) : '']));
  }

  function rowAmbiguity(cells) {
    const found = [];
    if (!cells.year && !cells.model) return found;
    if (!plainYear(cells.year)) found.push('year');
    if (!cells.model) found.push('model');
    if (/\d/.test(cells.miles) && !plainMiles(cells.miles)) found.push('miles');
    if (/\d/.test(cells.mmr) && !plainMoney(cells.mmr)) found.push('mmr');
    return found;
  }

  // Splits a parsed CSV into rows the parser reads with safety and ambiguous rows.
  function classifyRows(parsed, mapping) {
    const ok = [], ambiguous = [];
    parsed.rows.forEach((raw, index) => {
      const cells = rowCells(raw, mapping.fields);
      const fields = rowAmbiguity(cells);
      if (fields.length) ambiguous.push({ rowNumber: index + 2, raw, headers: parsed.headers.slice(), cells, ambiguous: fields });
      else ok.push({ raw, rowNumber: index + 2 });
    });
    const vehicles = ok.flatMap((entry) => normalizeRows({ headers: parsed.headers, rows: [entry.raw] }, mapping).map((vehicle) => ({ ...vehicle, rowNumber: entry.rowNumber })));
    return { vehicles, ambiguous, ignored: ok.length - vehicles.length };
  }

  const digitsOnly = (value) => String(value || '').replace(/\D/g, '');
  // A number OpenAI returns must be written in the cell: its digits, or "12k" style thousands.
  // Only the whole number written in the cell counts ("103,500" is 103500, never 3500; "12k" is
  // 12000, never 12). Kilometers are never converted: they go to review.
  function supportedNumber(value, cell) {
    const text = String(cell || '');
    if (!Number.isInteger(value) || value < 0 || /\bkm\b|kilomet|quil[oô]met/i.test(text)) return false;
    const written = [];
    const pattern = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k\b)?/gi;
    let found;
    while ((found = pattern.exec(text))) {
      const number = Number(found[1].replace(/,/g, '') + (found[2] ? '.' + found[2] : ''));
      written.push(Math.round(found[3] ? number * 1000 : number));
    }
    return written.length === 1 && written[0] === value;
  }

  // Runs an OpenAI suggestion through the same parser. Returns the vehicle or the review reason.
  function applySuggestion(row, suggestion, mapping, modelId) {
    if (!suggestion || suggestion.confident !== true) return { review: 'OpenAI não teve certeza' };
    const text = fold(Object.values(row.cells).join(' '));
    for (const field of row.ambiguous) {
      const value = suggestion[field];
      if (value === null || value === undefined || value === '') return { review: `${field} não confirmado` };
      if (field === 'year' && !(Number.isInteger(value) && value >= 1980 && value <= maxModelYear() && digitsOnly(row.cells.year).includes(String(value)))) return { review: 'ano não confirmado' };
      if ((field === 'miles' || field === 'mmr') && !supportedNumber(value, row.cells[field])) return { review: `${field === 'miles' ? 'milhagem' : 'MMR'} não confirmado` };
      if (field === 'model' && !fold(value).split(' ').every((token) => token && text.includes(token))) return { review: 'modelo não confirmado' };
    }
    const fields = mapping.fields;
    const raw = { ...row.raw };
    const write = (field, value) => { if (fields[field] && value !== null && value !== undefined && value !== '') raw[fields[field]] = String(value); };
    row.ambiguous.forEach((field) => write(field, suggestion[field]));
    const cells = rowCells(raw, fields);
    if (rowAmbiguity(cells).length) return { review: 'continua ambígua depois da IA' };
    const vehicle = normalizeRows({ headers: row.headers, rows: [raw] }, mapping)[0];
    if (!vehicle) return { review: 'linha sem ano ou modelo' };
    const kept = Object.fromEntries(row.ambiguous.map((field) => [field, String(suggestion[field])]));
    return { vehicle: { ...vehicle, raw: row.raw, rowNumber: row.rowNumber, ai: { used: true, provider: 'openai', model: modelId || '', result: 'VALIDATED', fields: row.ambiguous.slice(), suggestion: kept } } };
  }

  // Header names OpenAI suggested for missing columns, accepted only when they exist in the file.
  function mapHeadersWith(headers, suggested) {
    const mapping = mapHeaders(headers);
    const known = new Set(headers);
    // A column already used by another field is never reused (odometer read from the MMR column).
    const used = new Set(Object.values(mapping.fields));
    Object.entries(suggested || {}).forEach(([field, header]) => {
      if (mapping.fields[field] || !header || !known.has(header) || used.has(header) || !Object.prototype.hasOwnProperty.call(HEADER_ALIASES, field)) return;
      mapping.fields[field] = header; used.add(header);
    });
    mapping.missing = ['year', 'model', 'miles'].filter((field) => !mapping.fields[field]);
    return mapping;
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

  // The rule per mode lives in vehicle-match.js, the same module the server uses. A demand is
  // { mode: 'CARRO' | 'VALOR', wishes, bidCents }; CARRO never looks at money.
  function matchDemand(vehicle, demand) {
    return vehicleMatch.matchDemand(vehicle, demand);
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
  return { AI_FIELDS, HEADER_ALIASES, applySuggestion, chooseAuctionRows, classifyRows, fingerprint, fold, mapHeaders, mapHeadersWith, matchDemand, normalizeRows, parseCsv, rowAmbiguity, supportedNumber, toCsv };
}));

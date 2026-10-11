'use strict';

// Read only the visitor's public listing. No inventory, prices, database or AI calls.
const dns = require('node:dns').promises;
const net = require('node:net');
const https = require('node:https');
const catalog = require('./vehicle-catalog');

function publicIPv4(ip) {
  if (net.isIP(ip) !== 4) return false;
  const [a, b] = ip.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)));
}
function listingURL(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('INVALID_URL');
  let url;
  try { url = new URL(value.trim()); } catch (_) { throw new Error('INVALID_URL'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      net.isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') ||
      /(^|\.)(localhost|local|internal|test|invalid)$/.test(host)) throw new Error('INVALID_URL');
  url.hash = '';
  return url;
}
async function readPublicPage(value, deps = {}) {
  let url = listingURL(value);
  const lookup = deps.lookup || dns.lookup;
  const request = deps.request || https.request;
  const deadline = Date.now() + 8000;
  for (let redirect = 0; redirect <= 3; redirect++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('LISTING_UNAVAILABLE');
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true, family: 4 }),
      new Promise((_, reject) => { const t = setTimeout(() => reject(new Error('LISTING_DNS_TIMEOUT')), remaining); t.unref?.(); })
    ]);
    if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address))) throw new Error('INVALID_URL');
    const pinned = addresses[0].address;
    const page = await new Promise((resolve, reject) => {
      let bytes = 0; const chunks = [];
      const req = request(url, {
        method: 'GET',
        headers: { 'user-agent': 'MyCarScout/1.0 (vehicle reference)', accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'identity' },
        // Validate AND pin DNS, including redirects, rather than resolve again during connection.
        lookup: (_host, options, cb) => options?.all ? cb(null, [{ address: pinned, family: 4 }]) : cb(null, pinned, 4)
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          res.resume(); return resolve({ location: res.headers.location });
        }
        if (res.statusCode !== 200 || !/^(text\/html|application\/xhtml\+xml)/i.test(res.headers['content-type'] || '')) {
          res.resume(); return reject(new Error('LISTING_HTTP_' + res.statusCode));
        }
        res.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024) req.destroy(new Error('LISTING_UNAVAILABLE'));
          else chunks.push(chunk);
        });
        res.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      const timer = setTimeout(() => req.destroy(new Error('LISTING_READ_TIMEOUT')), Math.max(1, deadline - Date.now()));
      req.on('close', () => clearTimeout(timer));
      req.on('error', reject); req.end();
    });
    if (page.html !== undefined) return page.html;
    if (!page.location) throw new Error('LISTING_UNAVAILABLE');
    url = listingURL(new URL(page.location, url).href);
  }
  throw new Error('LISTING_UNAVAILABLE');
}

const clean = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
const named = value => clean(typeof value === 'object' && value ? value.name : value);
function identity(text) {
  const words = clean(text);
  const candidates = [];
  for (const [make, models] of Object.entries(catalog.MODELS_BY_MAKE)) {
    const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = words.match(new RegExp('(?:^|\\s)' + escape(make) + '\\s+(.+)', 'i'));
    if (!match) continue;
    const model = models.slice().sort((a, b) => b.length - a.length).find(m => new RegExp('^' + escape(m) + '(?:\\s|$|[|,])', 'i').test(match[1]));
    if (model) candidates.push({ make, model });
  }
  if (candidates.length !== 1) return null;
  const year = words.match(/\b(19\d{2}|20\d{2})\b/g) || [];
  const years = [...new Set(year)].filter(y => Number(y) >= 1995 && Number(y) <= new Date().getFullYear() + 1);
  return { ...candidates[0], ...(years.length === 1 ? { year: Number(years[0]) } : {}) };
}
function parseListing(html) {
  const vehicles = [];
  let conflicting = false;
  function walk(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return;
    if (Array.isArray(node)) { node.forEach(n => walk(n, depth + 1)); return; }
    const types = [].concat(node['@type'] || []).map(t => String(t).replace(/^https?:\/\/schema\.org\//, ''));
    if (types.some(t => /^(Car|Vehicle|Product)$/.test(t))) {
      const make = named(node.brand) || named(node.manufacturer);
      const model = named(node.model) || named(node.vehicleModel);
      // Some manufacturers publish an internal model code (e.g. H2) and
      // put the actual model in the product name without repeating the brand.
      const fromName = identity(node.name) || (make ? identity(make + ' ' + named(node.name)) : null);
      const fromFields = make && model ? identity(make + ' ' + model) : null;
      // Conflicting structured fields/name cannot become a visitor's vehicle request.
      const id = fromFields || fromName;
      if (fromFields && fromName && (fromFields.make !== fromName.make || fromFields.model !== fromName.model)) conflicting = true;
      else if (id) {
        const rawYear = node.vehicleModelDate || node.modelDate;
        const matchYear = typeof rawYear === 'string' || typeof rawYear === 'number' ? String(rawYear).match(/^(19\d{2}|20\d{2})(?:$|-)/) : null;
        if (matchYear && fromName?.year && Number(matchYear[1]) !== fromName.year) { conflicting = true; return; }
        const year = matchYear ? Number(matchYear[1]) : fromName?.year;
        vehicles.push({ make: id.make, model: id.model,
          ...(year >= 1995 && year <= new Date().getFullYear() + 1 ? { year } : {}),
          ...(clean(node.vehicleConfiguration) ? { trim: clean(node.vehicleConfiguration).replace(new RegExp('^' + id.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s+', 'i'), '') } : {}) });
      }
    }
    // Read graphs/mainEntity; avoid related inventory or recommendation arrays.
    for (const key of ['@graph', 'mainEntity', 'item']) if (node[key]) walk(node[key], depth + 1);
  }
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(match[1])); } catch (_) {}
  }
  const unique = [...new Map(vehicles.map(v => [JSON.stringify(v), v])).values()];
  if (conflicting) return null;
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return null;
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const fromHeading = identity(heading);
  if (fromHeading) return fromHeading;
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return identity(title);
}
// JSON sources are public and tied to the exact VIN in the visitor's URL.
function listingVIN(url) {
  const values = [...url.searchParams].filter(([key]) => /^(vin|vinNumber|vehicleIdentificationNumber)$/i.test(key)).map(([, value]) => value.toUpperCase());
  if (!values.length) values.push(...(url.pathname.toUpperCase().match(/(?:^|[^A-Z0-9])([A-HJ-NPR-Z0-9]{17})(?=$|[^A-Z0-9])/g) || []).map(value => value.replace(/^[^A-Z0-9]/, '')));
  const vins = [...new Set(values.filter(v => /^[A-HJ-NPR-Z0-9]{17}$/.test(v)))];
  return vins.length === 1 ? vins[0] : null;
}
function parseVehicleRecord(record, vin, { decoder = false, dealer } = {}) {
  if (!record || String(record.VIN || record.vin).toUpperCase() !== vin) return null;
  if (decoder && record.ErrorCode !== '0') return null;
  if (dealer && String(record.dealerPA) !== dealer) return null;
  const id = identity(named(record.Make || record.make) + ' ' + named(record.Model || record.modelDesc));
  const year = Number(record.ModelYear || record.modelYear);
  if (!id || !Number.isInteger(year) || year < 1995 || year > new Date().getFullYear() + 1) return null;
  // VIN trim codes need not match the seller's named version (Standard vs Premiere).
  const trim = decoder ? '' : clean(record.dlrModelPkg);
  return { make: id.make, model: id.model, year, ...(trim ? { trim } : {}) };
}
async function responseText(response) {
  if (!response.ok) throw new Error('LISTING_SOURCE_' + response.status);
  let bytes = 0; const chunks = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('LISTING_SOURCE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function readListing(value, deps = {}) {
  const url = listingURL(value), vin = listingVIN(url);
  const request = deps.fetch || fetch;
  const deadline = Date.now() + 22000;
  const signal = limit => AbortSignal.timeout(Math.max(1, Math.min(limit, deadline - Date.now())));
  // Advertising attribution does not identify the car; keep listing/dealer IDs.
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|gad_)/i.test(key) || /^(gclid|gclsrc|gbraid|wbraid|fbclid)$/i.test(key)) url.searchParams.delete(key);
  }
  const dealer = [...url.searchParams].find(([key]) => /^PaCode$/i.test(key))?.[1];
  if (url.hostname === 'cpo.lincoln.com' && /^\/detail\/?$/i.test(url.pathname) && vin && /^\d{1,10}$/.test(dealer || '')) {
    try {
      // This is the same public vehicle endpoint used by Lincoln's detail page.
      const response = await request('https://cpo.lincoln.com/api/vehicles/' + dealer + '/' + vin, { signal: signal(6000), redirect: 'error', headers: { accept: 'application/json' } });
      const vehicle = parseVehicleRecord(JSON.parse(await responseText(response)), vin, { dealer });
      if (vehicle) return vehicle;
    } catch (_) { /* Other sources remain available if the listing endpoint fails. */ }
  }
  try {
    const vehicle = parseListing(await (deps.readPublicPage || readPublicPage)(url.href));
    if (vehicle) return vehicle;
  } catch (error) {
    if (error.message === 'INVALID_URL') throw error;
  }
  if (vin && Date.now() < deadline) {
    try {
      const response = await request('https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/' + vin + '?format=json', { signal: signal(6000), redirect: 'error', headers: { accept: 'application/json' } });
      const data = JSON.parse(await responseText(response));
      if (data.Results?.length === 1) {
        const vehicle = parseVehicleRecord(data.Results[0], vin, { decoder: true });
        if (vehicle) return vehicle;
      }
    } catch (_) { /* Never substitute a guessed vehicle when decoding fails. */ }
  }
  if (Date.now() >= deadline) throw new Error('LISTING_READ_TIMEOUT');
  const response = await request('https://r.jina.ai/' + url.href, {
    headers: { accept: 'text/plain', 'x-respond-with': 'html', 'x-respond-timing': 'html' },
    signal: signal(14000), redirect: 'error'
  });
  return parseListing(await responseText(response));
}
module.exports = { listingURL, publicIPv4, readPublicPage, parseListing, readListing, listingVIN, parseVehicleRecord };

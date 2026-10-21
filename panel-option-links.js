'use strict';

// Link de opções para o cliente (/o/<código>): os carros do lote ativo dentro dos critérios de um pedido, para a operadora
// mostrar ao cliente o que existe. Só o que pode sair da empresa: ano, marca, modelo, versão, milhas, somente os 6
// últimos caracteres do VIN, cores externa e interna, estado, o dia da venda e o valor para o cliente, o mesmo do ENVIAR OPÇÕES e da V1
// (MMR + %, ou o valor digitado, terminando em zero). Nunca o MMR, o Buy Now, o nome do leilão ou o VIN inteiro.
// A lista é a mesma da tela Opções do cliente (panel_manheim_offer_page: um carro por VIN, sem leilão já passado),
// lida na hora em que o cliente abre o link.
const crypto = require('node:crypto');
const { insert, rows, rpc } = require('./panel-server');
const { latestActiveUpload } = require('./panel-manheim-state');
const { clean, locationState } = require('./vitrine-domain');
const { clientCents } = require('./manheim-offer');

const KEY = /^(journey:[0-9a-f-]{36}|ref:[A-Z0-9]{5}):(VALOR|CARRO)$/;
const CODE = /^[A-Za-z0-9_-]{32,80}$/;
const GROUPS = ['LANE', 'OFFLANE', 'INCOMPLETE'];
const PAGE = 50;
const MAX_CARS = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

// Only the last 6 characters identify the car in the client list, without exposing the full VIN.
function vinLast6(value) {
  const vin = String(value || '').trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin.slice(-6) : null;
}
const isoOrNull = (value) => { const text = clean(value, 40); return ISO.test(text) && Number.isFinite(Date.parse(text)) ? text : null; };

// One car as the client sees it. Lane/Run: the auction day; Buy Now / Make Offer: available until (never the price).
function publicCar(row) {
  const parsed = (row && row.vehicle_json && row.vehicle_json.parsed) || {};
  const group = row && row.offer_group;
  const sale = group === 'OFFLANE'
    ? { kind: 'AVAILABLE_UNTIL', at: isoOrNull(parsed.endsAt) }
    : { kind: group === 'LANE' ? 'AUCTION' : 'SALE', at: isoOrNull(parsed.startsAt || parsed.saleDate) };
  const miles = Number(parsed.miles);
  // The client's value, in whole dollars, read now: the % or value changed in ENVIAR OPÇÕES shows on the next opening.
  const finalCents = Number(row && row.final_cents);
  const reference = Number.isSafeInteger(finalCents) && finalCents > 0 ? Math.round(clientCents(finalCents) / 100) : null;
  return {
    year: Number(parsed.year) || null, make: clean(parsed.make, 80), model: clean(parsed.model, 120), trim: clean(parsed.trim, 120),
    miles: Number.isFinite(miles) && miles >= 0 ? Math.round(miles) : null, vinLast6: vinLast6(parsed.vin),
    state: locationState(parsed.location) || null, colors: { exterior: clean(parsed.exteriorColor, 60) || null, interior: clean(parsed.interiorColor, 60) || null },
    sale: sale.at ? sale : { kind: sale.kind, at: null }, estimatedMarketReference: reference
  };
}

// Every car of the demand in the active batch (all groups, page by page), soonest sale first.
async function listCars(ctx, uploadId, key, call = rpc) {
  const seen = new Set(), cars = [];
  for (const group of GROUPS) {
    for (let offset = 0; offset < MAX_CARS; offset += PAGE) {
      const page = await call(ctx, 'panel_manheim_offer_page', { p_environment: ctx.environment, p_upload_id: uploadId, p_demand_key: key, p_group: group, p_offset: offset, p_limit: PAGE });
      (page || []).forEach((row) => { if (row && row.id && !seen.has(row.id) && cars.length < MAX_CARS) { seen.add(row.id); cars.push(publicCar(row)); } });
      if (!page || page.length < PAGE) break;
    }
  }
  const time = (car) => { const at = Date.parse(car.sale.at || ''); return Number.isFinite(at) ? at : Infinity; };
  return cars.sort((a, b) => time(a) - time(b));
}

// The link of one demand: always the same code for the same request (created on the first click).
async function linkFor(ctx, key, actorId, services = { rows, insert }) {
  if (!KEY.test(String(key || ''))) { const error = new Error('OPTION_LINK_KEY_INVALID'); error.code = 'OPTION_LINK_KEY_INVALID'; throw error; }
  const find = async () => (await services.rows(ctx, 'panel_option_links', { select: 'public_code', environment: 'eq.' + ctx.environment, demand_key: 'eq.' + key, limit: '1' }))[0];
  const known = await find();
  if (known) return known.public_code;
  const code = crypto.randomBytes(32).toString('base64url');
  try {
    await services.insert(ctx, 'panel_option_links', { environment: ctx.environment, demand_key: key, public_code: code, created_by: actorId || null }, false);
    return code;
  } catch (error) {
    // Two clicks at once: the other one created it.
    const again = await find();
    if (again) return again.public_code;
    throw error;
  }
}

// What /o/<code> shows. A closed or switched-off ficha shows that the search is closed (as the tracking page does).
async function publicView(ctx, code, services = { rows, rpc, latestActiveUpload, insert }) {
  if (!CODE.test(String(code || ''))) return null;
  const link = (await services.rows(ctx, 'panel_option_links', { select: 'id,demand_key', environment: 'eq.' + ctx.environment, public_code: 'eq.' + code, limit: '1' }))[0];
  if (!link) return null;
  // Each opening of the page is recorded for the panel ("aberto 2× · último ..."); a failure here never stops the page.
  if (services.insert && link.id) await services.insert(ctx, 'panel_option_link_events', { environment: ctx.environment, link_id: link.id, event_type: 'OPEN' }, false).catch(() => null);
  const journeyId = (link.demand_key.match(/^journey:([0-9a-f-]{36}):/) || [])[1] || null;
  if (journeyId) {
    const [journey] = await services.rows(ctx, 'journeys', { select: 'id,status', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' });
    const [toggle] = journey ? await services.rows(ctx, 'journey_toggle_states', { select: 'enabled', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, limit: '1' }) : [];
    if (!journey || journey.status === 'ENCERRADO' || (toggle && toggle.enabled === false)) return { closed: true, cars: [] };
  }
  const upload = await services.latestActiveUpload(ctx, 'id,uploaded_at');
  const cars = upload ? await listCars(ctx, upload.id, link.demand_key, services.rpc) : [];
  return { closed: false, cars, checkedAt: new Date().toISOString() };
}

// For the panel: whether the link of a request exists, how many times it was opened and the last time.
async function linkOpens(ctx, key, services = { rows }) {
  if (!KEY.test(String(key || ''))) return null;
  const link = (await services.rows(ctx, 'panel_option_links', { select: 'id,created_at', environment: 'eq.' + ctx.environment, demand_key: 'eq.' + key, limit: '1' }))[0];
  if (!link) return { exists: false, opens: 0, lastOpenAt: null };
  const events = await services.rows(ctx, 'panel_option_link_events', { select: 'created_at', environment: 'eq.' + ctx.environment, link_id: 'eq.' + link.id, order: 'created_at.desc', limit: '500' });
  return { exists: true, createdAt: link.created_at, opens: events.length, lastOpenAt: events[0] ? events[0].created_at : null };
}

module.exports = { CODE, KEY, linkFor, linkOpens, listCars, vinLast6, publicCar, publicView };

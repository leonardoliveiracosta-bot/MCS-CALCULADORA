'use strict';

const offer = require('./manheim-offer');
const { isUuid } = require('./panel-server');

// Same final-cents conversion as V1. Never apply markup to a value already adjusted.
const reference = (cents) => Number(cents) > 0 && Number.isFinite(Number(cents))
  ? Math.round(offer.clientCents(cents) / 100) : null;
const vinOf = (details) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(String(details.vin || '')) ? String(details.vin).toUpperCase() : null;

async function trackingPrices(ctx, journeyId, units, rows) {
  const prices = new Map();
  if (!units.length) return prices;
  // A car presented through V1 keeps exactly the reference already sent in that V1.
  const vitrineIds = [...new Set(units.map((u) => u.details_json?.v1_vitrine_id).filter(isUuid))];
  const sent = vitrineIds.length ? await rows(ctx, 'vitrine_cars', {
    select: 'vitrine_id,source_match_id,vehicle_snapshot', environment: 'eq.' + ctx.environment,
    vitrine_id: 'in.(' + vitrineIds.join(',') + ')'
  }) : [];
  for (const unit of units) {
    const d = unit.details_json || {};
    const car = sent.find((c) => c.vitrine_id === d.v1_vitrine_id && c.source_match_id === d.manheim_match_id);
    const value = Number(car?.vehicle_snapshot?.estimatedMarketReference);
    if (Number.isFinite(value) && value > 0) prices.set(unit.id, value);
  }
  const pending = units.filter((u) => !prices.has(u.id));
  if (!pending.length) return prices;
  const ids = [...new Set(pending.map((u) => u.details_json?.manheim_match_id).filter(isUuid))];
  const vins = [...new Set(pending.map((u) => vinOf(u.details_json || {})).filter(Boolean))];
  const filters = [ids.length ? 'id.in.(' + ids.join(',') + ')' : '', vins.length ? 'vin.in.(' + vins.join(',') + ')' : ''].filter(Boolean);
  // Only this customer's presented cars, in one read. No full-batch grouping per car.
  const matches = filters.length ? await rows(ctx, 'manheim_matches', {
    select: 'id,vin,logical_mode,vehicle_json', environment: 'eq.' + ctx.environment,
    journey_id: 'eq.' + journeyId, or: '(' + filters.join(',') + ')'
  }) : [];
  const matchIds = [...new Set(matches.map((m) => m.id))];
  const selections = matchIds.length ? await rows(ctx, 'manheim_option_selections', {
    select: 'match_id,final_cents', environment: 'eq.' + ctx.environment, match_id: 'in.(' + matchIds.join(',') + ')'
  }) : [];
  for (const unit of pending) {
    const d = unit.details_json || {}, vin = vinOf(d);
    const exact = matches.find((m) => m.id === d.manheim_match_id);
    if (isUuid(d.manheim_match_id) && !exact) { prices.set(unit.id, null); continue; }
    const candidates = exact ? [exact] : matches.filter((m) => vin && String(m.vin || '').toUpperCase() === vin && (!d.logical_mode || m.logical_mode === d.logical_mode));
    const saved = [...new Set(candidates.flatMap((m) => selections.filter((s) => s.match_id === m.id).map((s) => reference(s.final_cents))).filter((v) => v !== null))];
    // An unidentified source never borrows another car's price.
    if (saved.length > 1) { prices.set(unit.id, null); continue; }
    const mmr = d.mmrCents ?? d.mmr_cents;
    prices.set(unit.id, saved[0] ?? reference(offer.priceFor(mmr, null).finalCents));
  }
  return prices;
}

module.exports = { reference, trackingPrices };

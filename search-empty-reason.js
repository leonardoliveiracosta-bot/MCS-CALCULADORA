'use strict';

// Adendo, item 2: why a search found no car, in plain language. Only reads the active batch (the
// same cars and the same rules the comparison used); never changes a result, a criterion or a car.
// It walks the request from the broadest step to the narrowest and stops at the first one that
// leaves no car: the make, the model, the version, the years, the mileage and, last, the value band
// of the bid (only for a request with the official calculation).
const vehicleMatch = require('./vehicle-match');
const catalog = require('./vehicle-catalog');
const { makeKey } = require('./panel-manheim-batch');

const clean = (value) => value === null || value === undefined ? '' : String(value).trim();
const fold = (text) => vehicleMatch.fold ? vehicleMatch.fold(text) : String(text || '').toLowerCase();
const int = (value) => { const number = Number(String(value === null || value === undefined ? '' : value).replace(/[^0-9.]/g, '')); return Number.isFinite(number) && number > 0 ? Math.round(number) : null; };
const miles = (value) => Number(value).toLocaleString('en-US');
const range = (values) => { const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b); return list.length ? [list[0], list.at(-1)] : null; };

// One wish ({make, model, trim, yearMin, yearMax, minMiles, maxMiles}) against the cars of its make.
// Returns { step, text } where step grows as the wish gets closer to a car.
function wishReason(wish, cars, { official = false, target = null } = {}) {
  const make = clean(wish.make) || clean(catalog.inferMake(wish.model || '').make);
  const model = clean(wish.model);
  const name = [make, model].filter(Boolean).join(' ') || 'o carro pedido';
  if (!make) return { step: 0, code: 'NO_MAKE_KNOWN', text: 'Não deu para saber a marca do carro pedido · Confira o pedido' };
  const valid = (cars || []).filter((car) => car && vehicleMatch.hasValidMmr(car));
  const ofMake = valid.filter((car) => fold(car.make) === fold(make));
  if (!ofMake.length) return { step: 1, code: 'NO_MAKE', text: `O lote ativo não tem nenhum ${make} com valor de leilão` };
  const ofModel = model ? ofMake.filter((car) => catalog.modelsMatch(car.model, model, car.make, make)) : ofMake;
  if (!ofModel.length) return { step: 2, code: 'NO_MODEL', text: `O lote tem ${ofMake.length} ${make}, mas nenhum ${model}` };
  const trim = clean(wish.trim);
  const ofTrim = trim ? ofModel.filter((car) => (' ' + fold(car.trim || '') + ' ').includes(' ' + fold(trim) + ' ')) : ofModel;
  if (!ofTrim.length) return { step: 3, code: 'NO_TRIM', text: `Tem ${ofModel.length} ${name} no lote, mas nenhum na versão ${trim}` };
  const yearMin = int(wish.yearMin), yearMax = int(wish.yearMax);
  const inYears = ofTrim.filter((car) => { const year = int(car.year); if ((yearMin || yearMax) && !year) return false; return (!yearMin || year >= yearMin) && (!yearMax || year <= yearMax); });
  if (!inYears.length) {
    const years = range(ofTrim.map((car) => int(car.year)));
    return { step: 4, code: 'YEARS', text: `Tem ${ofTrim.length} ${name} no lote, mas nenhum de ${yearMin || '?'} a ${yearMax || '?'}${years ? ` (no lote: ${years[0]} a ${years[1]})` : ''}` };
  }
  const minMiles = int(wish.minMiles), maxMiles = int(wish.maxMiles);
  const odometer = (car) => car.miles === null || car.miles === undefined || car.miles === '' ? null : Number(car.miles);
  const inMiles = inYears.filter((car) => { const value = odometer(car); if ((minMiles || maxMiles) && !Number.isFinite(value)) return false; return (!minMiles || value >= minMiles) && (!maxMiles || value <= maxMiles); });
  if (!inMiles.length) {
    const lowest = range(inYears.map(odometer));
    return { step: 5, code: 'MILES', text: `Tem ${inYears.length} ${name} nos anos pedidos, mas nenhum ${maxMiles ? `com até ${miles(maxMiles)} milhas` : `com pelo menos ${miles(minMiles)} milhas`}${lowest ? ` (no lote: ${miles(lowest[0])} a ${miles(lowest[1])} milhas)` : ''}` };
  }
  if (official && target) {
    const bid = Number(target.bidCents) || 0;
    return { step: 6, code: 'VALUE', text: `Tem ${inMiles.length} ${name} nos anos e na milhagem, mas o valor de leilão (MMR) de todos fica fora da faixa do lance${bid ? ` de US$ ${Math.round(bid / 100).toLocaleString('en-US')}` : ''}` };
  }
  return { step: 6, code: 'OTHER', text: `Tem ${inMiles.length} ${name} que parecem servir · A comparação já pode ter ficado velha: rode a busca de novo` };
}

// The reason of a whole request: its closest wish wins (the step that got furthest).
function reasonFor(item, carsByMake) {
  const official = Boolean(item.targets && item.targets.length);
  const wishes = official ? item.targets.flatMap((target) => (target.wishes || []).map((wish) => ({ wish, target }))) : [{ wish: item.criteria || {}, target: null }];
  if (!wishes.length) return { code: 'NO_CRITERIA', text: 'O pedido não tem carro definido' };
  const reasons = wishes.map(({ wish, target }) => {
    const key = makeKey(clean(wish.make) || clean(catalog.inferMake(wish.model || '').make));
    return wishReason(wish, key ? carsByMake.get(key) || [] : [], { official, target });
  });
  const best = reasons.sort((a, b) => b.step - a.step)[0];
  return { code: best.code, text: best.text };
}

// Reads the cars of the active batch per make once (JSON only) and returns { key: reason }.
async function emptyReasons(ctx, items, uploadId, read) {
  const carsByMake = new Map();
  const keysOf = (item) => {
    const wishes = item.targets && item.targets.length ? item.targets.flatMap((target) => target.wishes || []) : [item.criteria || {}];
    return wishes.map((wish) => makeKey(clean(wish.make) || clean(catalog.inferMake(wish.model || '').make))).filter(Boolean);
  };
  const keys = [...new Set(items.flatMap(keysOf))].slice(0, 40);
  for (const key of keys) {
    const rows = await read(ctx, 'manheim_vehicles', { select: 'vehicle_json', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId, make_key: 'eq.' + key, undone_at: 'is.null', mmr_cents: 'not.is.null' });
    carsByMake.set(key, rows.map((row) => row.vehicle_json).filter(Boolean));
  }
  return Object.fromEntries(items.map((item) => [item.key, reasonFor(item, carsByMake)]));
}

module.exports = { wishReason, reasonFor, emptyReasons };

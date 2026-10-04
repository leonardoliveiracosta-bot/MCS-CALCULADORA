'use strict';
const match = require('./vehicle-match');
const catalog = require('./vehicle-catalog');
const requests = require('./vehicle-requests');
const reason = (code, text, step) => ({ code, text, step });
function wishReason(wish, cars, { target = null } = {}) {
  if (!catalog.recognized(wish.model, wish.make)) return reason('UNKNOWN_MODEL','modelo não reconhecido',0);
  const mode = target?.mode || requests.searchModeOf(wish);
  const bid = wish.budgetUsd ? wish.budgetUsd * 100 : target?.bidCents;
  const eligible = (cars || []).filter((car) => match.qualityEligible(car,wish) && match.characteristicsFit(car,wish,mode,bid));
  if (!eligible.length) return reason('NO_CAR','sem carro no lote',1);
  const withMmr = eligible.filter(match.hasValidMmr);
  if (!withMmr.length) return reason('NO_MMR','só carros sem MMR',2);
  if (mode === 'VALOR') return reason('VALUE','valor não alcança',3);
  return reason('NO_CAR','sem carro no lote',1);
}
function reasonFor(item, carsByMake) {
  const cars = [...carsByMake.values()].flat();
  const targets = item.targets?.length ? item.targets : requests.targetsOf(item.criteria);
  const reasons = targets.flatMap((target) => (target.wishes || []).map((wish) => wishReason(wish,cars,{target})));
  return reasons.sort((a,b) => b.step-a.step)[0] || reason('UNKNOWN_MODEL','modelo não reconhecido',0);
}
async function emptyReasons(ctx, items, uploadId, read) {
  const wishes = items.flatMap((item) => item.targets?.length ? item.targets.flatMap((t) => t.wishes || []) : [item.criteria || {}]);
  const makes = wishes.some((w) => !w.make) ? [] : [...new Set(wishes.flatMap((w) => catalog.inventoryMakes(w.make,w.model)))];
  const filter = makes.length ? { make_key:'in.('+makes.map((m) => '"'+m.replace(/"/g,'')+'"').join(',')+')' } : {};
  const rows = await read(ctx,'manheim_vehicles',{select:'vehicle_json',environment:'eq.'+ctx.environment,upload_id:'eq.'+uploadId,undone_at:'is.null',...filter});
  const cars = new Map([['all',rows.map((r) => r.vehicle_json).filter(Boolean)]]);
  return Object.fromEntries(items.map((item) => [item.key,reasonFor(item,cars)]));
}
module.exports = { wishReason, reasonFor, emptyReasons };

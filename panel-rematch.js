'use strict';

// Compara de novo, com os carros do lote ativo, só os pedidos (demandas) indicados, e grava o
// resultado em OPÇÕES (panel_manheim_rematch_demand). Usado pelo botão "comparar de novo" de uma
// demanda e quando um pedido novo chega à ficha (PESQUISAS → ficha → OPÇÕES). Lê os carros só das
// marcas do pedido; nada é enviado e nenhuma chamada paga é feita.
const { allRows, insert, rpc } = require('./panel-server');
const { latestActiveUpload } = require('./panel-manheim-state');
const { loadBuscasBase } = require('./panel-buscas');
const { demandContext } = require('./panel-buscas-view');
const batch = require('./panel-manheim-batch');
const vehicleMatch = require('./vehicle-match');

async function carsForMakes(ctx, uploadId, makes, cache, read) {
  const key = makes.slice().sort().join('|');
  if (cache.has(key)) return cache.get(key);
  const filter = makes.length ? { make_key: 'in.(' + makes.concat(['']).map((make) => '"' + make.replace(/"/g, '') + '"').join(',') + ')' } : {};
  // With the sale data in use (complement): a car that has Lane/Run or Buy Now only through it still matches.
  const cars = await read(ctx, 'manheim_vehicles_current', { select: 'id,row_fingerprint,vehicle_json,make_key,mmr_cents', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploadId, undone_at: 'is.null', ...filter });
  const entries = cars.map((car) => ({ fingerprint: car.row_fingerprint, makeKey: car.make_key || '', mmrCents: vehicleMatch.validMmrCents(car.mmr_cents !== null && car.mmr_cents !== undefined ? car.mmr_cents : car.vehicle_json && car.vehicle_json.mmrCents), vehicle: car.vehicle_json || {} }));
  cache.set(key, entries);
  return entries;
}

// keys: ['journey:<id>:CARRO', ...]. Returns one result per key: { key, status, matches, compared }.
// status: DONE | NOT_ACTIVE (o pedido ainda não tem o que a busca precisa) | NO_BATCH | SKIPPED_TIME.
async function rematchDemands(ctx, keys, options = {}) {
  const read = options.allRows || allRows;
  const call = options.rpc || rpc;
  const latest = await latestActiveUpload(ctx, 'id');
  if (!latest) return keys.map((key) => ({ key, status: 'NO_BATCH' }));
  const base = options.base || await loadBuscasBase(ctx, { allRows: read });
  const context = demandContext(base);
  const cache = new Map();
  const out = [];
  for (const key of keys) {
    if (out.length && options.deadlineAt && Date.now() >= options.deadlineAt) { out.push({ key, status: 'SKIPPED_TIME' }); continue; }
    const target = context.targetByKey.get(key);
    if (!target) { out.push({ key, status: 'NOT_ACTIVE' }); continue; }
    const [snapshot] = batch.snapshotTargets([target]);
    const makes = snapshot.wishes.some((wish) => !wish.make) ? [] : [...new Set(snapshot.wishes.flatMap((wish) => require('./vehicle-catalog').inventoryMakes(wish.make, wish.model)))];
    const entries = await carsForMakes(ctx, latest.id, makes, cache, read);
    const matches = batch.matchChunk(entries, [snapshot]);
    const result = await call(ctx, 'panel_manheim_rematch_demand', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: latest.id, p_demand_key: key, p_matches: matches });
    out.push({ key, status: 'DONE', matches: matches.length, compared: entries.length, result, criteriaHash: snapshot.criteriaHash, uploadId: latest.id });
  }
  // What was compared is recorded, so the same criterion is never compared again in this batch.
  const write = options.insert || insert;
  for (const done of out.filter((item) => item.status === 'DONE' && item.criteriaHash)) {
    await write(ctx, 'manheim_demand_syncs', { environment: ctx.environment, upload_id: done.uploadId, demand_key: done.key, criteria_hash: done.criteriaHash, matches: done.matches, synced_by: ctx.panel.id }, false)
      .catch((error) => { if (error?.status !== 409 && !/duplicate|23505|409/i.test(String(error && (error.code || error.message) || ''))) throw error; });
  }
  return out;
}

// Pedidos ativos cujo critério de hoje não foi comparado com o lote ativo: nem na importação (foto
// do lote) nem depois (manheim_demand_syncs). Inclui pedido que chegou à ficha depois do lote e
// critério alterado na ficha. Sem a tabela nova (migração não aplicada) nada é feito.
async function staleDemandKeys(ctx, options = {}) {
  const readAll = options.allRows || allRows;
  const latest = await latestActiveUpload(ctx, 'id,targets_json');
  if (!latest) return { uploadId: null, keys: [] };
  const base = options.base || await loadBuscasBase(ctx, { allRows: readAll });
  const known = new Set((Array.isArray(latest.targets_json) ? latest.targets_json : []).map((target) => target.key + '|' + target.criteriaHash));
  let synced;
  try { synced = await readAll(ctx, 'manheim_demand_syncs', { select: 'demand_key,criteria_hash', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id }); }
  catch (_) { return { uploadId: latest.id, keys: [], base, unavailable: true }; }
  synced.forEach((row) => known.add(row.demand_key + '|' + row.criteria_hash));
  const targets = batch.snapshotTargets(demandContext(base).targets);
  return { uploadId: latest.id, base, keys: targets.filter((target) => !known.has(target.key + '|' + target.criteriaHash)).map((target) => target.key) };
}

// Compara de novo, dentro do tempo dado, os pedidos que estão defasados em OPÇÕES.
async function syncStaleDemands(ctx, options = {}) {
  if (!ctx.panel || !ctx.panel.id) return { stale: 0, synced: 0, remaining: 0 };
  const found = await staleDemandKeys(ctx, options);
  if (!found.keys.length) return { stale: 0, synced: 0, remaining: 0, unavailable: Boolean(found.unavailable) };
  const done = await rematchDemands(ctx, found.keys, { ...options, base: found.base });
  const synced = done.filter((item) => item.status === 'DONE').length;
  return { stale: found.keys.length, synced, remaining: found.keys.length - synced, keys: done.filter((item) => item.status === 'DONE').map((item) => item.key) };
}

module.exports = { rematchDemands, staleDemandKeys, syncStaleDemands };

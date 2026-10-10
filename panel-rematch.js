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
const { offerExpired } = require('./manheim-offer');

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

// Os mesmos carros da lista de ENVIAR OPÇÕES: carro de leilão passado não vira combinação nova
// (migração 20261027010000). A combinação que já existe para o pedido fica (keep), para não desfazer uma
// seleção nem a origem de uma V1; a lista já a esconde quando não está selecionada.
function comparableEntries(entries, keep = new Set(), now = Date.now()) {
  return entries.filter((entry) => keep.has(entry.fingerprint) || !offerExpired(entry.vehicle || {}, now));
}

// "Próximo" (POR CARRO, ano ±1 ou milhas até +15%): uma passada que só ACRESCENTA esses carros ao lote ativo
// (panel_manheim_add_near_matches insere e nunca altera uma linha ativa). Registrada em manheim_near_syncs
// (tabela só desta regra), então cada pedido passa uma vez por lote e por critério.
async function addNearMatches(ctx, latestId, target, cache, read, call) {
  if (!target || target.mode !== 'CARRO') return { added: 0, compared: 0 };
  const [snapshot] = batch.snapshotTargets([target]);
  if (snapshot.reactivation) return { added: 0, compared: 0, snapshot };
  const makes = snapshot.wishes.some((wish) => !wish.make) ? [] : [...new Set(snapshot.wishes.flatMap((wish) => require('./vehicle-catalog').inventoryMakes(wish.make, wish.model)))];
  const entries = comparableEntries(await carsForMakes(ctx, latestId, makes, cache, read));
  const rows = batch.nearRows(entries, snapshot);
  const result = rows.length ? await call(ctx, 'panel_manheim_add_near_matches', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: latestId, p_demand_key: target.key, p_matches: rows }) : null;
  return { added: result && Number(result.added) || 0, compared: entries.length, snapshot };
}
async function markNear(ctx, write, uploadId, key, criteriaHash, added) {
  await write(ctx, 'manheim_near_syncs', { environment: ctx.environment, upload_id: uploadId, demand_key: key, criteria_hash: criteriaHash, added, synced_by: ctx.panel.id }, false)
    .catch((error) => { if (error?.status !== 409 && !/duplicate|23505|409/i.test(String(error && (error.code || error.message) || ''))) throw error; });
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
    const current = await read(ctx, 'manheim_matches', { select: 'row_fingerprint', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id, demand_key: 'eq.' + key, undone_at: 'is.null' });
    const entries = comparableEntries(await carsForMakes(ctx, latest.id, makes, cache, read), new Set(current.map((row) => row.row_fingerprint)));
    const matches = batch.matchChunk(entries, [snapshot]);
    const result = await call(ctx, 'panel_manheim_rematch_demand', { p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: latest.id, p_demand_key: key, p_matches: matches });
    // The comparison above keeps only exact cars; the "Próximo" ones come back right after (only added).
    const near = target.mode === 'CARRO' ? await addNearMatches(ctx, latest.id, target, cache, read, call).catch((error) => { console.error('[opcoes] proximos', key, String(error && (error.code || error.message) || error).slice(0, 200)); return null; }) : null;
    out.push({ key, status: 'DONE', matches: matches.length, compared: entries.length, result, criteriaHash: snapshot.criteriaHash, uploadId: latest.id, near: near ? near.added : undefined });
  }
  // What was compared is recorded, so the same criterion is never compared again in this batch.
  const write = options.insert || insert;
  for (const done of out.filter((item) => item.status === 'DONE' && item.criteriaHash)) {
    await write(ctx, 'manheim_demand_syncs', { environment: ctx.environment, upload_id: done.uploadId, demand_key: done.key, criteria_hash: done.criteriaHash, matches: done.matches, synced_by: ctx.panel.id }, false)
      .catch((error) => { if (error?.status !== 409 && !/duplicate|23505|409/i.test(String(error && (error.code || error.message) || ''))) throw error; });
    if (done.near !== undefined) await markNear(ctx, write, done.uploadId, done.key, done.criteriaHash, done.near);
  }
  return out;
}

// Pedidos POR CARRO do lote ativo que ainda não passaram pela regra "Próximo" com o critério de hoje.
async function nearPendingKeys(ctx, options = {}) {
  const readAll = options.allRows || allRows;
  const latest = await latestActiveUpload(ctx, 'id');
  if (!latest) return { uploadId: null, keys: [] };
  const base = options.base || await loadBuscasBase(ctx, { allRows: readAll });
  let synced;
  try { synced = await readAll(ctx, 'manheim_near_syncs', { select: 'demand_key,criteria_hash', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id }); }
  catch (_) { return { uploadId: latest.id, keys: [], base, unavailable: true }; }
  const done = new Set(synced.map((row) => row.demand_key + '|' + row.criteria_hash));
  const targets = demandContext(base).targets.filter((target) => target.mode === 'CARRO');
  const snapshots = batch.snapshotTargets(targets);
  const keys = snapshots.filter((snapshot) => !done.has(snapshot.key + '|' + snapshot.criteriaHash)).map((snapshot) => snapshot.key);
  return { uploadId: latest.id, base, keys, targets: new Map(targets.map((target) => [target.key, target])) };
}

// Acrescenta os "Próximo" dos pedidos pendentes, dentro do tempo dado. Nada é retirado.
async function syncNearDemands(ctx, options = {}) {
  if (!ctx.panel || !ctx.panel.id) return { pending: 0, synced: 0, remaining: 0 };
  const read = options.allRows || allRows;
  const call = options.rpc || rpc;
  const write = options.insert || insert;
  const found = await nearPendingKeys(ctx, options);
  if (!found.keys.length) return { pending: 0, synced: 0, remaining: 0, unavailable: Boolean(found.unavailable) };
  const cache = new Map();
  let synced = 0;
  let failed = 0;
  for (const key of found.keys) {
    if ((synced || failed) && options.deadlineAt && Date.now() >= options.deadlineAt) break;
    // One request that fails never stops the others: it stays pending for the next round.
    try {
      const outcome = await addNearMatches(ctx, found.uploadId, found.targets.get(key), cache, read, call);
      if (outcome.snapshot) await markNear(ctx, write, found.uploadId, key, outcome.snapshot.criteriaHash, outcome.added);
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error('[opcoes] proximos', key, String(error && (error.code || error.message) || error).slice(0, 200));
    }
  }
  return { pending: found.keys.length, synced, failed, remaining: found.keys.length - synced - failed };
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
  if (!found.keys.length) return withNear(ctx, { stale: 0, synced: 0, remaining: 0, unavailable: Boolean(found.unavailable) }, { ...options, base: found.base });
  const done = await rematchDemands(ctx, found.keys, { ...options, base: found.base });
  const synced = done.filter((item) => item.status === 'DONE').length;
  return withNear(ctx, { stale: found.keys.length, synced, remaining: found.keys.length - synced, keys: done.filter((item) => item.status === 'DONE').map((item) => item.key) }, { ...options, base: found.base });
}
// With time left (and nothing stale waiting), the "Próximo" pass runs; its count joins synced/remaining so the
// panel keeps calling until it is done. A failure there never hides the result above.
async function withNear(ctx, out, options) {
  if (out.remaining || (options.deadlineAt && Date.now() >= options.deadlineAt)) return out;
  const near = await syncNearDemands(ctx, options).catch((error) => {
    console.error('[opcoes] proximos', String(error && (error.code || error.message) || error).slice(0, 200));
    return null;
  });
  if (!near || !near.pending) return out;
  return { ...out, synced: out.synced + near.synced, remaining: out.remaining + near.remaining, near };
}

module.exports = { comparableEntries, nearPendingKeys, rematchDemands, staleDemandKeys, syncNearDemands, syncStaleDemands };

'use strict';

// Manheim em alto volume, lado do servidor. Uma importação lógica recebe todos os CSVs em blocos:
// o navegador só lê e deduplica os arquivos; o servidor compara cada bloco com a foto das
// demandas tirada no início do lote (sempre o mesmo critério para todos os blocos), grava carros e
// matches de forma idempotente e só ativa o lote quando todos os blocos chegaram.
const crypto = require('node:crypto');
const vehicleMatch = require('./vehicle-match');
const vehicleCatalog = require('./vehicle-catalog');
const { canonicalJson } = require('./painel/manheim-upload');

const CHUNK_VEHICLES = 500;
const COMPLEMENT_ITEMS = 1000;
const MAX_MILES_SORT = 2147483647;

const text = (value, max) => {
  if (value === null || value === undefined) return '';
  const cleaned = String(value).normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned.slice(0, max);
};
const integer = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
};
const upper = (value) => String(value || '').trim().toUpperCase();

// Chave de marca usada no inventário frio: a mesma dobra que o matcher usa para comparar marcas.
const makeKey = (make) => vehicleMatch.fold(make);

// Critério de uma demanda, reduzido ao que decide um match. Muda quando o critério muda.
function criteriaHash(target) {
  const wishes = (target && target.wishes || []).map((wish) => [vehicleMatch.fold(wish.make), vehicleMatch.fold(wish.model), wish.yearMin ?? null, wish.yearMax ?? null, wish.minMiles ?? null, wish.maxMiles ?? null, wish.budgetUsd ?? null, wish.budgetExplicit === true, wish.acceptAnyTitleCondition === true, wish.notes || '']);
  const body = JSON.stringify([vehicleMatch.RULE_VERSION, vehicleCatalog.aliasRevision(), target && target.mode, wishes, Number(target && target.bidCents) || null, Boolean(target && target.reactivation), target && target.acceptAnyTitleCondition === true]);
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 24);
}

// A foto das demandas guardada no lote: só o que o matcher precisa (nunca nome ou telefone).
function snapshotTargets(targets) {
  return (targets || []).filter((target) => target && ['CARRO', 'VALOR'].includes(target.mode)).map((target) => ({
    key: target.key, mode: target.mode, targetType: target.targetType === 'ORDER' ? 'ORDER' : 'JOURNEY',
    journeyId: target.journeyId || null, ref: target.ref ? upper(target.ref) : null,
    wishes: (target.wishes || []).map((wish) => ({ make: wish.make || '', model: wish.model || '', trim: wish.trim || '', yearMin: wish.yearMin ?? null, yearMax: wish.yearMax ?? null, minMiles: wish.minMiles ?? null, maxMiles: wish.maxMiles ?? null, budgetUsd: wish.budgetUsd ?? null, budgetExplicit: wish.budgetExplicit === true, acceptAnyTitleCondition: wish.acceptAnyTitleCondition === true, notes: wish.notes || '', requestId: wish.requestId || null })),
    bidCents: Number(target.bidCents) || null, acceptAnyTitleCondition: target.acceptAnyTitleCondition === true,
    reactivation: target.reactivation === true, criteriaHash: criteriaHash(target)
  }));
}
function targetsHash(targets) {
  return crypto.createHash('sha256').update(JSON.stringify((targets || []).map((target) => [target.key, target.criteriaHash]).sort())).digest('hex').slice(0, 32);
}

// Hash canônico do conteúdo: o mesmo que o navegador calcula para o manifesto do lote.
const contentHash = (value) => crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

// Carro vindo do navegador, já lido pelo parser do painel. Só campos conhecidos, com limite.
function sanitizeVehicle(source) {
  const item = source && typeof source === 'object' && !Array.isArray(source) ? source : null;
  const input = item && item.vehicle && typeof item.vehicle === 'object' && !Array.isArray(item.vehicle) ? item.vehicle : null;
  const fingerprint = text(item && item.fingerprint, 200);
  if (!input || fingerprint.length < 3) return null;
  const parsed = {
    vin: text(input.vin, 40), year: integer(input.year), make: text(input.make, 80), model: text(input.model, 120),
    trim: text(input.trim, 120), miles: integer(input.miles), location: text(input.location, 200), saleDate: text(input.saleDate, 100),
    startsAt: text(input.startsAt, 100) || text(input.saleDate, 100), endsAt: text(input.endsAt, 100),
    mmrCents: integer(input.mmrCents), exteriorColor: text(input.exteriorColor, 120), interiorColor: text(input.interiorColor, 120),
    drivetrain: text(input.drivetrain, 80), transmission: text(input.transmission, 80), engine: text(input.engine, 120),
    buyNowPrice: text(input.buyNowPrice, 120), conditionGrade: text(input.conditionGrade, 120), lot: text(input.lot, 40),
    makeNotice: text(input.makeNotice, 160), makeInferred: input.makeInferred === true,
    titleStatus: text(input.titleStatus, 120), odometerStatus: text(input.odometerStatus, 120), cleanTitle: typeof input.cleanTitle === 'boolean' ? input.cleanTitle : null, odometerOk: typeof input.odometerOk === 'boolean' ? input.odometerOk : null
  };
  // Dados de venda só quando o CSV foi lido com eles (um lote antigo não os tem; nada é inventado).
  [['lane', 20], ['run', 20], ['saleType', 80], ['saleStatus', 80], ['eventSaleName', 160]].forEach(([key, max]) => {
    if (input[key] !== undefined && input[key] !== null) parsed[key] = text(input[key], max);
  });
  // Odômetro desconhecido continua nulo (nunca vira 0 milhas).
  if (!parsed.year || !parsed.model || (parsed.miles !== null && parsed.miles < 0)) return null;
  if (parsed.makeInferred) {
    const inferred = vehicleCatalog.inferMake(parsed.model);
    parsed.make = inferred.make;
    parsed.makeNotice = inferred.make ? '' : 'marca não informada no arquivo';
  }
  parsed.locationDisplay = vehicleCatalog.readableLocation(parsed.location);
  const ai = input.ai && typeof input.ai === 'object' && !Array.isArray(input.ai) && input.ai.used === true ? input.ai : null;
  if (ai) parsed.ai = { used: true, provider: 'openai', model: text(ai.model, 80), result: ai.result === 'VALIDATED' ? 'VALIDATED' : 'REVIEW', fields: Array.isArray(ai.fields) ? ai.fields.map((field) => text(field, 20)).filter(Boolean).slice(0, 8) : [] };
  const mmrCents = vehicleMatch.validMmrCents(parsed.mmrCents);
  return { fingerprint, makeKey: makeKey(parsed.make), mmrCents, vehicle: parsed };
}

// One list per demand, the closest cars first: a CARRO car inside the limits as asked (0) before one
// only inside the widened limits (1). CARRO and VALOR never share a demand.
const closenessOf = (vehicle, target, result) => {
  const wish = (target.wishes || [])[result.matchedWishlistIndex];
  return target.mode === 'CARRO' && wish && !vehicleMatch.withinAsked(vehicle, wish) ? 1 : 0;
};
const sortRank = (kind, closeness = 0) => kind === 'BATE' ? (closeness ? 1 : 0) : kind === 'POR_VALOR' ? 1 : 2;
const sortMiles = (miles) => { const value = integer(miles); return value === null || value < 0 ? MAX_MILES_SORT : Math.min(value, MAX_MILES_SORT); };

// Índice das demandas pela marca de cada desejo. Carro sem marca é comparado com todas.
function indexTargets(targets) {
  const byMake = new Map();
  const all = [];
  (targets || []).forEach((target) => {
    all.push(target);
    const makes = new Set((target.wishes || []).flatMap((wish) => vehicleCatalog.inventoryMakes(wish.make, wish.model)));
    if ((target.wishes || []).some((wish) => !wish.make)) { if (!byMake.has('*')) byMake.set('*', []); byMake.get('*').push(target); }
    makes.forEach((make) => { if (!byMake.has(make)) byMake.set(make, []); byMake.get(make).push(target); });
  });
  return { byMake, all };
}

// Um carro contra uma demanda, pela mesma regra do navegador e da conferência.
function matchOne(vehicle, target) {
  const result = vehicleMatch.matchDemand(vehicle, { ...target, wishes: target.wishes || [] });
  // Uma ficha desligada ou parada só volta com um BATE.
  if (!result || (target.reactivation && result.kind !== 'BATE')) return null;
  return result;
}

function matchRow(entry, target, result) {
  const parsed = { ...entry.vehicle, criteriaHash: target.criteriaHash || criteriaHash(target), matchedWishlistIndex: result.matchedWishlistIndex, matchedWishlistLabel: result.matchedWishlistLabel,
    makeNotice: result.makeNotice || entry.vehicle.makeNotice || '', matchNotice: result.notice || '', matchBasis: result.basis, dataGap: result.dataGap === true, budgetFallback: result.budgetFallback === true, requestedBudgetCents: result.bidCents || null };
  return {
    targetType: target.targetType, journeyId: target.targetType === 'ORDER' ? null : target.journeyId, calcRef: target.targetType === 'ORDER' ? target.ref : null,
    mode: target.mode, kind: result.kind, reason: result.reason || result.notice || null, mmrStatus: result.mmrStatus || null,
    fingerprint: entry.fingerprint, vehicle: { parsed }, demandKey: target.key, sortRank: sortRank(result.kind, closenessOf(entry.vehicle, target, result)), sortMiles: sortMiles(entry.vehicle.miles),
    vin: upper(entry.vehicle.vin) || null, wishIndex: result.matchedWishlistIndex, mmrCents: entry.mmrCents, criteriaHash: target.criteriaHash || criteriaHash(target)
  };
}

// Matches de um bloco. MMR obrigatório: carro sem MMR válido nunca é comparado.
function matchChunk(entries, targets, index = indexTargets(targets), { staging = false } = {}) {
  const matches = [];
  for (const entry of entries) {
    if (!entry || !entry.mmrCents) continue;
    const candidates = entry.makeKey ? [...new Set([...(index.byMake.get(entry.makeKey) || []), ...(index.byMake.get('*') || [])])] : index.all;
    for (const target of candidates) {
      const result = matchOne(entry.vehicle, { ...target, allowBudgetFallback: true });
      if (result) matches.push(matchRow(entry, target, result));
    }
  }
  if (staging) return matches;
  const strict = new Set(matches.filter((row) => !row.vehicle.parsed.budgetFallback).map((row) => row.demandKey + ":" + row.wishIndex));
  return matches.filter((row) => !row.vehicle.parsed.budgetFallback || !strict.has(row.demandKey + ":" + row.wishIndex));
}

module.exports = { CHUNK_VEHICLES, COMPLEMENT_ITEMS, MAX_MILES_SORT, canonicalJson, contentHash, criteriaHash, indexTargets, makeKey, matchChunk, matchOne, matchRow, sanitizeVehicle, snapshotTargets, sortMiles, sortRank, targetsHash };

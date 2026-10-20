'use strict';

// Por que um carro do lote não aparece para um lead: o primeiro portão que barra, na ordem do painel
// (mesmas funções de vehicle-match e manheim-offer). Só leitura. Veio do assistente anterior.
const { allRows, rows, isUuid } = require('./panel-server');

const env = (ctx) => 'eq.' + ctx.environment;
const carName = (p = {}) => [p.year, p.make, p.model, p.trim].filter(Boolean).join(' ');

function diagnoseCriteria(vehicle, wishes, vm) {
  for (const wish of wishes || []) {
    if (!vm.sameVehicle(vehicle, wish)) continue;
    const year = vm.positive(vehicle.year), yearMin = vm.positive(wish.yearMin), yearMax = vm.positive(wish.yearMax);
    if (year && yearMin && year < yearMin) return `ano ${year} abaixo do pedido (${yearMin}-${yearMax || '?'})`;
    if (year && yearMax && year > yearMax) return `ano ${year} acima do pedido (${yearMin || '?'}-${yearMax})`;
    const miles = vm.integer(vehicle.miles), minMiles = vm.integer(wish.minMiles), maxMiles = vm.integer(wish.maxMiles);
    if (miles !== null && minMiles !== null && miles < minMiles) return `milhas ${miles} abaixo do pedido (mín ${minMiles})`;
    if (miles !== null && maxMiles !== null && miles > maxMiles) return `milhas ${miles} acima do pedido (máx ${maxMiles})`;
    return 'bate no modelo mas não nos critérios (ver ficha)';
  }
  return 'modelo não combina com o pedido';
}
function diagnoseExclusion(parsed, demands, acceptAny, vm, offer) {
  const vehicle = parsed || {};
  if (offer.carExpired(vehicle)) return 'leilão passado';
  if (!vm.hasValidMmr(vehicle)) return 'sem MMR para comparar';
  if (!vm.qualityEligible(vehicle, { acceptAnyTitleCondition: acceptAny })) {
    if (!vm.saleEligible(vehicle)) return 'sem Lane/Run (não está à venda)';
    const grade = vm.conditionGrade(vehicle);
    if (grade !== null && grade < 1.9) return 'CR abaixo de 1.9';
    return 'título bloqueia (salvage/rebuilt)';
  }
  if (vm.matchDemand(vehicle, demands.CARRO) || vm.matchDemand(vehicle, demands.VALOR)) return null;
  return diagnoseCriteria(vehicle, demands.CARRO.wishes, vm);
}

async function diagnoseOptions(ctx, journeyId, term) {
  if (!isUuid(journeyId)) return { erro: 'lead inválido' };
  const [journey] = await rows(ctx, 'journeys', { select: 'id,reference_code,budget_cents,criteria_json,updated_at', environment: env(ctx), id: 'eq.' + journeyId, limit: '1' });
  if (!journey) return { erro: 'ficha não encontrada' };
  const { latestActiveUpload } = require('./panel-manheim-state');
  const upload = await latestActiveUpload(ctx, 'id').catch(() => null);
  if (!upload) return { erro: 'sem lote ativo' };
  const criteria = journey.criteria_json || {};
  const wishlists = Array.isArray(criteria.wishlists) ? criteria.wishlists : [];
  if (!wishlists.length) return { erro: 'a ficha não tem carros nos critérios (a busca usa os pedidos da calculadora; veja ver_lead)' };
  const vm = require('./vehicle-match'), offer = require('./manheim-offer');
  const demands = { CARRO: { mode: 'CARRO', wishes: wishlists, bidCents: journey.budget_cents || null }, VALOR: { mode: 'VALOR', wishes: wishlists, bidCents: journey.budget_cents || null } };
  const filter = String(term || '').trim().toLowerCase();
  const matches = await allRows(ctx, 'manheim_matches', { select: 'id,mmr_cents,vehicle_json', environment: env(ctx), upload_id: 'eq.' + upload.id, undone_at: 'is.null' }).catch(() => []);
  let cars = matches.map((m) => ({ ...((m.vehicle_json && m.vehicle_json.parsed) || {}), mmrCents: ((m.vehicle_json && m.vehicle_json.parsed) || {}).mmrCents ?? m.mmr_cents ?? null }));
  if (filter) cars = cars.filter((p) => [p.year, p.make, p.model, p.trim, p.vin].filter(Boolean).join(' ').toLowerCase().includes(filter));
  const limited = cars.slice(0, 80);
  const byReason = new Map();
  for (const car of limited) {
    const reason = diagnoseExclusion(car, demands, criteria.acceptAnyTitleCondition === true, vm, offer);
    if (!reason) continue;
    if (!byReason.has(reason)) byReason.set(reason, { total: 0, exemplos: [] });
    const entry = byReason.get(reason);
    entry.total += 1;
    if (entry.exemplos.length < 3) entry.exemplos.push({ carro: carName(car), vin: car.vin || null });
  }
  return { lote: upload.id, carros_analisados: limited.length, ...(filter && !limited.length ? { aviso: 'nenhum carro do lote bate com o termo' } : {}), por_motivo: [...byReason.entries()].map(([motivo, v]) => ({ motivo, total: v.total, exemplos: v.exemplos })) };
}

module.exports = { diagnoseOptions, diagnoseExclusion };

'use strict';

// The same deterministic search identity is used by BUSCAS and Manheim saves.
const { allRows } = require('./panel-server');
const { buildSearchDemands, consolidateCalcRuns, toggleEnabled } = require('./panel-domain');
const { undoSupported } = require('./panel-manheim-state');
const vehicleMatch = require('./vehicle-match');
const catalog = require('./vehicle-catalog');

function searchableWish(wishes) {
  return (wishes || []).find((wish) => wish && String(wish.make || '').trim() && String(wish.model || '').trim()
    && !/^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.make || '').trim())
    && !/^(other brand|other model|outro modelo|outra marca)$/i.test(String(wish.model || '').trim())) || null;
}
function searchKey(wish) {
  if (!wish) return null;
  const make = catalog.fold(wish.make);
  const model = catalog.modelTokens(wish.model, wish.make).join(' ');
  return make && model ? `${make}|${model}` : null;
}
// The same identity as "Quais buscas salvar", per mode: CARRO (make|model, searched by year and
// mileage) and VALOR (make|model|valor, searched by the MMR range of the bid). The two modes of
// one person never share a key, so saving one never saves the other.
function searchIdentity(wish, mode) {
  const base = searchKey(wish);
  const normalized = vehicleMatch.normalizedMode(mode);
  if (!base || !normalized) return null;
  return { mode: normalized, basis: normalized === 'CARRO' ? 'CRITERIA' : 'VALUE', key: normalized === 'CARRO' ? base : base + '|valor' };
}
function stageLabel(stage, basis) { if (stage === 'MISSING' && basis === 'QUALIFY') return '❓ Precisa qualificar'; return ({ MISSING: '🔍 Falta buscar', SAVED: '💾 Busca salva', SENT: '📤 Opções enviadas' })[stage] || ''; }
function floridaDays(at, now = Date.now()) {
  const stamp = Date.parse(at || '');
  return Number.isFinite(stamp) ? Math.max(0, Math.floor((now - stamp) / 86400000)) : 0;
}
function calculatorRefs(calcRuns) {
  return new Set((calcRuns || []).map((row) => String(row?.dados?.ref || '').trim().toUpperCase()).filter(Boolean));
}
function hasCalculatorOrder(journey, refs, refsFromCalculator) {
  const journeyRefs=[journey?.reference_code,...(refs || []).filter((row)=>row.journey_id===journey?.id).map((row)=>row.ref_code)]
    .map((value)=>String(value||'').trim().toUpperCase()).filter(Boolean);
  return journeyRefs.some((value)=>refsFromCalculator.has(value));
}
function directLeadSource(journey, hasOrder) {
  return !hasOrder&&['WHATSAPP_DIRECT','SMS_DIRECT'].includes(journey?.source)?journey.source:null;
}

async function loadSearchStageIndex(ctx, options = {}) {
  const targetIds = Array.isArray(options.journeyIds) ? [...new Set(options.journeyIds.filter(Boolean))] : null;
  const scoped = Boolean(targetIds);
  if (scoped && !targetIds.length) return new Map();
  const inFilter = (values) => 'in.(' + values.map((value) => '"' + String(value).replaceAll('"', '') + '"').join(',') + ')';
  const supported = await undoSupported(ctx, { allRows }).catch(() => false);
  let journeys, refs, calcRuns, calcLinks, marks, events, units, confirmedPrints, toggles, presented, externalOwners = [];
  if (scoped) {
    [journeys, refs] = await Promise.all([
      allRows(ctx, 'journeys', { select: 'id,reference_code,source,status,criteria_json,budget_cents,confirmed_total_ceiling_cents,created_at,updated_at', environment: 'eq.' + ctx.environment, id: inFilter(targetIds) }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment, journey_id: inFilter(targetIds) })
    ]);
    const targetRefs = [...new Set([...journeys.map((row) => row.reference_code), ...refs.map((row) => row.ref_code)].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];
    const ids = journeys.map((row) => row.id);
    const refFilter = targetRefs.length ? inFilter(targetRefs) : null;
    [externalOwners, calcRuns, calcLinks, marks, events, units, confirmedPrints, toggles] = await Promise.all([
      refFilter ? Promise.all([
        allRows(ctx, 'journeys', { select: 'id,reference_code', environment: 'eq.' + ctx.environment, reference_code: refFilter }),
        allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment, ref_code: refFilter })
      ]).then(([codes, links]) => [...codes, ...links.map((row) => ({ id: row.journey_id, ref_code: row.ref_code }))]) : Promise.resolve([]),
      refFilter ? allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc', 'dados->>ref': refFilter }) : Promise.resolve([]),
      refFilter ? allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment, calc_ref: refFilter }).catch(() => []) : Promise.resolve([]),
      allRows(ctx, 'panel_search_marks', { select: 'journey_id,kind,created_at' + (supported ? ',logical_mode' : ''), environment: 'eq.' + ctx.environment, undone_at: 'is.null', journey_id: inFilter(ids) }).catch(() => []),
      allRows(ctx, 'lead_events', { select: 'journey_id,event_type,occurred_at,detail_json', environment: 'eq.' + ctx.environment, event_type: 'eq.CAR_PRESENTED', undone_at: 'is.null', journey_id: inFilter(ids) }),
      allRows(ctx, 'units', { select: 'id,journey_id,status,presented_at,created_at,details_json', environment: 'eq.' + ctx.environment, status: 'neq.WITHDRAWN', journey_id: inFilter(ids) }),
      allRows(ctx, 'sms_print_reads', { select: 'confirmed_journey_id', environment: 'eq.' + ctx.environment, status: 'eq.CONFIRMED', confirmed_journey_id: inFilter(ids) }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: 'eq.' + ctx.environment, journey_id: inFilter(ids) })
    ]);
    const unitIds = units.map((row) => row.id).filter(Boolean);
    presented = supported && unitIds.length ? await allRows(ctx, 'manheim_matches', { select: 'presented_unit_id,logical_mode', environment: 'eq.' + ctx.environment, presented_unit_id: inFilter(unitIds) }).catch(() => []) : [];
  } else {
    [journeys, refs, calcRuns, calcLinks, marks, events, units, confirmedPrints, toggles, presented] = await Promise.all([
      allRows(ctx, 'journeys', { select: 'id,reference_code,source,status,criteria_json,budget_cents,confirmed_total_ceiling_cents,created_at,updated_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }).catch(() => []),
      allRows(ctx, 'panel_search_marks', { select: 'journey_id,kind,created_at' + (supported ? ',logical_mode' : ''), environment: 'eq.' + ctx.environment, undone_at: 'is.null' }).catch(() => []),
      allRows(ctx, 'lead_events', { select: 'journey_id,event_type,occurred_at,detail_json', environment: 'eq.' + ctx.environment, event_type: 'eq.CAR_PRESENTED', undone_at: 'is.null' }),
      allRows(ctx, 'units', { select: 'id,journey_id,status,presented_at,created_at,details_json', environment: 'eq.' + ctx.environment, status: 'neq.WITHDRAWN' }),
      allRows(ctx, 'sms_print_reads', { select: 'confirmed_journey_id', environment: 'eq.' + ctx.environment, status: 'eq.CONFIRMED' }),
      allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled', environment: 'eq.' + ctx.environment }),
      supported ? allRows(ctx, 'manheim_matches', { select: 'presented_unit_id,logical_mode', environment: 'eq.' + ctx.environment, presented_unit_id: 'not.is.null' }).catch(() => []) : Promise.resolve([])
    ]);
  }
  const toggleByJourney = new Map(toggles.map((row) => [row.journey_id, row]));
  const savedByKey = new Map();
  const unitMode = new Map(presented.filter((row) => row.logical_mode).map((row) => [row.presented_unit_id, row.logical_mode]));
  // A mark, event or unit without a mode (made before the split) counts for every mode of the ficha.
  const latestFor = (list, journeyId, mode) => list.filter((row) => row.id === journeyId && (!row.mode || row.mode === mode)).reduce((best, row) => (!best || Date.parse(best) < Date.parse(row.at) ? row.at : best), null);
  const markRows = marks.map((mark) => ({ id: mark.journey_id, kind: mark.kind, at: mark.created_at, mode: mark.logical_mode || null }));
  const modeOf = (value) => vehicleMatch.normalizedMode(value && value.logical_mode);
  const sentRows = [...events.map((row) => ({ id: row.journey_id, at: row.occurred_at, mode: modeOf(row.detail_json) })), ...units.map((row) => ({ id: row.journey_id, at: row.presented_at || row.created_at, mode: unitMode.get(row.id) || modeOf(row.details_json) || null }))];
  const confirmedByJourney = new Set(confirmedPrints.map((row) => row.confirmed_journey_id).filter(Boolean));
  const refsFromCalculator = calculatorRefs(calcRuns);
  const demands = buildSearchDemands({ journeys, refs, modeItems: consolidateCalcRuns(calcRuns, calcLinks), externalOwners }).byJourney;
  const keys = [...new Set([...demands.values()].flatMap((list) => list.filter((demand) => demand.active).map((demand) => searchIdentity(searchableWish(demand.activeWishes), demand.mode)?.key).filter(Boolean)))];
  const saved = keys.length ? await allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created,updated_at', environment: 'eq.' + ctx.environment, created: 'eq.true', search_key: inFilter(keys) }) : scoped ? [] : await allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created,updated_at', environment: 'eq.' + ctx.environment, created: 'eq.true' });
  saved.forEach((row) => savedByKey.set(row.search_key, row.updated_at || null));
  const index = new Map();
  journeys.forEach((journey) => {
    const hasOrder = hasCalculatorOrder(journey, refs, refsFromCalculator);
    const source = directLeadSource(journey, hasOrder);
    const common = { hasCalculatorOrder: hasOrder, directLeadSource: source, smsPrintConfirmed: confirmedByJourney.has(journey.id) };
    const own = demands.get(journey.id) || [];
    // A closed or switched-off journey has no search to do: no badge.
    if (!own.length || !toggleEnabled(journey.status, toggleByJourney.get(journey.id))) { index.set(journey.id, common); return; }
    const modes = {};
    own.filter((demand) => demand.active).forEach((demand) => {
      const wish = searchableWish(demand.activeWishes);
      const identity = searchIdentity(wish, demand.mode);
      if (!identity) return;
      const sentAt = latestFor(sentRows, journey.id, demand.mode) || latestFor(markRows.filter((row) => row.kind === 'SENT'), journey.id, demand.mode);
      const sentFromEvent = latestFor(sentRows, journey.id, demand.mode);
      const savedFromManheim = savedByKey.get(identity.key) || null;
      const savedAt = savedFromManheim || latestFor(markRows.filter((row) => row.kind === 'SAVED'), journey.id, demand.mode);
      const stage = sentAt ? 'SENT' : savedAt ? 'SAVED' : 'MISSING';
      const stageSource = stage === 'SENT' ? (sentFromEvent ? 'EVENT' : 'MARK') : stage === 'SAVED' ? (savedFromManheim ? 'MANHEIM' : 'MARK') : null;
      modes[demand.mode] = { mode: demand.mode, demandKey: demand.key, stage, stageSource, label: stageLabel(stage, identity.basis), basis: identity.basis, at: sentAt || savedAt || journey.created_at, searchKey: identity.key, wish, wishes: demand.activeWishes, bidCents: demand.mode === 'VALOR' ? demand.bidCents : null };
    });
    const first = modes.VALOR || modes.CARRO || null;
    if (!first) {
      // Only demands waiting for review (mode unknown or incomplete criteria): nothing to save yet.
      index.set(journey.id, { ...common, stage: 'MISSING', stageSource: null, label: stageLabel('MISSING', 'QUALIFY'), basis: 'QUALIFY', at: journey.created_at, searchKey: null, wish: null, wishes: [], bidCents: null, modes, review: own.filter((demand) => !demand.active).map((demand) => ({ mode: demand.mode, issues: demand.issues })) });
      return;
    }
    index.set(journey.id, { ...common, ...first, modes, review: own.filter((demand) => !demand.active).map((demand) => ({ mode: demand.mode, issues: demand.issues })) });
  });
  return index;
}

function decorateWithSearchStage(item, index) {
  const journeyId = item && (item.journeyId || item.journey_id || item.id);
  const stage = journeyId && index.get(journeyId);
  return stage ? { ...item, searchStage: stage.stage, searchStageSource:stage.stageSource, searchStageLabel: stage.label, searchStageAt: stage.at, searchKey: stage.searchKey, hasCalculatorOrder:stage.hasCalculatorOrder, directLeadSource:stage.directLeadSource, smsPrintConfirmed: stage.smsPrintConfirmed } : item;
}

module.exports = { searchableWish, searchKey, searchIdentity, stageLabel, floridaDays, calculatorRefs, hasCalculatorOrder, directLeadSource, loadSearchStageIndex, decorateWithSearchStage };

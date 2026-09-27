'use strict';

// The same deterministic search identity is used by BUSCAS and Manheim saves.
const { allRows } = require('./panel-server');
const { wishlistsForJourney } = require('./panel-domain');
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
function stageLabel(stage) { return ({ MISSING: '🔍 Falta buscar', SAVED: '💾 Busca salva', SENT: '📤 Opções enviadas' })[stage] || ''; }
function floridaDays(at, now = Date.now()) {
  const stamp = Date.parse(at || '');
  return Number.isFinite(stamp) ? Math.max(0, Math.floor((now - stamp) / 86400000)) : 0;
}

async function loadSearchStageIndex(ctx) {
  const [journeys, saved, marks, events, units, confirmedPrints] = await Promise.all([
    allRows(ctx, 'journeys', { select: 'id,criteria_json,created_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'manheim_saved_searches', { select: 'search_key,created,updated_at', environment: 'eq.' + ctx.environment, created: 'eq.true' }),
    allRows(ctx, 'panel_search_marks', { select: 'journey_id,kind,created_at', environment: 'eq.' + ctx.environment, undone_at: 'is.null' }).catch(() => []),
    allRows(ctx, 'lead_events', { select: 'journey_id,event_type,occurred_at', environment: 'eq.' + ctx.environment, event_type: 'eq.CAR_PRESENTED', undone_at: 'is.null' }),
    allRows(ctx, 'units', { select: 'journey_id,status,presented_at,created_at', environment: 'eq.' + ctx.environment, status: 'eq.PRESENTED' }),
    allRows(ctx, 'sms_print_reads', { select: 'confirmed_journey_id', environment: 'eq.' + ctx.environment, status: 'eq.CONFIRMED' })
  ]);
  const savedByKey = new Map(saved.map((row) => [row.search_key, row.updated_at || null]));
  const marksByJourney = new Map();
  marks.forEach((mark) => {
    const current = marksByJourney.get(mark.journey_id) || {};
    if (!current[mark.kind] || Date.parse(current[mark.kind]) < Date.parse(mark.created_at)) current[mark.kind] = mark.created_at;
    marksByJourney.set(mark.journey_id, current);
  });
  const sentByJourney = new Map();
  [...events.map((row) => ({ id: row.journey_id, at: row.occurred_at })), ...units.map((row) => ({ id: row.journey_id, at: row.presented_at || row.created_at }))]
    .forEach((row) => { if (!sentByJourney.get(row.id) || Date.parse(sentByJourney.get(row.id)) < Date.parse(row.at)) sentByJourney.set(row.id, row.at); });
  const confirmedByJourney = new Set(confirmedPrints.map((row) => row.confirmed_journey_id).filter(Boolean));
  const index = new Map();
  journeys.forEach((journey) => {
    const wish = searchableWish(wishlistsForJourney(journey));
    const key = searchKey(wish);
    if (!key) {
      if (confirmedByJourney.has(journey.id)) index.set(journey.id, { smsPrintConfirmed: true });
      return;
    }
    const marksFor = marksByJourney.get(journey.id) || {};
    const sentAt = sentByJourney.get(journey.id) || marksFor.SENT || null;
    const savedAt = savedByKey.get(key) || marksFor.SAVED || null;
    const stage = sentAt ? 'SENT' : savedAt ? 'SAVED' : 'MISSING';
    index.set(journey.id, { stage, label: stageLabel(stage), at: sentAt || savedAt || journey.created_at, searchKey: key, wish, smsPrintConfirmed: confirmedByJourney.has(journey.id) });
  });
  return index;
}

function decorateWithSearchStage(item, index) {
  const journeyId = item && (item.journeyId || item.journey_id || item.id);
  const stage = journeyId && index.get(journeyId);
  return stage ? { ...item, searchStage: stage.stage, searchStageLabel: stage.label, searchStageAt: stage.at, searchKey: stage.searchKey, smsPrintConfirmed: stage.smsPrintConfirmed } : item;
}

module.exports = { searchableWish, searchKey, stageLabel, floridaDays, loadSearchStageIndex, decorateWithSearchStage };

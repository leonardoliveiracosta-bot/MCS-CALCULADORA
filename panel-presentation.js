'use strict';

// "Apresentei ao cliente" and the V1 sent by the panel record the same thing: one unit per car shown
// (manheim_matches.presented_unit_id points to it, so a car is never presented twice), the stage moved
// only forward and the start of the search dated. The V1 also marks the search of its mode as "SENT".
// Nothing here sends a message.
const { nextStageForUnits, finiteInteger, toggleEnabled } = require('./panel-domain');
const { recordMutation, safeText } = require('./panel-server');
const { undoSupported } = require('./panel-manheim-state');

const vehicleTextOf = (parsed) => safeText([parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' '), 500, true);
function matchDetails(match) {
  const parsed = match.vehicle_json && match.vehicle_json.parsed || {};
  return {
    manheim_match_id: match.id, miles: finiteInteger(parsed.miles), location: safeText(parsed.location, 200) || null,
    sale_date: safeText(parsed.saleDate, 100) || null, mmr_cents: finiteInteger(parsed.mmrCents),
    exterior_color: safeText(parsed.exteriorColor, 120) || null, buy_now_price: safeText(parsed.buyNowPrice, 120) || null,
    condition_report_grade: safeText(parsed.conditionGrade, 120) || null
  };
}

// One unit for one Manheim match not presented yet. Returns the unit id, or null when the match was
// already presented (nothing is created).
async function presentMatch(ctx, journey, match, at, services, { details: extraDetails = {}, status = 'PRESENTED' } = {}) {
  if (!match || match.presented_unit_id) return null;
  const vehicle = vehicleTextOf(match.vehicle_json && match.vehicle_json.parsed || {});
  if (!vehicle) return null;
  const [unit] = await services.insert(ctx, 'units', { environment: ctx.environment, journey_id: journey.id, vehicle_text: vehicle, details_json: { ...matchDetails(match), ...extraDetails }, presented_at: at, status, created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id });
  // Only a match still without a unit takes this one: a presentation made at the same moment by
  // another path keeps its own and this unit is withdrawn (never two units for one car).
  const taken = await services.patchRows(ctx, 'manheim_matches', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + match.id, presented_unit_id: 'is.null' }, { presented_unit_id: unit.id }, true);
  if (Array.isArray(taken) && !taken.length) {
    await services.patchRows(ctx, 'units', { environment: 'eq.' + ctx.environment, id: 'eq.' + unit.id }, { status: 'WITHDRAWN', updated_at: at, updated_by: ctx.panel.id });
    return null;
  }
  return unit.id;
}

// A presented car starts the search (only forward); the first presentation dates it.
async function advanceStage(ctx, journey, at, services) {
  const units = await services.rows(ctx, 'units', { select: 'id,status', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id });
  const stage = nextStageForUnits(journey.stage, units);
  const searchStart = !journey.search_started_at && units.some((item) => item.status !== 'WITHDRAWN') ? { search_started_at: at } : {};
  if (stage !== journey.stage || searchStart.search_started_at) await services.patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { stage, ...searchStart, updated_at: at, updated_by: ctx.panel.id });
  return stage;
}

// The V1 sent (confirmed by the server: SENT or UNCONFIRMED) is a presentation of its cars. Safe to
// run again for a resend: cars already presented and a "SENT" mark already active are kept as they are.
async function recordV1Presentation(ctx, { vitrineId, journeyId, origin = null, at }, services) {
  const env = 'eq.' + ctx.environment;
  const [journey] = await services.rows(ctx, 'journeys', { select: 'id,contact_id,stage,status,search_started_at', environment: env, id: 'eq.' + journeyId, limit: '1' });
  if (!journey) return { units: [], marks: [] };
  const [toggle] = await services.rows(ctx, 'journey_toggle_states', { select: 'enabled', environment: env, journey_id: 'eq.' + journeyId, limit: '1' });
  const cars = await services.rows(ctx, 'vitrine_cars', { select: 'source_match_id', environment: env, vitrine_id: 'eq.' + vitrineId });
  const matchIds = [...new Set(cars.map((car) => car.source_match_id).filter(Boolean))];
  const supported = await undoSupported(ctx, { rows: services.rows }).catch(() => false);
  const matches = matchIds.length ? await services.rows(ctx, 'manheim_matches', { select: 'id,vehicle_json,presented_unit_id' + (supported ? ',logical_mode' : ''), environment: env, journey_id: 'eq.' + journeyId, id: 'in.(' + matchIds.join(',') + ')' }) : [];
  const units = [];
  // A switched-off or closed ficha gets no unit and no stage change (the same rule as "Apresentei").
  const enabled = toggleEnabled(journey.status, toggle);
  if (enabled) {
    for (const match of matches) {
      const unitId = await presentMatch(ctx, journey, match, at, services, { details: { v1_vitrine_id: vitrineId } });
      if (unitId) units.push(unitId);
    }
  }
  const stage = enabled && units.length ? await advanceStage(ctx, journey, at, services) : journey.stage;
  // The search of the V1's mode is "SENT". Without a known origin, the modes of its cars; with none,
  // a mark without mode (it counts for every mode of the ficha, like the marks made before the split).
  const modes = origin ? [origin] : [...new Set(matches.map((match) => match.logical_mode).filter(Boolean))];
  const marks = [];
  for (const mode of supported && modes.length ? modes : [null]) {
    const filter = supported ? { logical_mode: mode ? 'eq.' + mode : 'is.null' } : {};
    const [existing] = await services.rows(ctx, 'panel_search_marks', { select: 'id', environment: env, journey_id: 'eq.' + journeyId, kind: 'eq.SENT', ...filter, undone_at: 'is.null', limit: '1' });
    if (existing) continue;
    await services.insert(ctx, 'panel_search_marks', { environment: ctx.environment, journey_id: journeyId, kind: 'SENT', ...(supported && mode ? { logical_mode: mode } : {}), created_at: at, created_by: ctx.panel.id }, false);
    marks.push(mode);
  }
  if (units.length || marks.length) {
    await (services.recordMutation || recordMutation)(ctx, {
      at, journeyId, contactId: journey.contact_id,
      activityType: 'V1_PRESENTED', summary: 'V1 enviada: carros apresentados ao cliente', metadata: { vitrine_id: vitrineId, unit_ids: units, modes: marks },
      entityType: 'vitrine', entityId: vitrineId, action: 'PRESENT', after: { units: units.length, stage }
    });
  }
  return { units, marks, stage };
}

module.exports = { advanceStage, matchDetails, presentMatch, recordV1Presentation, vehicleTextOf };

'use strict';

const {
  clientOkPatch, confirmedJourneyModes, journeyDemands, consolidateCalcRuns, effectiveCriteria, finiteInteger, groupCalculatorByRef, journeyEnabled,
  mergeWishlists, modeVehicleText, modeWishText, SEARCH_MODES, normalizeWishlist, nextStageForUnits, REF_RE, toggleEnabled, time, wishlistsForJourney, wishlistText
} = require('../../panel-domain');
const openAiBudget = require('../../panel-openai-budget');
const { journeyExists, messageForJourney } = require('../../panel-read-model');
const manheimAi = require('../../panel-manheim-ai');
const vehicleMatchRule = require('../../vehicle-match');
const { activeFilter, matchIsLive, undoSupported } = require('../../panel-manheim-state');
const { dispositionIndex } = require('../../panel-disposition');
const vehicleCatalog = require('../../vehicle-catalog');
const { parseMoneyCents } = require('../../money-text');
const { localToUtc, timezoneForZip } = require('../../panel-lead');
const {
  allRows, insert, isUuid, jsonBody, patchRows, recordMutation, requirePanel,
  rows, safeText, send, supabase
} = require('../../panel-server');

const isoNow = () => new Date().toISOString();

function safeWishlist(value, requireVehicle = false) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const make = safeText(source.make, 80) || '';
  const model = safeText(source.model, 120) || '';
  const yearMin = finiteInteger(source.yearMin);
  const yearMax = finiteInteger(source.yearMax);
  const maxMiles = finiteInteger(source.maxMiles);
  const minMiles = finiteInteger(source.minMiles);
  const trim = safeText(source.trim, 120) || '';
  const maximumYear = new Date().getUTCFullYear() + 2;
  if ((requireVehicle && !model)
      || (yearMin !== null && (yearMin < 1900 || yearMin > maximumYear))
      || (yearMax !== null && (yearMax < 1900 || yearMax > maximumYear))
      || (yearMin && yearMax && yearMin > yearMax)
      || (maxMiles !== null && (maxMiles < 0 || maxMiles > 2000000))
      || (minMiles !== null && (minMiles < 0 || minMiles > 2000000))) return null;
  // An inverted mileage range is kept as given (never swapped); BUSCAS sends it to review.
  return { make, model, yearMin, yearMax, minMiles, maxMiles, trim };
}

function safeWishlists(value, requireVehicle = false) {
  const sources = Array.isArray(value) ? value : value ? [value] : [];
  if (!sources.length || sources.length > 5) return null;
  const wishlists = sources.map((source) => safeWishlist(source, requireVehicle));
  return wishlists.every(Boolean) ? wishlists : null;
}

function declarationKey(field, value, valueJson = {}) {
  if (field === 'TETO') {
    if (Number.isFinite(Number(valueJson.ceilingCents))) return String(Math.round(Number(valueJson.ceilingCents)));
    if (Number.isFinite(Number(valueJson.cents))) return String(Math.round(Number(valueJson.cents)));
    const amount = Number(String(value || '').replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
    if (Number.isFinite(amount)) return String(Math.round(amount * 100));
  }
  return String(value || '').normalize('NFC').trim().toLocaleLowerCase('pt-BR');
}

async function journeyContext(ctx, value) {
  if (!isUuid(value)) return null;
  return journeyExists(ctx, value);
}

async function journeyTimezone(ctx, journey) {
  const contact = await rows(ctx, 'contacts', { select: 'location_text', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id, limit: '1' });
  let zip = String(contact[0]?.location_text || '').match(/\b\d{5}(?:-\d{4})?\b/)?.[0] || '';
  if (!zip) {
    const linked = await rows(ctx, 'journey_refs', { select: 'ref_code', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, order: 'created_at.asc', limit: '5' });
    const references = [journey.reference_code, ...linked.map((item) => item.ref_code)].filter(Boolean);
    for (const ref of references) {
      const runs = await rows(ctx, 'calc_runs', { select: 'zip', 'dados->>ref': 'ilike.' + String(ref).toUpperCase(), order: 'created_at.desc', limit: '1' });
      if (runs[0]?.zip) { zip = runs[0].zip; break; }
    }
  }
  return timezoneForZip(zip);
}

async function recordMessageMenuEvent(ctx, journey, body, kind, at) {
  const ref=String(body.ref||journey.reference_code||'').trim().toUpperCase();
  if(!REF_RE.test(ref))return;
  if(ref!==String(journey.reference_code||'').trim().toUpperCase()){
    const linked=await rows(ctx,'journey_refs',{select:'journey_id',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,ref_code:'eq.'+ref,limit:'1'});
    if(!linked[0])return;
  }
  await insert(ctx,'lead_events',{environment:ctx.environment,ref_code:ref,journey_id:journey.id,event_type:'ACTION_MESSAGE_'+kind,
    detail_json:{messageId:body.messageId},occurred_at:at,created_by:ctx.panel.id},false);
}

async function cancelSuppressions(ctx, journeyId, at) {
  await patchRows(ctx, 'journey_alert_suppressions', {
    environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId,
    cancelled_at: 'is.null'
  }, { cancelled_at: at, cancelled_by: ctx.panel.id });
}


async function actionNext(ctx, journey, body) {
  const operation = String(body.operation || '');
  const at = isoNow();
  if (operation === 'CREATE') {
    const detail = safeText(body.text, 500, true);
    const due = time(body.at);
    if (!detail || !due) return send(ctx.res, 400, { error: 'NEXT_ACTION_INVALID' });
    const dueAt = new Date(due).toISOString();
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, {
      next_action_text: detail, next_action_at: dueAt, next_action_missing_since: null,
      updated_at: at, updated_by: ctx.panel.id
    });
    await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, type: 'NEXT_ACTION_CREATED', occurred_at: at, detail_text: null, next_action_at: dueAt, created_at: at, created_by: ctx.panel.id }, false);
    await recordMutation(ctx, {
      at, journeyId: journey.id, contactId: journey.contact_id,
      activityType: 'NEXT_ACTION_CREATED', summary: 'Próxima ação criada', metadata: { next_action_at: dueAt },
      entityType: 'journey', entityId: journey.id, action: 'NEXT_ACTION_CREATE', after: { next_action_at: dueAt }
    });
    return send(ctx.res, 200, { status: 'CREATED', nextActionAt: dueAt });
  }
  if (!['COMPLETE', 'REMOVE'].includes(operation)) return send(ctx.res, 400, { error: 'NEXT_ACTION_OPERATION_INVALID' });
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, {
    next_action_text: null, next_action_at: null, next_action_missing_since: at,
    updated_at: at, updated_by: ctx.panel.id
  });
  const type = operation === 'COMPLETE' ? 'NEXT_ACTION_COMPLETED' : 'NEXT_ACTION_REMOVED';
  await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, type, occurred_at: at, detail_text: null, created_at: at, created_by: ctx.panel.id }, false);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, activityType: type,
    summary: operation === 'COMPLETE' ? 'Próxima ação concluída' : 'Próxima ação removida', metadata: {},
    entityType: 'journey', entityId: journey.id, action: type,
    before: { next_action_at: journey.next_action_at }, after: { next_action_at: null, next_action_missing_since: at }
  });
  return send(ctx.res, 200, { status: operation });
}


async function customerMessage(ctx, journey, messageId) {
  if (!isUuid(messageId)) return null;
  const message = await messageForJourney(ctx, journey.id, messageId);
  return message && message.direction === 'CUSTOMER' ? message : null;
}



// The ficha's effective wishes (R1): its own cars, or the cars of its linked calculator Refs.
// The ficha's calculator entries, split by mode (never the combined person view).
async function journeyModeItems(ctx, journey) {
  const refs = await allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id });
  const codes = [journey.reference_code, ...refs.map((row) => row.ref_code)].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return [];
  const [calcRuns, calcLinks] = await Promise.all([
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment })
  ]);
  return consolidateCalcRuns(calcRuns, calcLinks).filter((item) => codes.includes(item.ref));
}

// Marking a car on a message keeps the others, including the ones that came from a Ref.
async function effectiveWishes(ctx, journey) {
  const own = wishlistsForJourney(journey);
  const refs = await allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id });
  const codes = [journey.reference_code, ...refs.map((row) => row.ref_code)].map((value) => String(value || '').trim().toUpperCase()).filter(Boolean);
  if (!codes.length) return own;
  const [calcRuns, calcLinks, dispositions] = await Promise.all([
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment, cleared_at: 'is.null' })
  ]);
  const orders = groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks), dispositions).filter((order) => codes.includes(order.ref));
  const merged = orders.length ? { wishlists: mergeWishlists([], orders.flatMap((order) => order.wishlists || [])), budgetCents: null } : null;
  return effectiveCriteria(journey, merged).wishes.map((wish) => normalizeWishlist(wish));
}

async function actionMarkMessage(ctx, journey, body) {
  const kind = String(body.kind || '');
  const config = {
    VEHICLE: { point: 1, field: 'VEICULO' }, BUDGET: { point: 2, field: 'TETO' },
    PAYMENT: { point: 3, field: 'PAGAMENTO' }, DEADLINE: { point: 4, field: 'PRAZO' },
    OUTSIDE_FLORIDA: { point: 5 }, NO_TEST_DRIVE: { point: 6 }
  }[kind];
  // M6: nothing marked on a message changes a closed journey.
  if (config && (journey.stage_frozen || journey.status === 'ENCERRADO')) return send(ctx.res, 409, { error: 'JOURNEY_CLOSED' });
  const message = await customerMessage(ctx, journey, body.messageId);
  if (!config || !message) return send(ctx.res, 400, { error: 'MESSAGE_MARK_INVALID' });
  const wishlists = kind === 'VEHICLE' ? safeWishlists(body.wishlists || body.wishlist, true) : null;
  if (kind === 'VEHICLE' && !wishlists) return send(ctx.res, 400, { error: 'WISHLIST_INVALID' });
  const value = safeText(kind === 'VEHICLE' ? wishlistText(wishlists) : body.value || message.body_text, kind === 'VEHICLE' ? 1200 : 500, true);
  if (config.field && !value) return send(ctx.res, 400, { error: 'MESSAGE_MARK_VALUE_INVALID' });
  const valueJson = wishlists ? { wishlist: { wishlists } } : {};
  // A car, range or bid belongs to one search. With both searches on the ficha the mode is
  // required and the change goes only to that mode (criteria_json.mode_overrides); it is never
  // applied to both.
  let perMode = null, modeDemand = null, modeItems = [];
  if (wishlists) {
    modeItems = await journeyModeItems(ctx, journey);
    const demands = journeyDemands(journey, modeItems).filter((demand) => SEARCH_MODES.includes(demand.mode));
    const modes = demands.map((demand) => demand.mode);
    const requested = String(body.mode || '').toUpperCase();
    if (requested && !SEARCH_MODES.includes(requested)) return send(ctx.res, 400, { error: 'SEARCH_MODE_INVALID' });
    if (modes.length > 1 && !requested) return send(ctx.res, 400, { error: 'SEARCH_MODE_REQUIRED' });
    perMode = requested || null;
    modeDemand = perMode ? demands.find((demand) => demand.mode === perMode) || null : null;
  }
  if (wishlists && !perMode) {
    // A:P17: the cars marked on the message become the ficha's confirmed wishes. The marked cars
    // come first; the ficha's other cars stay (the form starts empty, so nothing is lost).
    const same = (left, right) => vehicleCatalog.fold(left.make) === vehicleCatalog.fold(right.make) && vehicleCatalog.modelTokens(left.model, left.make).join(' ') === vehicleCatalog.modelTokens(right.model, right.make).join(' ');
    const marked = wishlists.map((wish) => normalizeWishlist(wish)).filter((wish) => wish.model);
    const kept = (await effectiveWishes(ctx, journey)).filter((wish) => !marked.some((candidate) => same(candidate, wish)));
    valueJson.confirmedWishlists = marked.concat(kept).slice(0, 5);
  }
  let modeWishes = null;
  if (wishlists && perMode) {
    const same = (left, right) => vehicleCatalog.fold(left.make) === vehicleCatalog.fold(right.make) && vehicleCatalog.modelTokens(left.model, left.make).join(' ') === vehicleCatalog.modelTokens(right.model, right.make).join(' ');
    const marked = wishlists.map((wish) => normalizeWishlist(wish)).filter((wish) => wish.model);
    const kept = (modeDemand ? modeDemand.wishes : []).map(normalizeWishlist).filter((wish) => !marked.some((candidate) => same(candidate, wish)));
    modeWishes = marked.concat(kept).slice(0, 5);
    // Written atomically by panel_mark_message_fact_v2 (migration 20261001010000). Before that
    // migration the RPC would ignore the mode, so the change is refused instead of lost.
    if (!(await undoSupported(ctx, { rows }))) return send(ctx.res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
    // A mark for ONE search never reaches the ficha's generic fields: no value_json.wishlist
    // (the old declaration trigger copies it to criteria_json.wishlist) and no confirmedWishlists.
    delete valueJson.wishlist;
    valueJson.mode = perMode;
    valueJson.modeWishlists = modeWishes;
    // vehicle_text is the summary of the ficha AFTER this mark: the same override the RPC writes,
    // read through the same demand rule BUSCAS uses (with two modes the generic wishes no longer
    // feed any mode, so they never reach the summary).
    const criteria = journey.criteria_json && typeof journey.criteria_json === 'object' && !Array.isArray(journey.criteria_json) ? journey.criteria_json : {};
    const overrides = criteria.mode_overrides && typeof criteria.mode_overrides === 'object' && !Array.isArray(criteria.mode_overrides) ? criteria.mode_overrides : {};
    const after = { ...journey, criteria_json: { ...criteria, mode_overrides: { ...overrides, [perMode]: { wishlists: modeWishes, wishlistOverride: true } } } };
    const demandsAfter = journeyDemands(after, modeItems).filter((demand) => SEARCH_MODES.includes(demand.mode));
    const modesAfter = demandsAfter.map((demand) => demand.mode);
    const vehicleText = modeVehicleText(modesAfter, Object.fromEntries(demandsAfter.map((demand) => [demand.mode, modeWishText(demand.mode, demand.wishes)])));
    if (vehicleText && vehicleText.length <= 500) valueJson.vehicleText = vehicleText;
  }
  if (config.field === 'TETO') {
    // The total ceiling goes only to confirmed_total_ceiling_cents (R2), written atomically by
    // panel_mark_message_fact_v2 from value_json.ceilingCents; budget_cents (maximum bid) is untouched.
    if (journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_CLOSED' });
    // Only the amount the operator typed and confirmed; never the whole message text.
    const ceilingCents = parseMoneyCents(body.value);
    if (ceilingCents === null) return send(ctx.res, 400, { error: 'CEILING_VALUE_INVALID' });
    valueJson.ceilingCents = ceilingCents;
  }
  const deadlineAt = time(body.deadlineAt) ? new Date(time(body.deadlineAt)).toISOString() : null;
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_mark_message_fact_v2', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      p_environment: ctx.environment,
      p_journey_id: journey.id,
      p_message_id: message.id,
      p_kind: kind,
      p_actor_id: ctx.panel.id,
      p_value: config.field ? value : null,
      p_value_json: valueJson,
      p_deadline_at: deadlineAt,
      p_simulate_failure: false
    })
  });
  await recordMessageMenuEvent(ctx,journey,body,'MARK_'+kind,isoNow());
  return send(ctx.res, 200, config.field === 'TETO' ? { ...result, ceilingCents: valueJson.ceilingCents } : modeWishes ? { ...result, mode: perMode } : result);
}

async function actionNote(ctx, journey, body) {
  const note = safeText(body.note, 4000) || null;
  const at = isoNow();
  await patchRows(ctx, 'contacts', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id }, { notes: note, updated_at: at, updated_by: ctx.panel.id });
  await recordMutation(ctx, { at, journeyId: journey.id, contactId: journey.contact_id, activityType: 'NOTE_UPDATED', summary: 'Nota atualizada', metadata: {}, entityType: 'contact', entityId: journey.contact_id, action: 'NOTE_UPDATE', after: { has_note: Boolean(note) } });
  return send(ctx.res, 200, { saved: true });
}

async function actionFunnel(ctx, journey, body) {
  if (journey.stage_frozen || journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_FROZEN' });
  const value = String(body.value || '');
  const stages = new Set(['NOVO', 'RESPONDIDO', 'EM_BUSCA', 'DECIDINDO', 'QUALIFICADO']);
  const statuses = new Set(['AGUARDANDO_CLIENTE', 'PARADO']);
  if (!stages.has(value) && !statuses.has(value)) return send(ctx.res, 400, { error: 'FUNNEL_VALUE_INVALID' });
  const at = isoNow();
  const patch = stages.has(value)
    ? { stage: value, status: 'ATIVO', qualified_at: value === 'QUALIFICADO' ? at : null, updated_at: at, updated_by: ctx.panel.id }
    : { status: value, updated_at: at, updated_by: ctx.panel.id };
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, patch);
  await recordMutation(ctx, { at, journeyId: journey.id, contactId: journey.contact_id, activityType: 'JOURNEY_FUNNEL_CHANGED', summary: 'Etapa operacional alterada', metadata: { value }, entityType: 'journey', entityId: journey.id, action: 'FUNNEL_CHANGE', before: { stage: journey.stage, status: journey.status }, after: patch });
  return send(ctx.res, 200, { value });
}

async function actionPromise(ctx, journey, body) {
  const dueValue = body.dueLocal ? localToUtc(String(body.dueLocal).slice(0, 16), await journeyTimezone(ctx, journey)) : body.dueAt;
  if (!isUuid(body.messageId) || !time(dueValue)) return send(ctx.res, 400, { error: 'PROMISE_INVALID' });
  const message = await messageForJourney(ctx, journey.id, body.messageId);
  const dueText = safeText(body.dueText, 200, true);
  if (!message || message.direction !== 'MCS' || !dueText) return send(ctx.res, 400, { error: 'PROMISE_INVALID' });
  const duplicate = await rows(ctx, 'promises', { select: 'id', environment: 'eq.' + ctx.environment, message_id: 'eq.' + message.id, limit: '1' });
  if (duplicate[0]) return send(ctx.res, 409, { error: 'PROMISE_ALREADY_EXISTS' });
  const at = isoNow();
  const created = await insert(ctx, 'promises', {
    environment: ctx.environment, journey_id: journey.id, message_id: message.id,
    promise_text: String(message.body_text).slice(0, 2000), due_at: new Date(time(dueValue)).toISOString(),
    due_text: dueText, status: 'OPEN', created_at: at, created_by: ctx.panel.id
  });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, chatId: message.chat_id,
    activityType: 'PROMISE_RECORDED', summary: 'Promessa registrada', metadata: { message_id: message.id, due_at: new Date(time(dueValue)).toISOString() },
    entityType: 'promise', entityId: created[0].id, action: 'CREATE', after: { message_id: message.id, due_at: new Date(time(dueValue)).toISOString(), status: 'OPEN' }
  });
  await recordMessageMenuEvent(ctx,journey,body,'PROMISE',isoNow());
  return send(ctx.res, 201, { promiseId: created[0].id, status: 'OPEN' });
}


async function actionClientOk(ctx, journey, body) {
  if (journey.stage_frozen || journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_FROZEN' });
  const message = await customerMessage(ctx, journey, body.messageId);
  if (!message) return send(ctx.res, 400, { error: 'CUSTOMER_OK_EVIDENCE_INVALID' });
  const at = isoNow();
  const openPoints = await rows(ctx, 'journey_checklist', { select: 'point_number', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, status: 'eq.OPEN' });
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { ...clientOkPatch(at, message.id, journey.stage), updated_by: ctx.panel.id });
  await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, message_id: message.id, type: 'JOURNEY_QUALIFIED', occurred_at: at, detail_text: null, created_at: at, created_by: ctx.panel.id }, false);
  await cancelSuppressions(ctx, journey.id, at);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, chatId: message.chat_id,
    activityType: 'CLIENT_GAVE_OK', summary: 'Cliente deu OK; jornada qualificada',
    metadata: { evidence_message_id: message.id, open_checklist_points: openPoints.map((item) => item.point_number) },
    entityType: 'journey', entityId: journey.id, action: 'CLIENT_GAVE_OK',
    before: { stage: journey.stage, status: journey.status },
    after: { stage: 'QUALIFICADO', status: journey.status, evidence_message_id: message.id }
  });
  await recordMessageMenuEvent(ctx,journey,body,'CLIENT_OK',isoNow());
  return send(ctx.res, 200, { stage: 'QUALIFICADO', status: journey.status, openChecklistPoints: openPoints.map((item) => item.point_number) });
}

async function actionLinkRequest(ctx, journey, body) {
  const ref = String(body.calcRef || '').trim().toUpperCase();
  if (!REF_RE.test(ref) || body.contactId !== journey.contact_id) return send(ctx.res, 400, { error: 'CALCULATOR_LINK_INVALID' });
  const calcRuns = await allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' });
  const requests = consolidateCalcRuns(calcRuns).filter((item) => item.ref === ref);
  if (!requests.length) return send(ctx.res, 404, { error: 'CALCULATOR_REQUEST_NOT_FOUND' });

  const at = isoNow();
  const linkedIds = [];
  const allWishlists = [];
  const ordered = requests.slice().sort((a, b) => (time(b.occurredAt) || 0) - (time(a.occurredAt) || 0));

  for (const request of ordered) {
    allWishlists.push(...(request.wishlists || (request.wishlist ? [request.wishlist] : [])));
    const sids = Array.isArray(request.sids) && request.sids.length ? request.sids : [request.sid].filter(Boolean);
    for (const sid of sids) {
      const payload = {
        environment: ctx.environment, calc_sid: sid, calc_ref: ref, logical_mode: request.logicalMode,
        contact_id: journey.contact_id, journey_id: journey.id, linked_at: at, linked_by: ctx.panel.id
      };
      const linked = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/calculator_request_links?on_conflict=environment,calc_sid,calc_ref,logical_mode', {
        method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(payload)
      });
      if (linked[0] && linked[0].id) linkedIds.push(linked[0].id);
      const existingRef = await rows(ctx, 'journey_refs', {
        select: 'id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id,
        ref_code: 'eq.' + ref, calculator_sid: 'eq.' + sid, limit: '1'
      });
      if (!existingRef[0]) await insert(ctx, 'journey_refs', {
        environment: ctx.environment, journey_id: journey.id, ref_code: ref, source_message_id: null,
        calculator_sid: sid, created_at: at, created_by: ctx.panel.id
      }, false);
    }

    const declarationSid = sids[0] || request.sid;
    const declarations = [
      request.vehicleText ? { field: 'VEICULO', value: request.vehicleText, json: {} } : null,
      request.paymentText ? { field: 'PAGAMENTO', value: request.paymentText, json: {} } : null,
      request.deadlineText ? { field: 'PRAZO', value: request.deadlineText, json: {} } : null
    ].filter(Boolean);

    for (const declaration of declarations) {
      const already = await rows(ctx, 'journey_declarations', {
        select: 'id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id,
        field: 'eq.' + declaration.field, source: 'eq.CALCULATOR', calc_sid: 'eq.' + declarationSid,
        calc_ref: 'eq.' + ref, limit: '1'
      });
      if (already[0]) continue;
      const previous = await rows(ctx, 'journey_declarations', {
        select: 'id,value_text,value_json', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id,
        field: 'eq.' + declaration.field, order: 'declared_at.desc', limit: '1'
      });
      const created = await insert(ctx, 'journey_declarations', {
        environment: ctx.environment, journey_id: journey.id, field: declaration.field,
        source: 'CALCULATOR', value_text: declaration.value, value_json: declaration.json,
        message_id: null, calc_sid: declarationSid, calc_ref: ref,
        declared_at: request.occurredAt || at, created_at: at, created_by: ctx.panel.id
      });
      if (previous[0] && declarationKey(declaration.field, previous[0].value_text, previous[0].value_json) !== declarationKey(declaration.field, declaration.value, declaration.json)) {
        await insert(ctx, 'journey_divergences', {
          environment: ctx.environment, journey_id: journey.id, field: declaration.field,
          left_declaration_id: previous[0].id, right_declaration_id: created[0].id,
          status: 'OPEN', created_at: at
        }, false);
      }
    }
  }

  const latest = ordered[0];
  const fill = { updated_at: at, updated_by: ctx.panel.id };
  if (!journey.vehicle_text && latest.vehicleText) fill.vehicle_text = latest.vehicleText;
  if (!journey.budget_cents && latest.budgetCents) fill.budget_cents = latest.budgetCents;
  if (!journey.payment_text && latest.paymentText) fill.payment_text = latest.paymentText;
  if (!journey.customer_deadline_text && latest.deadlineText) fill.customer_deadline_text = latest.deadlineText;
  const criteria = journey.criteria_json && typeof journey.criteria_json === 'object' && !Array.isArray(journey.criteria_json) ? journey.criteria_json : {};
  const existingWishlists = wishlistsForJourney({ criteria_json: criteria });
  const mergedWishlists = mergeWishlists(existingWishlists, allWishlists);
  if (JSON.stringify(mergedWishlists) !== JSON.stringify(existingWishlists)) {
    const { wishlist: _legacyWishlist, ...criteriaWithoutLegacy } = criteria;
    fill.criteria_json = { ...criteriaWithoutLegacy, wishlists: mergedWishlists };
  }
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, fill);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'CALCULATOR_REQUEST_LINKED', summary: 'Ref da calculadora ligada à jornada',
    metadata: { calc_ref: ref, simulations: requests.length, modes: requests.map((item) => item.logicalMode) },
    entityType: 'calculator_request_link', entityId: linkedIds[0] || journey.id, action: 'LINK_REF',
    after: { calc_ref: ref, journey_id: journey.id, simulations: requests.length }
  });
  return send(ctx.res, 200, { ids: linkedIds, status: 'LINKED', simulations: requests.length });
}

async function actionUnit(ctx, journey, body) {
  if (!journeyEnabled(journey)) return send(ctx.res, 409, { error: 'JOURNEY_DISABLED' });
  const at = isoNow();
  let unitId = body.unitId;
  let status = String(body.status || 'PRESENTED');
  if (!['PRESENTED', 'UNDER_REVIEW', 'ACCEPTED', 'DECLINED', 'WITHDRAWN'].includes(status)) return send(ctx.res, 400, { error: 'UNIT_STATUS_INVALID' });
  if (unitId) {
    if (!isUuid(unitId)) return send(ctx.res, 400, { error: 'UNIT_ID_INVALID' });
    const found = await rows(ctx, 'units', { select: 'id,status', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + unitId, limit: '1' });
    if (!found[0]) return send(ctx.res, 404, { error: 'UNIT_NOT_FOUND' });
    const decline = status === 'DECLINED' ? safeText(body.declineReason, 500, true) : null;
    if (status === 'DECLINED' && !decline) return send(ctx.res, 400, { error: 'DECLINE_REASON_REQUIRED' });
    await patchRows(ctx, 'units', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + unitId }, {
      status, decline_reason: decline,
      ...(body.customerResponded === true ? { last_customer_response_at: at } : {}),
      updated_at: at, updated_by: ctx.panel.id
    });
  } else {
    let vehicle = safeText(body.vehicleText, 500, true);
    let details = {};
    let match = null;
    if (body.manheimMatchId) {
      if (!isUuid(body.manheimMatchId)) return send(ctx.res, 400, { error: 'MANHEIM_MATCH_ID_INVALID' });
      // A match of an undone import batch is never presented.
      const matches = await rows(ctx, 'manheim_matches', {
        select: 'id,upload_id,undone_at,vehicle_json,presented_unit_id', environment: 'eq.' + ctx.environment,
        journey_id: 'eq.' + journey.id, id: 'eq.' + body.manheimMatchId, ...(await activeFilter(ctx, { rows })), limit: '1'
      });
      match = matches[0];
      // ...and never one of a batch still being assembled.
      if (!match || !(await matchIsLive(ctx, match, { rows }))) return send(ctx.res, 404, { error: 'MANHEIM_MATCH_NOT_FOUND' });
      if (match.presented_unit_id) return send(ctx.res, 200, { unitId: match.presented_unit_id, status: 'PRESENTED', stage: journey.stage, repeated: true });
      const parsed = match.vehicle_json && match.vehicle_json.parsed || {};
      // MMR is mandatory: a car without a valid MMR is never presented as an option.
      if (!vehicleMatchRule.hasValidMmr(parsed)) return send(ctx.res, 409, { error: 'MANHEIM_MATCH_WITHOUT_MMR' });
      vehicle = safeText([parsed.year, parsed.make, parsed.model, parsed.trim].filter(Boolean).join(' '), 500, true);
      details = {
        manheim_match_id: match.id, miles: finiteInteger(parsed.miles), location: safeText(parsed.location, 200) || null,
        sale_date: safeText(parsed.saleDate, 100) || null, mmr_cents: finiteInteger(parsed.mmrCents),
        exterior_color: safeText(parsed.exteriorColor, 120) || null, buy_now_price: safeText(parsed.buyNowPrice, 120) || null,
        condition_report_grade: safeText(parsed.conditionGrade, 120) || null
      };
    }
    if (!vehicle) return send(ctx.res, 400, { error: 'UNIT_VEHICLE_REQUIRED' });
    const created = await insert(ctx, 'units', { environment: ctx.environment, journey_id: journey.id, vehicle_text: vehicle, details_json: details, presented_at: at, status, created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id });
    unitId = created[0].id;
    if (match) await patchRows(ctx, 'manheim_matches', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + match.id }, { presented_unit_id: unitId });
  }
  const units = await allRows(ctx, 'units', { select: 'id,status', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id });
  const stage = nextStageForUnits(journey.stage, units);
  // A10: presenting a car starts the search (only forward); the first presentation dates it.
  const searchStart = !journey.search_started_at && units.some((item) => item.status !== 'WITHDRAWN') ? { search_started_at: at } : {};
  if (stage !== journey.stage || searchStart.search_started_at) await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { stage, ...searchStart, updated_at: at, updated_by: ctx.panel.id });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'UNIT_UPDATED', summary: 'Unidade apresentada atualizada', metadata: { unit_id: unitId, status, customer_responded: body.customerResponded === true },
    entityType: 'unit', entityId: unitId, action: 'UPSERT', after: { status, stage }
  });
  return send(ctx.res, 200, { unitId, status, stage });
}

async function actionResolveDivergence(ctx, journey, body) {
  if (!isUuid(body.divergenceId) || !isUuid(body.declarationId)) return send(ctx.res, 400, { error: 'DIVERGENCE_RESOLUTION_INVALID' });
  const divergence = await rows(ctx, 'journey_divergences', { select: 'id,field,left_declaration_id,right_declaration_id,status', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.divergenceId, limit: '1' });
  const declaration = await rows(ctx, 'journey_declarations', { select: 'id,field', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.declarationId, limit: '1' });
  if (!divergence[0] || !declaration[0] || divergence[0].field !== declaration[0].field) return send(ctx.res, 404, { error: 'DIVERGENCE_NOT_FOUND' });
  const at = isoNow();
  await patchRows(ctx, 'journey_divergences', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.divergenceId }, { operational_declaration_id: body.declarationId, status: 'RESOLVED', resolved_at: at, resolved_by: ctx.panel.id });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'DIVERGENCE_RESOLVED', summary: 'Divergência resolvida', metadata: { field: divergence[0].field, declaration_id: body.declarationId },
    entityType: 'journey_divergence', entityId: body.divergenceId, action: 'RESOLVE', after: { status: 'RESOLVED', operational_declaration_id: body.declarationId }
  });
  return send(ctx.res, 200, { status: 'RESOLVED' });
}

async function actionInteraction(ctx, journey, body) {
  const type = String(body.interactionType || '');
  if (!['OUTBOUND_MESSAGE', 'CALL_ANSWERED', 'CALL_ATTEMPT', 'IN_PERSON'].includes(type)) return send(ctx.res, 400, { error: 'INTERACTION_TYPE_INVALID' });
  const detail = safeText(body.detail, 500) || null;
  const at = isoNow();
  await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, type, occurred_at: at, detail_text: detail, created_at: at, created_by: ctx.panel.id }, false);
  const effective = type !== 'CALL_ATTEMPT';
  if (effective) {
    const stage = journey.stage === 'NOVO' ? 'RESPONDIDO' : journey.stage;
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { stage, last_effective_contact_at: at, next_action_missing_since: journey.next_action_at ? null : at, updated_at: at, updated_by: ctx.panel.id });
    await cancelSuppressions(ctx, journey.id, at);
  }
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: type, summary: effective ? 'Contato efetivo registrado' : 'Tentativa de contato registrada', metadata: { effective },
    entityType: 'interaction', entityId: null, action: 'CREATE', after: { type, effective }
  });
  return send(ctx.res, 201, { type, effective });
}



async function actionToggleJourney(ctx, journey, body) {
  if (typeof body.enabled !== 'boolean') return send(ctx.res, 400, { error: 'JOURNEY_SWITCH_INVALID' });
  if (!body.enabled && !journeyEnabled(journey)) return send(ctx.res, 409, { error: 'JOURNEY_ALREADY_DISABLED' });
  if (body.enabled && journey.status === 'ENCERRADO' && journey.closed_reason === 'WHATSAPP_LINKED') return send(ctx.res, 409, { error: 'JOURNEY_MERGED' });
  const reason = body.reason === null || body.reason === undefined || body.reason === '' ? null : String(body.reason);
  if (reason && !['MCS_PURCHASE', 'OTHER_PURCHASE', 'GAVE_UP', 'NO_RESPONSE'].includes(reason)) return send(ctx.res, 400, { error: 'JOURNEY_SWITCH_REASON_INVALID' });
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_set_journey_enabled', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      p_environment: ctx.environment, p_journey_id: journey.id, p_enabled: body.enabled,
      p_reason: reason, p_actor_id: ctx.panel.id
    })
  });
  return send(ctx.res, 200, result);
}

async function actionReturn(ctx, journey, body) {
  const kind = String(body.returnKind || '');
  const operation = String(body.operation || '');
  if (!['COMPLETE', 'REMOVE'].includes(operation)) return send(ctx.res, 400, { error: 'RETURN_OPERATION_INVALID' });
  if (kind === 'NEXT_ACTION') return actionNext(ctx, journey, { ...body, operation });
  if (kind !== 'PROMISE' || !isUuid(body.returnId)) return send(ctx.res, 400, { error: 'RETURN_INVALID' });
  const found = await rows(ctx, 'promises', { select: 'id,status', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.returnId, limit: '1' });
  if (!found[0]) return send(ctx.res, 404, { error: 'RETURN_NOT_FOUND' });
  const status = operation === 'COMPLETE' ? 'FULFILLED' : 'CANCELLED';
  const at = isoNow();
  await patchRows(ctx, 'promises', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.returnId }, { status, fulfilled_at: operation === 'COMPLETE' ? at : null });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: operation === 'COMPLETE' ? 'PROMISE_FULFILLED' : 'PROMISE_REMOVED',
    summary: operation === 'COMPLETE' ? 'Retorno concluído' : 'Retorno removido', metadata: {},
    entityType: 'promise', entityId: body.returnId, action: operation,
    before: { status: found[0].status }, after: { status }
  });
  return send(ctx.res, 200, { status });
}

// OpenAI for ambiguous CSV rows only (server side; the key never reaches the browser). When it
// is off or fails, the browser keeps importing the valid rows and sends only these to review.
// Every OpenAI call of the CSV reading is recorded on the server (provider, model, tokens, cost,
// row count), whether or not the browser later sends its batch summary. Never a cell or a prompt.
// US$ 50 for all the panel's OpenAI features together; a failed read of the spend blocks the call.
async function openAiFits(ctx) { try { return openAiBudget.fits(await openAiBudget.spentUsd(ctx)); } catch (_) { return false; } }
async function recordManheimAiCall(ctx, action, result, rowsSent, failure) {
  await insert(ctx, 'audit_log', { environment: ctx.environment, actor_user_id: ctx.panel.id, entity_type: 'manheim_openai', entity_id: null, action,
    after_json: { provider: 'openai', model: result ? result.model : manheimAi.model(), inputTokens: result ? result.usage.inputTokens : 0, outputTokens: result ? result.usage.outputTokens : 0,
      costUsd: result ? result.costUsd : 0, rowsSent, ms: result ? result.ms : null, errorCode: failure ? failure.code || 'OPENAI_FAILED' : null } }, false).catch(() => null);
}

async function actionManheimAiRows(ctx, body) {
  if (body.headerMap) {
    const input = manheimAi.sanitizeHeaders(body.headerMap);
    if (!input) return send(ctx.res, 400, { error: 'MANHEIM_AI_INVALID' });
    if (!manheimAi.enabled()) return send(ctx.res, 200, { available: false, reason: 'OPENAI_NOT_ENABLED', mapping: null });
    if (!(await openAiFits(ctx))) return send(ctx.res, 200, { available: false, reason: 'PROVIDER_LIMIT', mapping: null });
    try { const result = await manheimAi.suggestHeaders(input); await recordManheimAiCall(ctx, 'AI_HEADERS', result, 0); return send(ctx.res, 200, { available: true, provider: 'openai', ...result }); }
    catch (failure) { await recordManheimAiCall(ctx, 'AI_HEADERS', null, 0, failure); return send(ctx.res, 200, { available: false, reason: failure && failure.code || 'OPENAI_FAILED', mapping: null }); }
  }
  const rowsIn = manheimAi.sanitizeRows(body.rows);
  if (!rowsIn) return send(ctx.res, 400, { error: 'MANHEIM_AI_INVALID' });
  if (!manheimAi.enabled()) return send(ctx.res, 200, { available: false, reason: 'OPENAI_NOT_ENABLED', suggestions: [] });
  if (!(await openAiFits(ctx))) return send(ctx.res, 200, { available: false, reason: 'PROVIDER_LIMIT', suggestions: [] });
  try {
    const result = await manheimAi.suggestRows(rowsIn);
    await recordManheimAiCall(ctx, 'AI_ROWS', result, rowsIn.length);
    return send(ctx.res, 200, { available: true, provider: 'openai', ...result });
  } catch (failure) {
    await recordManheimAiCall(ctx, 'AI_ROWS', null, rowsIn.length, failure);
    return send(ctx.res, 200, { available: false, reason: failure && failure.code || 'OPENAI_FAILED', suggestions: [] });
  }
}

// The OpenAI summary of a batch, stored on the batch itself (no new table, no prompt).
async function actionManheimAiSummary(ctx, body) {
  if (!isUuid(body.uploadId)) return send(ctx.res, 400, { error: 'MANHEIM_AI_INVALID' });
  if (!(await undoSupported(ctx, { rows }))) return send(ctx.res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
  const summary = manheimAi.sanitizeSummary(body.summary);
  const found = await rows(ctx, 'manheim_uploads', { select: 'id,ai_summary_json', environment: 'eq.' + ctx.environment, id: 'eq.' + body.uploadId, limit: '1' });
  if (!found[0]) return send(ctx.res, 404, { error: 'MANHEIM_UPLOAD_NOT_FOUND' });
  await patchRows(ctx, 'manheim_uploads', { environment: 'eq.' + ctx.environment, id: 'eq.' + body.uploadId }, { ai_summary_json: summary });
  await insert(ctx, 'audit_log', { environment: ctx.environment, actor_user_id: ctx.panel.id, entity_type: 'manheim_upload', entity_id: body.uploadId, action: 'AI_SUMMARY', before_json: found[0].ai_summary_json || null, after_json: summary, created_at: isoNow() }, false);
  return send(ctx.res, 200, { saved: true, summary });
}

// Undo of one import batch: transactional and idempotent in the database. Nothing is deleted.
async function actionManheimUndo(ctx, body) {
  if (!isUuid(body.uploadId)) return send(ctx.res, 400, { error: 'MANHEIM_UNDO_INVALID' });
  if (!(await undoSupported(ctx, { rows }))) return send(ctx.res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
  try {
    const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_undo_manheim_upload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: body.uploadId })
    });
    return send(ctx.res, 200, result);
  } catch (failure) {
    if (failure && failure.code === 'MANHEIM_UPLOAD_NOT_FOUND') return send(ctx.res, 404, { error: failure.code });
    if (failure && failure.status === 404) return send(ctx.res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
    throw failure;
  }
}

// "Revisar tipo de busca": the operator defines CARRO or VALOR for a ficha whose mode is not
// known. Only that demand changes; the ficha's other demand stays as it is. Operator, time,
// previous and new value go to activity_log and audit_log.
async function actionSetSearchMode(ctx, journey, body) {
  const mode = String(body.mode || '').toUpperCase();
  if (!SEARCH_MODES.includes(mode)) return send(ctx.res, 400, { error: 'SEARCH_MODE_INVALID' });
  const [current] = await rows(ctx, 'journeys', { select: 'id,criteria_json', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id, limit: '1' });
  if (!current) return send(ctx.res, 404, { error: 'JOURNEY_NOT_FOUND' });
  const criteria = current.criteria_json && typeof current.criteria_json === 'object' && !Array.isArray(current.criteria_json) ? current.criteria_json : {};
  const before = confirmedJourneyModes(current);
  if (before.includes(mode)) return send(ctx.res, 200, { journeyId: journey.id, modes: before, unchanged: true });
  const after = SEARCH_MODES.filter((value) => before.includes(value) || value === mode);
  const at = isoNow();
  // The first mode the operator defines owns the ficha's manual criteria from now on
  // (mode_overrides), so a second mode added later never inherits them.
  const overrides = criteria.mode_overrides && typeof criteria.mode_overrides === 'object' && !Array.isArray(criteria.mode_overrides) ? criteria.mode_overrides : {};
  const generic = wishlistsForJourney(current);
  const claim = !before.length && !Object.keys(overrides).length && (generic.length || criteria.wishlistOverride === true)
    ? { mode_overrides: { ...overrides, [mode]: { wishlists: generic, wishlistOverride: criteria.wishlistOverride === true } } } : {};
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { criteria_json: { ...criteria, ...claim, logical_modes: after }, updated_at: at, updated_by: ctx.panel.id });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, activityType: 'SEARCH_MODE_DEFINED', summary: `Tipo de busca definido: ${mode}`,
    metadata: { before, after, mode }, entityType: 'journey', entityId: journey.id, action: 'SET_SEARCH_MODE',
    before: { logical_modes: before }, after: { logical_modes: after }
  });
  return send(ctx.res, 200, { journeyId: journey.id, modes: after });
}

// "Revisar tipo de busca" for a manual criterion saved without mode on a ficha with two modes:
// the operator says which mode it belongs to. It moves to mode_overrides[mode] and leaves the
// generic list; the other mode is not touched. Operator, time, before and after are audited.
async function actionAssignManualMode(ctx, journey, body) {
  const mode = String(body.mode || '').toUpperCase();
  if (!SEARCH_MODES.includes(mode)) return send(ctx.res, 400, { error: 'SEARCH_MODE_INVALID' });
  const [current] = await rows(ctx, 'journeys', { select: 'id,criteria_json', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id, limit: '1' });
  if (!current) return send(ctx.res, 404, { error: 'JOURNEY_NOT_FOUND' });
  const criteria = current.criteria_json && typeof current.criteria_json === 'object' && !Array.isArray(current.criteria_json) ? current.criteria_json : {};
  const generic = wishlistsForJourney(current);
  if (!generic.length && criteria.wishlistOverride !== true) return send(ctx.res, 200, { journeyId: journey.id, unchanged: true });
  const overrides = criteria.mode_overrides && typeof criteria.mode_overrides === 'object' && !Array.isArray(criteria.mode_overrides) ? criteria.mode_overrides : {};
  const own = overrides[mode] && Array.isArray(overrides[mode].wishlists) ? overrides[mode].wishlists : [];
  const nextOverride = { wishlists: mergeWishlists(generic, own).slice(0, 5), wishlistOverride: true };
  const { wishlist: _legacy, wishlistOverride: _generic, ...rest } = criteria;
  const next = { ...rest, wishlists: [], mode_overrides: { ...overrides, [mode]: nextOverride } };
  const at = isoNow();
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { criteria_json: next, updated_at: at, updated_by: ctx.panel.id });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, activityType: 'MANUAL_CRITERIA_MODE_DEFINED', summary: `Critério manual atribuído a ${mode}`,
    metadata: { mode, wishes: generic.length }, entityType: 'journey', entityId: journey.id, action: 'ASSIGN_MANUAL_MODE',
    before: { wishlists: generic, mode_overrides: overrides }, after: { wishlists: [], mode_overrides: next.mode_overrides }
  });
  return send(ctx.res, 200, { journeyId: journey.id, mode });
}

// The old import in parts (manheim_upload_part) and the separate car archive (manheim_archive)
// were replaced by the single batch in blocks (api/panel/manheim-batch.js): the old path read the
// whole panel base again for every part. An old tab that still calls them gets a clear answer.
const RETIRED_MANHEIM_ACTIONS = new Set(['manheim_upload_part', 'manheim_archive']);

async function personDispositionKeys(ctx, itemKind, itemKey) {
  const ref = itemKind === 'REF' ? itemKey.toUpperCase() : null;
  let journeyIds = itemKind === 'JOURNEY' ? [itemKey] : [];
  if (ref) {
    const [owners, linked] = await Promise.all([
      rows(ctx, 'journeys', { select: 'id', environment: 'eq.' + ctx.environment, reference_code: 'eq.' + ref }),
      rows(ctx, 'journey_refs', { select: 'journey_id', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + ref })
    ]);
    journeyIds = [...new Set([...owners.map((row) => row.id), ...linked.map((row) => row.journey_id)])];
  }
  const refs = new Set(ref ? [ref] : []);
  for (const id of journeyIds) {
    const [own, linked] = await Promise.all([
      rows(ctx, 'journeys', { select: 'reference_code', environment: 'eq.' + ctx.environment, id: 'eq.' + id, limit: '1' }),
      rows(ctx, 'journey_refs', { select: 'ref_code', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id })
    ]);
    [own[0]?.reference_code, ...linked.map((row) => row.ref_code)].filter(Boolean).forEach((value) => refs.add(String(value).trim().toUpperCase()));
  }
  return [...journeyIds.map((key) => ({ kind: 'JOURNEY', key })), ...[...refs].map((key) => ({ kind: 'REF', key }))];
}

async function actionDisposition(ctx, body) {
  const itemKind = String(body.itemKind || '');
  const itemKey = safeText(body.itemKey, 200, true);
  const requestedStatus=Object.prototype.hasOwnProperty.call(body,'previousStatus')?body.previousStatus:body.status;
  const status = requestedStatus === null || requestedStatus === '' ? null : String(requestedStatus || '');
  const requestedReason=Object.prototype.hasOwnProperty.call(body,'previousStatus')?body.previousReason:body.reason;
  const discardReason=status==='DISCARDED'?(requestedReason===null||requestedReason===''?'OTHER':String(requestedReason||'')):null;
  const allowedReasons=new Set(['PRICE','DISAPPEARED','BOUGHT_ELSEWHERE','NO_CREDIT','CURIOSITY','OTHER']);
  if (!['REF', 'JOURNEY'].includes(itemKind) || !itemKey || (status && !['TREATED', 'DISCARDED'].includes(status))) {
    return send(ctx.res, 400, { error: 'DISPOSITION_INVALID' });
  }
  if (itemKind === 'REF' && !REF_RE.test(itemKey.toUpperCase())) return send(ctx.res, 400, { error: 'DISPOSITION_INVALID' });
  if (itemKind === 'JOURNEY' && !isUuid(itemKey)) return send(ctx.res, 400, { error: 'DISPOSITION_INVALID' });
  if(status==='DISCARDED'&&!allowedReasons.has(discardReason))return send(ctx.res,400,{error:'DISPOSITION_REASON_INVALID'});
  const at = isoNow();
  if (!status) {
    // A8: "Voltar para pendente" clears the person (ficha + every linked Ref), because the lists
    // show the most recent disposition of any of them.
    const keys = await personDispositionKeys(ctx, itemKind, itemKey);
    for (const key of keys) {
      const path = '/rest/v1/panel_item_dispositions?environment=eq.' + ctx.environment + '&item_kind=eq.' + key.kind + '&item_key=eq.' + encodeURIComponent(key.key) + '&cleared_at=is.null';
      await supabase(ctx.config.url, ctx.config.secretKey, path, { method: 'PATCH', headers: { 'content-type':'application/json',prefer: 'return=minimal' },body:JSON.stringify({cleared_at:at,cleared_by:ctx.panel.id,updated_at:at,updated_by:ctx.panel.id}) });
    }
    return send(ctx.res, 200, { status: null });
  }
  await supabase(ctx.config.url, ctx.config.secretKey,
    '/rest/v1/panel_item_dispositions?on_conflict=environment,item_kind,item_key',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ environment: ctx.environment, item_kind: itemKind, item_key: itemKey, status, discard_reason:status==='DISCARDED'?discardReason:null, cleared_at:null,cleared_by:null,updated_at: at, updated_by: ctx.panel.id })
    });
  return send(ctx.res, 200, { status, discardReason:status==='DISCARDED'?discardReason:null, updatedAt: at });
}

async function actionInvertSenders(ctx, journey, body) {
  if (!isUuid(body.chatId)) return send(ctx.res, 400, { error: 'CHAT_ID_INVALID' });
  const links = await allRows(ctx, 'message_journeys', {
    select: 'message_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, undone_at:'is.null'
  });
  const linked = new Set(links.map((item) => item.message_id));
  const chatMessages = await rows(ctx, 'messages', {
    select: 'id', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + body.chatId, limit: '200'
  });
  if (!chatMessages.some((item) => linked.has(item.id))) return send(ctx.res, 404, { error: 'CHAT_NOT_IN_JOURNEY' });
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_invert_chat_senders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_environment: ctx.environment, p_chat_id: body.chatId, p_actor_id: ctx.panel.id })
  });
  return send(ctx.res, 200, result);
}

const REMOVED_ACTIONS = new Set(['suppress', 'start_search', 'checklist_evidence', 'declaration', 'fulfill_promise', 'set_status', 'close_journey', 'manheim_upload']);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  try {
    const body = await jsonBody(req, 2 * 1024 * 1024);
    if (RETIRED_MANHEIM_ACTIONS.has(body.action)) return send(ctx.res, 410, { error: 'MANHEIM_FLOW_REPLACED' });
    if (body.action === 'manheim_undo') return await actionManheimUndo(ctx, body);
    if (body.action === 'manheim_ai_rows') return await actionManheimAiRows(ctx, body);
    if (body.action === 'manheim_ai_summary') return await actionManheimAiSummary(ctx, body);
    if (body.action === 'set_disposition') return await actionDisposition(ctx, body);
    // Lote 4: actions no screen, cron, webhook or database ever called (proved before removal).
    // They answer as invalid without touching the database.
    if (REMOVED_ACTIONS.has(body.action)) return send(res, 400, { error: 'PANEL_ACTION_INVALID' });
    const journey = await journeyContext(ctx, body.journeyId);
    if (!journey) return send(res, 404, { error: 'JOURNEY_NOT_FOUND' });
    switch (body.action) {
      case 'next_action': return await actionNext(ctx, journey, body);
      case 'mark_message': return await actionMarkMessage(ctx, journey, body);
      case 'update_note': return await actionNote(ctx, journey, body);
      case 'set_funnel': return await actionFunnel(ctx, journey, body);
      case 'promise': return await actionPromise(ctx, journey, body);
      case 'client_ok': return await actionClientOk(ctx, journey, body);
      case 'link_request': return await actionLinkRequest(ctx, journey, body);
      case 'unit': return await actionUnit(ctx, journey, body);
      case 'resolve_divergence': return await actionResolveDivergence(ctx, journey, body);
      case 'interaction': return await actionInteraction(ctx, journey, body);
      case 'toggle_journey': return await actionToggleJourney(ctx, journey, body);
      case 'return_update': return await actionReturn(ctx, journey, body);
      case 'invert_senders': return await actionInvertSenders(ctx, journey, body);
      case 'set_search_mode': return await actionSetSearchMode(ctx, journey, body);
      case 'assign_manual_mode': return await actionAssignManualMode(ctx, journey, body);
      default: return send(res, 400, { error: 'PANEL_ACTION_INVALID' });
    }
  } catch (failure) {
    if (failure && failure.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    // Lifecycle rules enforced by the database answer with their own code, not a generic 500.
    if (['JOURNEY_FROZEN', 'JOURNEY_CLOSED', 'JOURNEY_MERGED', 'JOURNEY_NOT_FOUND'].includes(failure?.code)) return send(res, 409, { error: failure.code });
    return send(res, 500, { error: 'PANEL_ACTION_FAILED' });
  }
};

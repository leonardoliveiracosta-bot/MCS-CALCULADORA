'use strict';

const {
  clientOkPatch, consolidateCalcRuns, effectiveCriteria, finiteInteger, groupCalculatorByRef, journeyEnabled, matchManheimOrder, matchManheimVehicle,
  mergeWishlists, nextStageForUnits, reactivationEligible, REF_RE, toggleEnabled, time, wishlistsForJourney, wishlistText
} = require('../../panel-domain');
const { journeyExists, messageForJourney } = require('../../panel-read-model');
const vehicleCatalog = require('../../vehicle-catalog');
const { parseMoneyCents } = require('../../money-text');
const { localToUtc, timezoneForZip } = require('../../panel-lead');
const {
  allRows, insert, isUuid, jsonBody, patchRows, recordMutation, requirePanel,
  rows, safeText, send, supabase
} = require('../../panel-server');

const TODAY_KINDS = new Set(['NO_RESPONSE', 'NEXT_ACTION', 'MISSING_NEXT_ACTION', 'DIVERGENCE', 'PROMISE', 'SEARCH_STALLED', 'UNIT_NO_RESPONSE']);
const isoNow = () => new Date().toISOString();

function safeWishlist(value, requireVehicle = false) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const make = safeText(source.make, 80) || '';
  const model = safeText(source.model, 120) || '';
  const yearMin = finiteInteger(source.yearMin);
  const yearMax = finiteInteger(source.yearMax);
  const maxMiles = finiteInteger(source.maxMiles);
  const maximumYear = new Date().getUTCFullYear() + 2;
  if ((requireVehicle && !model)
      || (yearMin !== null && (yearMin < 1900 || yearMin > maximumYear))
      || (yearMax !== null && (yearMax < 1900 || yearMax > maximumYear))
      || (yearMin && yearMax && yearMin > yearMax)
      || (maxMiles !== null && (maxMiles < 0 || maxMiles > 2000000))) return null;
  return { make, model, yearMin, yearMax, maxMiles };
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

async function actionSuppression(ctx, journey, body) {
  const kind = String(body.kind || '');
  const action = String(body.suppressionAction || '');
  if (!TODAY_KINDS.has(kind) || !['DEFER', 'DISMISS'].includes(action)) return send(ctx.res, 400, { error: 'SUPPRESSION_INVALID' });
  let untilAt = null;
  if (action === 'DEFER') {
    const due = time(body.untilAt);
    if (!due || due <= Date.now()) return send(ctx.res, 400, { error: 'SUPPRESSION_DATE_INVALID' });
    untilAt = new Date(due).toISOString();
  }
  const reason = safeText(body.reason, 500) || null;
  const at = isoNow();
  const created = await insert(ctx, 'journey_alert_suppressions', {
    environment: ctx.environment, journey_id: journey.id, kind, action,
    until_at: untilAt, reason_text: reason, created_at: at, created_by: ctx.panel.id
  });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'TODAY_ALERT_' + action, summary: action === 'DEFER' ? 'Alerta adiado' : 'Alerta dispensado',
    metadata: { kind, until_at: untilAt }, entityType: 'journey_alert_suppression',
    entityId: created[0].id, action, after: { kind, action, until_at: untilAt }
  });
  return send(ctx.res, 201, { id: created[0].id, status: action });
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

async function actionStartSearch(ctx, journey) {
  if (journey.stage_frozen || journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_FROZEN' });
  const at = isoNow();
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, {
    stage: 'EM_BUSCA', search_started_at: journey.search_started_at || at,
    updated_at: at, updated_by: ctx.panel.id
  });
  await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, type: 'SEARCH_STARTED', occurred_at: at, detail_text: null, created_at: at, created_by: ctx.panel.id }, false);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'SEARCH_STARTED', summary: 'Busca iniciada', metadata: {},
    entityType: 'journey', entityId: journey.id, action: 'SEARCH_STARTED',
    before: { stage: journey.stage }, after: { stage: 'EM_BUSCA', search_started_at: journey.search_started_at || at }
  });
  return send(ctx.res, 200, { stage: 'EM_BUSCA', searchStartedAt: journey.search_started_at || at });
}

async function customerMessage(ctx, journey, messageId) {
  if (!isUuid(messageId)) return null;
  const message = await messageForJourney(ctx, journey.id, messageId);
  return message && message.direction === 'CUSTOMER' ? message : null;
}

async function actionEvidence(ctx, journey, body) {
  const point = Number(body.pointNumber);
  const message = await customerMessage(ctx, journey, body.messageId);
  if (!message || !Number.isInteger(point) || point < 1 || point > 6) return send(ctx.res, 400, { error: 'EVIDENCE_INVALID' });
  const points = await rows(ctx, 'journey_checklist', { select: 'id,status', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, point_number: 'eq.' + point, limit: '1' });
  if (!points[0]) return send(ctx.res, 404, { error: 'CHECKLIST_POINT_NOT_FOUND' });
  const existing = await rows(ctx, 'checklist_evidence', { select: 'id', environment: 'eq.' + ctx.environment, checklist_id: 'eq.' + points[0].id, message_id: 'eq.' + message.id, limit: '1' });
  const at = isoNow();
  let evidenceId = existing[0] && existing[0].id;
  if (!evidenceId) {
    const created = await insert(ctx, 'checklist_evidence', {
      environment: ctx.environment, checklist_id: points[0].id, message_id: message.id,
      excerpt_text: String(message.body_text).slice(0, 1000), created_at: at, created_by: ctx.panel.id
    });
    evidenceId = created[0].id;
  }
  await patchRows(ctx, 'journey_checklist', { environment: 'eq.' + ctx.environment, id: 'eq.' + points[0].id }, { status: 'COMPLETE', completed_at: at, updated_at: at });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, chatId: message.chat_id,
    activityType: 'CHECKLIST_EVIDENCE_ADDED', summary: 'Evidência adicionada ao checklist', metadata: { point_number: point, message_id: message.id },
    entityType: 'checklist_evidence', entityId: evidenceId, action: 'CREATE', after: { point_number: point, message_id: message.id }
  });
  return send(ctx.res, 201, { evidenceId, pointNumber: point, status: 'COMPLETE' });
}

async function actionDeclaration(ctx, journey, body) {
  const field = String(body.field || '');
  const value = safeText(body.value, 500, true);
  const message = await customerMessage(ctx, journey, body.messageId);
  if (!message || !['TETO', 'VEICULO', 'PAGAMENTO', 'PRAZO'].includes(field) || !value) return send(ctx.res, 400, { error: 'DECLARATION_INVALID' });
  const at = isoNow();
  const existing = await rows(ctx, 'journey_declarations', {
    select: 'id,value_text,value_json,source', environment: 'eq.' + ctx.environment,
    journey_id: 'eq.' + journey.id, field: 'eq.' + field, order: 'declared_at.desc', limit: '1'
  });
  const valueJson = {};
  if (field === 'TETO') {
    // TETO is the customer's total ceiling (R2): it never becomes the maximum bid.
    if (journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_CLOSED' });
    const ceilingCents = parseMoneyCents(value);
    if (ceilingCents === null) return send(ctx.res, 400, { error: 'CEILING_VALUE_INVALID' });
    valueJson.ceilingCents = ceilingCents;
  }
  const created = await insert(ctx, 'journey_declarations', {
    environment: ctx.environment, journey_id: journey.id, field, source: 'CONVERSATION',
    value_text: value, value_json: valueJson, message_id: message.id,
    declared_at: message.occurred_at_utc || message.created_at || at,
    created_at: at, created_by: ctx.panel.id
  });
  if (existing[0] && declarationKey(field, existing[0].value_text, existing[0].value_json) !== declarationKey(field, value, valueJson)) {
    const duplicate = await rows(ctx, 'journey_divergences', {
      select: 'id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id,
      field: 'eq.' + field, left_declaration_id: 'eq.' + existing[0].id,
      right_declaration_id: 'eq.' + created[0].id, limit: '1'
    });
    if (!duplicate[0]) await insert(ctx, 'journey_divergences', {
      environment: ctx.environment, journey_id: journey.id, field,
      left_declaration_id: existing[0].id, right_declaration_id: created[0].id,
      status: 'OPEN', created_at: at
    }, false);
  }
  const patch = { updated_at: at, updated_by: ctx.panel.id };
  if (field === 'VEICULO') patch.vehicle_text = value;
  if (field === 'PAGAMENTO') patch.payment_text = value;
  if (field === 'TETO') patch.confirmed_total_ceiling_cents = valueJson.ceilingCents;
  if (field === 'PRAZO') {
    patch.customer_deadline_text = value;
    if (time(body.deadlineAt)) patch.customer_deadline_at = new Date(time(body.deadlineAt)).toISOString();
  }
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, patch);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, chatId: message.chat_id,
    activityType: 'DECLARATION_RECORDED', summary: 'Declaração registrada', metadata: { field, message_id: message.id },
    entityType: 'journey_declaration', entityId: created[0].id, action: 'CREATE', after: { field, source: 'CONVERSATION', message_id: message.id }
  });
  return send(ctx.res, 201, { declarationId: created[0].id, field });
}

async function actionMarkMessage(ctx, journey, body) {
  const kind = String(body.kind || '');
  const config = {
    VEHICLE: { point: 1, field: 'VEICULO' }, BUDGET: { point: 2, field: 'TETO' },
    PAYMENT: { point: 3, field: 'PAGAMENTO' }, DEADLINE: { point: 4, field: 'PRAZO' },
    OUTSIDE_FLORIDA: { point: 5 }, NO_TEST_DRIVE: { point: 6 }
  }[kind];
  const message = await customerMessage(ctx, journey, body.messageId);
  if (!config || !message) return send(ctx.res, 400, { error: 'MESSAGE_MARK_INVALID' });
  const wishlists = kind === 'VEHICLE' ? safeWishlists(body.wishlists || body.wishlist, true) : null;
  if (kind === 'VEHICLE' && !wishlists) return send(ctx.res, 400, { error: 'WISHLIST_INVALID' });
  const value = safeText(kind === 'VEHICLE' ? wishlistText(wishlists) : body.value || message.body_text, kind === 'VEHICLE' ? 1200 : 500, true);
  if (config.field && !value) return send(ctx.res, 400, { error: 'MESSAGE_MARK_VALUE_INVALID' });
  const valueJson = wishlists ? { wishlist: { wishlists } } : {};
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
  return send(ctx.res, 200, config.field === 'TETO' ? { ...result, ceilingCents: valueJson.ceilingCents } : result);
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

async function actionFulfillPromise(ctx, journey, body) {
  if (!isUuid(body.promiseId)) return send(ctx.res, 400, { error: 'PROMISE_ID_INVALID' });
  const found = await rows(ctx, 'promises', { select: 'id,status', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.promiseId, limit: '1' });
  if (!found[0]) return send(ctx.res, 404, { error: 'PROMISE_NOT_FOUND' });
  const at = isoNow();
  await patchRows(ctx, 'promises', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.promiseId }, { status: 'FULFILLED', fulfilled_at: at });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'PROMISE_FULFILLED', summary: 'Promessa cumprida', metadata: {},
    entityType: 'promise', entityId: body.promiseId, action: 'FULFILL', before: { status: found[0].status }, after: { status: 'FULFILLED' }
  });
  return send(ctx.res, 200, { status: 'FULFILLED' });
}

async function actionClientOk(ctx, journey, body) {
  if (journey.stage_frozen || journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_FROZEN' });
  const message = await customerMessage(ctx, journey, body.messageId);
  if (!message) return send(ctx.res, 400, { error: 'CUSTOMER_OK_EVIDENCE_INVALID' });
  const at = isoNow();
  const openPoints = await rows(ctx, 'journey_checklist', { select: 'point_number', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, status: 'eq.OPEN' });
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { ...clientOkPatch(at, message.id), updated_by: ctx.panel.id });
  await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, message_id: message.id, type: 'JOURNEY_QUALIFIED', occurred_at: at, detail_text: null, created_at: at, created_by: ctx.panel.id }, false);
  await cancelSuppressions(ctx, journey.id, at);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, chatId: message.chat_id,
    activityType: 'CLIENT_GAVE_OK', summary: 'Cliente deu OK; jornada qualificada e encerrada',
    metadata: { evidence_message_id: message.id, open_checklist_points: openPoints.map((item) => item.point_number) },
    entityType: 'journey', entityId: journey.id, action: 'CLIENT_GAVE_OK',
    before: { stage: journey.stage, status: journey.status },
    after: { stage: 'QUALIFICADO', status: 'ENCERRADO', closed_reason: 'CLIENTE_DEU_OK', evidence_message_id: message.id }
  });
  await recordMessageMenuEvent(ctx,journey,body,'CLIENT_OK',isoNow());
  return send(ctx.res, 200, { stage: 'QUALIFICADO', status: 'ENCERRADO', closedReason: 'CLIENTE_DEU_OK', openChecklistPoints: openPoints.map((item) => item.point_number) });
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
      const matches = await rows(ctx, 'manheim_matches', {
        select: 'id,vehicle_json,presented_unit_id', environment: 'eq.' + ctx.environment,
        journey_id: 'eq.' + journey.id, id: 'eq.' + body.manheimMatchId, limit: '1'
      });
      match = matches[0];
      if (!match) return send(ctx.res, 404, { error: 'MANHEIM_MATCH_NOT_FOUND' });
      if (match.presented_unit_id) return send(ctx.res, 200, { unitId: match.presented_unit_id, status: 'PRESENTED', stage: journey.stage, repeated: true });
      const parsed = match.vehicle_json && match.vehicle_json.parsed || {};
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
  if (stage !== journey.stage) await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { stage, updated_at: at, updated_by: ctx.panel.id });
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

async function actionClose(ctx, journey, body) {
  if (journey.stage_frozen || journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_FROZEN' });
  const reason = safeText(body.reason, 500, true);
  if (!reason) return send(ctx.res, 400, { error: 'CLOSE_REASON_REQUIRED' });
  const at = isoNow();
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { status: 'ENCERRADO', closed_at: at, closed_reason: reason, stage_frozen: true, next_action_at: null, next_action_text: null, next_action_missing_since: null, updated_at: at, updated_by: ctx.panel.id });
  await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, type: 'JOURNEY_CLOSED', occurred_at: at, detail_text: null, created_at: at, created_by: ctx.panel.id }, false);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'JOURNEY_CLOSED', summary: 'Jornada encerrada', metadata: {},
    entityType: 'journey', entityId: journey.id, action: 'CLOSE', before: { status: journey.status }, after: { status: 'ENCERRADO' }
  });
  return send(ctx.res, 200, { status: 'ENCERRADO' });
}

async function actionSetStatus(ctx, journey, body) {
  const status = String(body.status || '');
  if (journey.stage_frozen || journey.status === 'ENCERRADO') return send(ctx.res, 409, { error: 'JOURNEY_FROZEN' });
  if (!['ATIVO', 'AGUARDANDO_CLIENTE', 'PARADO'].includes(status)) return send(ctx.res, 400, { error: 'JOURNEY_STATUS_INVALID' });
  const at = isoNow();
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { status, updated_at: at, updated_by: ctx.panel.id });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'JOURNEY_STATUS_CHANGED', summary: 'Status da jornada alterado', metadata: { status },
    entityType: 'journey', entityId: journey.id, action: 'STATUS_CHANGE', before: { status: journey.status }, after: { status }
  });
  return send(ctx.res, 200, { status });
}

async function actionToggleJourney(ctx, journey, body) {
  if (typeof body.enabled !== 'boolean') return send(ctx.res, 400, { error: 'JOURNEY_SWITCH_INVALID' });
  if (!body.enabled && !journeyEnabled(journey)) return send(ctx.res, 409, { error: 'JOURNEY_ALREADY_DISABLED' });
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

function safeManheimVehicle(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const parsedSource = source.parsed && typeof source.parsed === 'object' && !Array.isArray(source.parsed) ? source.parsed : {};
  const headers = Array.isArray(source.headers) ? source.headers.map((entry) => safeText(entry, 160, true)).filter(Boolean).slice(0, 100) : [];
  const rawSource = source.raw && typeof source.raw === 'object' && !Array.isArray(source.raw) ? source.raw : {};
  const raw = {};
  for (const header of headers) raw[header] = safeText(rawSource[header], 1000) || '';
  const parsed = {
    vin: safeText(parsedSource.vin, 40) || '',
    year: finiteInteger(parsedSource.year), make: safeText(parsedSource.make, 80) || '', model: safeText(parsedSource.model, 120, true),
    trim: safeText(parsedSource.trim, 120) || '', miles: finiteInteger(parsedSource.miles),
    location: safeText(parsedSource.location, 200) || '', saleDate: safeText(parsedSource.saleDate, 100) || '',
    locationDisplay: safeText(parsedSource.locationDisplay, 200) || '', mmrCents: finiteInteger(parsedSource.mmrCents),
    makeNotice: safeText(parsedSource.makeNotice, 160) || '', makeInferred: parsedSource.makeInferred === true,
    exteriorColor: safeText(parsedSource.exteriorColor, 120) || '', interiorColor: safeText(parsedSource.interiorColor, 120) || '',
    buyNowPrice: safeText(parsedSource.buyNowPrice, 120) || '', conditionGrade: safeText(parsedSource.conditionGrade, 120) || '', startsAt:safeText(parsedSource.startsAt,100)||safeText(parsedSource.saleDate,100)||'', endsAt:safeText(parsedSource.endsAt,100)||'', drivetrain:safeText(parsedSource.drivetrain,80)||'', transmission:safeText(parsedSource.transmission,80)||'', engine:safeText(parsedSource.engine,120)||'', cleanTitle:parsedSource.cleanTitle===true, odometerOk:parsedSource.odometerOk===true
  };
  // Unknown odometer stays null (R3e); it is never turned into 0 miles.
  if (!headers.length || !parsed.year || !parsed.model || (parsed.miles !== null && parsed.miles < 0)) return null;
  if (parsed.makeInferred) {
    const inferred = vehicleCatalog.inferMake(parsed.model);
    parsed.make = inferred.make;
    parsed.makeNotice = inferred.make ? '' : 'marca não informada no arquivo';
  }
  parsed.locationDisplay = vehicleCatalog.readableLocation(parsed.location);
  const output = { headers, raw, parsed };
  return Buffer.byteLength(JSON.stringify(output), 'utf8') <= 65536 ? output : null;
}

function manheimUploadHeader(body) {
  const fileCount = Number(body.sourceFileCount);
  const vehicleCount = Number(body.vehicleCount);
  const headers = Array.isArray(body.headers) ? body.headers.map((group) => Array.isArray(group) ? group.map((entry) => safeText(entry, 160, true)).filter(Boolean).slice(0, 100) : []).filter((group) => group.length).slice(0, 20) : [];
  const headerMap = body.headerMap && typeof body.headerMap === 'object' && !Array.isArray(body.headerMap) ? body.headerMap : {};
  const valid = Number.isInteger(fileCount) && fileCount >= 1 && fileCount <= 20 && Number.isInteger(vehicleCount) && vehicleCount >= 0 && vehicleCount <= 100000 && headers.length > 0;
  return valid ? { fileCount, vehicleCount, headers, headerMap } : null;
}

// Revalidates every requested match against the current journeys and calculator orders with
// the same rule the browser uses (vehicle-match.js, R3). A match that is no longer valid
// (criteria changed, ficha closed or switched off, Ref now linked to a ficha) is dropped and
// counted instead of failing the whole upload (A19).
async function validateManheimMatches(ctx, requested) {
  const [journeys, toggleStates, calcRuns, calcLinks, dispositions, journeyRefs] = await Promise.all([
    allRows(ctx, 'journeys', { select: 'id,status,stage,reference_code,criteria_json,budget_cents,confirmed_total_ceiling_cents', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment, cleared_at:'is.null' }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment })
  ]);
  const states = new Map(toggleStates.map((state) => [state.journey_id, state]));
  const byId = new Map(journeys.map((journey) => {
    const state = states.get(journey.id);
    return [journey.id, { ...journey, enabled: toggleEnabled(journey.status, state), offReason: state && state.off_reason || null }];
  }));
  const refOwner = new Map();
  journeys.forEach((journey) => { const ref = String(journey.reference_code || '').trim().toUpperCase(); if (ref) refOwner.set(ref, journey.id); });
  journeyRefs.forEach((row) => { const ref = String(row.ref_code || '').trim().toUpperCase(); if (ref && byId.has(row.journey_id)) refOwner.set(ref, row.journey_id); });
  const allOrders = groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks), dispositions);
  const linked = new Map();
  allOrders.forEach((order) => {
    const owner = refOwner.get(order.ref) || order.journeyId;
    if (!owner || !byId.has(owner)) return;
    if (!linked.has(owner)) linked.set(owner, []);
    linked.get(owner).push(order);
  });
  const criteriaFor = new Map();
  const journeyCriteria = (journey) => {
    if (!criteriaFor.has(journey.id)) {
      const orders = linked.get(journey.id) || [];
      const merged = orders.length ? { wishlists: mergeWishlists([], orders.flatMap((order) => order.wishlists || [])), budgetCents: orders.map((order) => order.budgetCents).find((value) => Number(value) > 0) || null } : null;
      criteriaFor.set(journey.id, effectiveCriteria(journey, merged));
    }
    return criteriaFor.get(journey.id);
  };
  const orderByRef = new Map(allOrders.filter((order) => order.disposition !== 'DISCARDED').map((order) => [order.ref, order]));
  const matches = [];
  const orderMatches = [];
  const discarded = { total: 0, reasons: {} };
  const discard = (reason) => { discarded.total += 1; discarded.reasons[reason] = (discarded.reasons[reason] || 0) + 1; };
  const annotate = (vehicle, result) => {
    vehicle.parsed.matchedWishlistIndex = result.matchedWishlistIndex;
    vehicle.parsed.matchedWishlistLabel = result.matchedWishlistLabel;
    vehicle.parsed.makeNotice = result.makeNotice || vehicle.parsed.makeNotice;
    vehicle.parsed.matchNotice = result.notice || '';
    vehicle.parsed.matchBasis = result.basis;
    vehicle.parsed.dataGap = result.dataGap === true;
  };
  for (const item of requested) {
    const vehicle = safeManheimVehicle(item && item.vehicle);
    const fingerprint = safeText(item && item.fingerprint, 200, true);
    if (!vehicle || !fingerprint) { discard('INVALID_ROW'); continue; }
    if (item && item.targetType === 'ORDER') {
      const ref = String(item.calcRef || '').trim().toUpperCase();
      const order = orderByRef.get(ref);
      if (!order) { discard('ORDER_UNAVAILABLE'); continue; }
      if (refOwner.has(ref) || order.journeyId) { discard('REF_LINKED_TO_FICHA'); continue; }
      const result = matchManheimOrder(vehicle.parsed, order);
      if (!result) { discard('CRITERIA_CHANGED'); continue; }
      annotate(vehicle, result);
      orderMatches.push({ calcRef: ref, kind: result.kind, reason: result.reason || result.notice, mmrStatus: result.mmrStatus, fingerprint, vehicle });
      continue;
    }
    if (!isUuid(item && item.journeyId)) { discard('INVALID_ROW'); continue; }
    const journey = byId.get(item.journeyId);
    if (!journey) { discard('JOURNEY_UNAVAILABLE'); continue; }
    const criteria = journeyCriteria(journey);
    const result = matchManheimVehicle(vehicle.parsed, criteria.wishes, criteria.bidCents);
    if (!result) { discard('CRITERIA_CHANGED'); continue; }
    if (journey.status === 'ENCERRADO' || (!journeyEnabled(journey) && (!reactivationEligible(journey) || result.kind !== 'BATE'))) { discard('JOURNEY_DISABLED'); continue; }
    if (journey.status === 'PARADO' && result.kind !== 'BATE') { discard('JOURNEY_DISABLED'); continue; }
    annotate(vehicle, result);
    matches.push({ journeyId: journey.id, kind: result.kind, reason: result.reason || result.notice, mmrStatus: result.mmrStatus, fingerprint, vehicle });
  }
  return { discarded, matches: matches.concat(orderMatches.map((item) => ({
    targetType: 'ORDER', calcRef: item.calcRef, kind: item.kind, reason: item.reason,
    mmrStatus: item.mmrStatus, fingerprint: item.fingerprint, vehicle: item.vehicle
  }))) };
}

function storeManheimUpload(ctx, header, matches) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_store_manheim_upload', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_source_file_count: header.fileCount,
      p_vehicle_count: header.vehicleCount, p_headers: header.headers, p_header_map: header.headerMap, p_matches: matches
    })
  });
}

async function actionManheimUpload(ctx, body) {
  const header = manheimUploadHeader(body);
  const requested = Array.isArray(body.matches) ? body.matches : [];
  if (!header || requested.length > 2000) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const validated = await validateManheimMatches(ctx, requested);
  return send(ctx.res, 201, { ...await storeManheimUpload(ctx, header, validated.matches), discarded: validated.discarded });
}

const MANHEIM_PART_ITEMS = 250;
const MANHEIM_MAX_PARTS = 400;

// One part of a chunked Manheim upload. The upload becomes the latest one only when its last part is stored.
async function actionManheimUploadPart(ctx, body) {
  const header = manheimUploadHeader(body);
  const partIndex = Number(body.partIndex);
  const partCount = Number(body.partCount);
  const uploadId = body.uploadId === null || body.uploadId === undefined || body.uploadId === '' ? null : body.uploadId;
  const requested = Array.isArray(body.matches) ? body.matches : null;
  if (!header || !requested || requested.length > MANHEIM_PART_ITEMS || !Number.isInteger(partCount) || partCount < 1 || partCount > MANHEIM_MAX_PARTS
      || !Number.isInteger(partIndex) || partIndex < 1 || partIndex > partCount || (uploadId !== null && !isUuid(uploadId))
      || (uploadId === null && partIndex !== 1)) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });
  const validated = await validateManheimMatches(ctx, requested);
  // A single part is already atomic: keep using the original RPC.
  if (partCount === 1) return send(ctx.res, 201, { ...await storeManheimUpload(ctx, header, validated.matches), complete: true, partIndex: 1, partCount: 1, discarded: validated.discarded });
  let result;
  try {
    result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_store_manheim_upload_part', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_upload_id: uploadId, p_part_index: partIndex, p_part_count: partCount,
        p_source_file_count: header.fileCount, p_vehicle_count: header.vehicleCount, p_headers: header.headers,
        p_header_map: header.headerMap, p_matches: validated.matches
      })
    });
  } catch (failure) {
    // PostgREST answers 404 when the RPC does not exist yet (migration not applied).
    if (failure && failure.status === 404) return send(ctx.res, 503, { error: 'MANHEIM_MIGRATION_PENDING' });
    throw failure;
  }
  return send(ctx.res, result && result.complete ? 201 : 202, { ...result, discarded: validated.discarded });
}

async function actionManheimArchive(ctx, body) {
  if (!isUuid(body.uploadId) || !Array.isArray(body.vehicles) || body.vehicles.length > 100) return send(ctx.res, 400, { error: 'MANHEIM_ARCHIVE_INVALID' });
  const upload = await rows(ctx, 'manheim_uploads', { select: 'id', environment: 'eq.' + ctx.environment, id: 'eq.' + body.uploadId, limit: '1' });
  if (!upload[0]) return send(ctx.res, 404, { error: 'MANHEIM_UPLOAD_NOT_FOUND' });
  const at = isoNow();
  const vehicles = body.vehicles.map((item) => {
    const parsed = item && item.vehicle || {};
    const fingerprint = safeText(item && item.fingerprint, 200, true);
    if (!fingerprint || !safeText(parsed.model, 120, true) || !finiteInteger(parsed.year) || (finiteInteger(parsed.miles) !== null && finiteInteger(parsed.miles) < 0)) return null;
    return {
      environment: ctx.environment, upload_id: upload[0].id, row_fingerprint: fingerprint,
      vehicle_json: {
        vin: safeText(parsed.vin, 40) || '', year: finiteInteger(parsed.year), make: safeText(parsed.make, 80) || '',
        model: safeText(parsed.model, 120), trim: safeText(parsed.trim, 120) || '', miles: finiteInteger(parsed.miles),
        location: safeText(parsed.location, 200) || '', locationDisplay: safeText(parsed.locationDisplay, 200) || '',
        saleDate: safeText(parsed.saleDate, 100) || '', startsAt: safeText(parsed.startsAt, 100) || safeText(parsed.saleDate,100) || '', endsAt: safeText(parsed.endsAt,100) || '',
        mmrCents: finiteInteger(parsed.mmrCents), exteriorColor:safeText(parsed.exteriorColor,80)||'', interiorColor:safeText(parsed.interiorColor,80)||'', drivetrain:safeText(parsed.drivetrain,80)||'', transmission:safeText(parsed.transmission,80)||'', engine:safeText(parsed.engine,120)||'', cleanTitle:parsed.cleanTitle===true,odometerOk:parsed.odometerOk===true
      }, uploaded_at: at
    };
  });
  const valid = vehicles.filter(Boolean);
  if (valid.length) await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/manheim_vehicles?on_conflict=environment,upload_id,row_fingerprint', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(valid)
  });
  return send(ctx.res, 200, { archived: valid.length, ignored: vehicles.length - valid.length });
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
  const endpoint = '/rest/v1/panel_item_dispositions?environment=eq.' + ctx.environment + '&item_kind=eq.' + itemKind + '&item_key=eq.' + encodeURIComponent(itemKey);
  const at = isoNow();
  if (!status) {
    await supabase(ctx.config.url, ctx.config.secretKey, endpoint, { method: 'PATCH', headers: { 'content-type':'application/json',prefer: 'return=minimal' },body:JSON.stringify({cleared_at:at,cleared_by:ctx.panel.id,updated_at:at,updated_by:ctx.panel.id}) });
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  try {
    const body = await jsonBody(req, 2 * 1024 * 1024);
    if (body.action === 'manheim_upload') return await actionManheimUpload(ctx, body);
    if (body.action === 'manheim_upload_part') return await actionManheimUploadPart(ctx, body);
    if (body.action === 'manheim_archive') return await actionManheimArchive(ctx, body);
    if (body.action === 'set_disposition') return await actionDisposition(ctx, body);
    const journey = await journeyContext(ctx, body.journeyId);
    if (!journey) return send(res, 404, { error: 'JOURNEY_NOT_FOUND' });
    switch (body.action) {
      case 'suppress': return await actionSuppression(ctx, journey, body);
      case 'next_action': return await actionNext(ctx, journey, body);
      case 'start_search': return await actionStartSearch(ctx, journey);
      case 'checklist_evidence': return await actionEvidence(ctx, journey, body);
      case 'declaration': return await actionDeclaration(ctx, journey, body);
      case 'mark_message': return await actionMarkMessage(ctx, journey, body);
      case 'update_note': return await actionNote(ctx, journey, body);
      case 'set_funnel': return await actionFunnel(ctx, journey, body);
      case 'promise': return await actionPromise(ctx, journey, body);
      case 'fulfill_promise': return await actionFulfillPromise(ctx, journey, body);
      case 'client_ok': return await actionClientOk(ctx, journey, body);
      case 'link_request': return await actionLinkRequest(ctx, journey, body);
      case 'unit': return await actionUnit(ctx, journey, body);
      case 'resolve_divergence': return await actionResolveDivergence(ctx, journey, body);
      case 'interaction': return await actionInteraction(ctx, journey, body);
      case 'set_status': return await actionSetStatus(ctx, journey, body);
      case 'close_journey': return await actionClose(ctx, journey, body);
      case 'toggle_journey': return await actionToggleJourney(ctx, journey, body);
      case 'return_update': return await actionReturn(ctx, journey, body);
      case 'invert_senders': return await actionInvertSenders(ctx, journey, body);
      default: return send(res, 400, { error: 'PANEL_ACTION_INVALID' });
    }
  } catch (failure) {
    if (failure && failure.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    return send(res, 500, { error: 'PANEL_ACTION_FAILED' });
  }
};

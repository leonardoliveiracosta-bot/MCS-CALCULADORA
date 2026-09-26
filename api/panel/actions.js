'use strict';

const {
  clientOkPatch, consolidateCalcRuns, finiteInteger, groupCalculatorByRef, journeyEnabled, matchManheimOrder, matchManheimVehicle,
  mergeWishlists, nextStageForUnits, reactivationEligible, REF_RE, time, wishlistsForJourney, wishlistText
} = require('../../panel-domain');
const { journeyExists, messageForJourney } = require('../../panel-read-model');
const vehicleCatalog = require('../../vehicle-catalog');
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
    const amount = Number(String(value).replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
    if (Number.isFinite(amount) && amount >= 0) valueJson.cents = Math.round(amount * 100);
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
  if (field === 'TETO') {
    const amount = Number(String(value).replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
    if (Number.isFinite(amount) && amount >= 0) patch.budget_cents = Math.round(amount * 100);
  }
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
    const amount = Number(String(value).replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
    if (Number.isFinite(amount) && amount >= 0) valueJson.cents = Math.round(amount * 100);
  }
  const deadlineAt = time(body.deadlineAt) ? new Date(time(body.deadlineAt)).toISOString() : null;
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_mark_message_fact', {
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
  return send(ctx.res, 200, result);
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
  if (!isUuid(body.messageId) || !time(body.dueAt)) return send(ctx.res, 400, { error: 'PROMISE_INVALID' });
  const message = await messageForJourney(ctx, journey.id, body.messageId);
  const dueText = safeText(body.dueText, 200, true);
  if (!message || message.direction !== 'MCS' || !dueText) return send(ctx.res, 400, { error: 'PROMISE_INVALID' });
  const duplicate = await rows(ctx, 'promises', { select: 'id', environment: 'eq.' + ctx.environment, message_id: 'eq.' + message.id, limit: '1' });
  if (duplicate[0]) return send(ctx.res, 409, { error: 'PROMISE_ALREADY_EXISTS' });
  const at = isoNow();
  const created = await insert(ctx, 'promises', {
    environment: ctx.environment, journey_id: journey.id, message_id: message.id,
    promise_text: String(message.body_text).slice(0, 2000), due_at: new Date(time(body.dueAt)).toISOString(),
    due_text: dueText, status: 'OPEN', created_at: at, created_by: ctx.panel.id
  });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, chatId: message.chat_id,
    activityType: 'PROMISE_RECORDED', summary: 'Promessa registrada', metadata: { message_id: message.id, due_at: new Date(time(body.dueAt)).toISOString() },
    entityType: 'promise', entityId: created[0].id, action: 'CREATE', after: { message_id: message.id, due_at: new Date(time(body.dueAt)).toISOString(), status: 'OPEN' }
  });
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
      request.budgetCents ? { field: 'TETO', value: String(request.budgetCents), json: { cents: request.budgetCents } } : null,
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
    buyNowPrice: safeText(parsedSource.buyNowPrice, 120) || '', conditionGrade: safeText(parsedSource.conditionGrade, 120) || ''
  };
  if (!headers.length || !parsed.year || !parsed.model || parsed.miles === null || parsed.miles < 0) return null;
  if (parsed.makeInferred) {
    const inferred = vehicleCatalog.inferMake(parsed.model);
    parsed.make = inferred.make;
    parsed.makeNotice = inferred.make ? '' : 'marca não informada no arquivo';
  }
  parsed.locationDisplay = vehicleCatalog.readableLocation(parsed.location);
  const output = { headers, raw, parsed };
  return Buffer.byteLength(JSON.stringify(output), 'utf8') <= 65536 ? output : null;
}

async function actionManheimUpload(ctx, body) {
  const fileCount = Number(body.sourceFileCount);
  const vehicleCount = Number(body.vehicleCount);
  const headers = Array.isArray(body.headers) ? body.headers.map((group) => Array.isArray(group) ? group.map((entry) => safeText(entry, 160, true)).filter(Boolean).slice(0, 100) : []).filter((group) => group.length).slice(0, 20) : [];
  const headerMap = body.headerMap && typeof body.headerMap === 'object' && !Array.isArray(body.headerMap) ? body.headerMap : {};
  const requested = Array.isArray(body.matches) ? body.matches : [];
  if (!Number.isInteger(fileCount) || fileCount < 1 || fileCount > 20 || !Number.isInteger(vehicleCount) || vehicleCount < 0 || vehicleCount > 100000 || !headers.length || requested.length > 2000) return send(ctx.res, 400, { error: 'MANHEIM_UPLOAD_INVALID' });

  const [journeys, toggleStates, calcRuns, calcLinks, dispositions] = await Promise.all([
    allRows(ctx, 'journeys', { select: 'id,status,stage,criteria_json,budget_cents', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment })
  ]);
  const states = new Map(toggleStates.map((state) => [state.journey_id, state]));
  const byId = new Map(journeys.map((journey) => {
    const state = states.get(journey.id);
    return [journey.id, { ...journey, enabled: state ? state.enabled : journey.status !== 'ENCERRADO', offReason: state && state.off_reason || null }];
  }));
  const orderByRef = new Map(groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks), dispositions)
    .filter((order) => order.disposition !== 'DISCARDED').map((order) => [order.ref, order]));
  const matches = [];
  const orderMatches = [];
  for (const item of requested) {
    const vehicle = safeManheimVehicle(item && item.vehicle);
    const fingerprint = safeText(item && item.fingerprint, 200, true);
    if (!vehicle || !fingerprint) return send(ctx.res, 400, { error: 'MANHEIM_MATCH_INVALID' });
    if (item && item.targetType === 'ORDER') {
      const ref = String(item.calcRef || '').trim().toUpperCase();
      const order = orderByRef.get(ref);
      const result = order && matchManheimOrder(vehicle.parsed, order);
      if (!order || !result) return send(ctx.res, 400, { error: 'MANHEIM_MATCH_INVALID' });
      vehicle.parsed.matchedWishlistIndex = result.matchedWishlistIndex;
      vehicle.parsed.matchedWishlistLabel = result.matchedWishlistLabel;
      vehicle.parsed.makeNotice = result.makeNotice || vehicle.parsed.makeNotice;
      orderMatches.push({ calcRef: ref, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus, fingerprint, vehicle });
      continue;
    }
    if (!isUuid(item && item.journeyId)) return send(ctx.res, 400, { error: 'MANHEIM_JOURNEY_ID_INVALID' });
    const journey = byId.get(item.journeyId);
    if (!journey) return send(ctx.res, 400, { error: 'MANHEIM_MATCH_INVALID' });
    const result = matchManheimVehicle(vehicle.parsed, wishlistsForJourney(journey), journey.budget_cents);
    if (!result) return send(ctx.res, 400, { error: 'MANHEIM_MATCH_INVALID' });
    if (!journeyEnabled(journey) && (!reactivationEligible(journey) || result.kind !== 'BATE')) return send(ctx.res, 409, { error: 'MANHEIM_JOURNEY_DISABLED' });
    if (journey.status === 'PARADO' && result.kind !== 'BATE') continue;
    vehicle.parsed.matchedWishlistIndex = result.matchedWishlistIndex;
    vehicle.parsed.matchedWishlistLabel = result.matchedWishlistLabel;
    vehicle.parsed.makeNotice = result.makeNotice || vehicle.parsed.makeNotice;
    matches.push({ journeyId: journey.id, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus, fingerprint, vehicle });
  }
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_store_manheim_upload', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      p_environment: ctx.environment, p_actor_id: ctx.panel.id, p_source_file_count: fileCount,
      p_vehicle_count: vehicleCount, p_headers: headers, p_header_map: headerMap,
      p_matches: matches.concat(orderMatches.map((item) => ({
        targetType: 'ORDER', calcRef: item.calcRef, kind: item.kind, reason: item.reason,
        mmrStatus: item.mmrStatus, fingerprint: item.fingerprint, vehicle: item.vehicle
      })))
    })
  });
  return send(ctx.res, 201, result);
}


async function actionDisposition(ctx, body) {
  const itemKind = String(body.itemKind || '');
  const itemKey = safeText(body.itemKey, 200, true);
  const status = body.status === null || body.status === '' ? null : String(body.status || '');
  if (!['REF', 'JOURNEY'].includes(itemKind) || !itemKey || (status && !['TREATED', 'DISCARDED'].includes(status))) {
    return send(ctx.res, 400, { error: 'DISPOSITION_INVALID' });
  }
  if (itemKind === 'REF' && !REF_RE.test(itemKey.toUpperCase())) return send(ctx.res, 400, { error: 'DISPOSITION_INVALID' });
  if (itemKind === 'JOURNEY' && !isUuid(itemKey)) return send(ctx.res, 400, { error: 'DISPOSITION_INVALID' });
  const endpoint = '/rest/v1/panel_item_dispositions?environment=eq.' + ctx.environment + '&item_kind=eq.' + itemKind + '&item_key=eq.' + encodeURIComponent(itemKey);
  if (!status) {
    await supabase(ctx.config.url, ctx.config.secretKey, endpoint, { method: 'DELETE', headers: { prefer: 'return=minimal' } });
    return send(ctx.res, 200, { status: null });
  }
  const at = isoNow();
  await supabase(ctx.config.url, ctx.config.secretKey,
    '/rest/v1/panel_item_dispositions?on_conflict=environment,item_kind,item_key',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ environment: ctx.environment, item_kind: itemKind, item_key: itemKey, status, updated_at: at, updated_by: ctx.panel.id })
    });
  return send(ctx.res, 200, { status, updatedAt: at });
}

async function actionInvertSenders(ctx, journey, body) {
  if (!isUuid(body.chatId)) return send(ctx.res, 400, { error: 'CHAT_ID_INVALID' });
  const links = await allRows(ctx, 'message_journeys', {
    select: 'message_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id
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
    if (body.action === 'manheim_upload') return actionManheimUpload(ctx, body);
    if (body.action === 'set_disposition') return actionDisposition(ctx, body);
    const journey = await journeyContext(ctx, body.journeyId);
    if (!journey) return send(res, 404, { error: 'JOURNEY_NOT_FOUND' });
    switch (body.action) {
      case 'suppress': return actionSuppression(ctx, journey, body);
      case 'next_action': return actionNext(ctx, journey, body);
      case 'start_search': return actionStartSearch(ctx, journey);
      case 'checklist_evidence': return actionEvidence(ctx, journey, body);
      case 'declaration': return actionDeclaration(ctx, journey, body);
      case 'mark_message': return actionMarkMessage(ctx, journey, body);
      case 'update_note': return actionNote(ctx, journey, body);
      case 'set_funnel': return actionFunnel(ctx, journey, body);
      case 'promise': return actionPromise(ctx, journey, body);
      case 'fulfill_promise': return actionFulfillPromise(ctx, journey, body);
      case 'client_ok': return actionClientOk(ctx, journey, body);
      case 'link_request': return actionLinkRequest(ctx, journey, body);
      case 'unit': return actionUnit(ctx, journey, body);
      case 'resolve_divergence': return actionResolveDivergence(ctx, journey, body);
      case 'interaction': return actionInteraction(ctx, journey, body);
      case 'set_status': return actionSetStatus(ctx, journey, body);
      case 'close_journey': return actionClose(ctx, journey, body);
      case 'toggle_journey': return actionToggleJourney(ctx, journey, body);
      case 'return_update': return actionReturn(ctx, journey, body);
      case 'invert_senders': return actionInvertSenders(ctx, journey, body);
      default: return send(res, 400, { error: 'PANEL_ACTION_INVALID' });
    }
  } catch (failure) {
    if (failure && failure.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    return send(res, 500, { error: 'PANEL_ACTION_FAILED' });
  }
};

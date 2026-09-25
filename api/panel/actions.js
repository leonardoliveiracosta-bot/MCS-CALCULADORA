'use strict';

const { clientOkPatch, consolidateCalcRuns, nextStageForUnits, normalizeContactPhone, REF_RE, time } = require('../../panel-domain');
const { journeyExists, messageForJourney } = require('../../panel-read-model');
const {
  allRows, insert, isUuid, jsonBody, patchRows, recordMutation, requirePanel,
  rows, safeText, send, supabase
} = require('../../panel-server');

const TODAY_KINDS = new Set(['NO_RESPONSE', 'NEXT_ACTION', 'MISSING_NEXT_ACTION', 'DIVERGENCE', 'PROMISE', 'SEARCH_STALLED', 'UNIT_NO_RESPONSE']);
const isoNow = () => new Date().toISOString();

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
  const at = isoNow();
  const points = await rows(ctx, 'journey_checklist', { select: 'id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, point_number: 'eq.' + config.point, limit: '1' });
  if (!points[0]) return send(ctx.res, 404, { error: 'CHECKLIST_POINT_NOT_FOUND' });
  const existingEvidence = await rows(ctx, 'checklist_evidence', { select: 'id', environment: 'eq.' + ctx.environment, checklist_id: 'eq.' + points[0].id, message_id: 'eq.' + message.id, limit: '1' });
  if (!existingEvidence[0]) await insert(ctx, 'checklist_evidence', {
    environment: ctx.environment, checklist_id: points[0].id, message_id: message.id,
    excerpt_text: String(message.body_text).slice(0, 1000), created_at: at, created_by: ctx.panel.id
  }, false);
  await patchRows(ctx, 'journey_checklist', { environment: 'eq.' + ctx.environment, id: 'eq.' + points[0].id }, { status: 'COMPLETE', completed_at: at, updated_at: at });
  let declarationId = null;
  const value = safeText(body.value || message.body_text, 500, true);
  if (config.field && value) {
    const valueJson = {};
    if (config.field === 'TETO') {
      const amount = Number(String(value).replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
      if (Number.isFinite(amount) && amount >= 0) valueJson.cents = Math.round(amount * 100);
    }
    const created = await insert(ctx, 'journey_declarations', {
      environment: ctx.environment, journey_id: journey.id, field: config.field,
      source: 'CONVERSATION', value_text: value, value_json: valueJson,
      message_id: message.id, declared_at: message.occurred_at_utc || message.created_at || at,
      created_at: at, created_by: ctx.panel.id
    });
    declarationId = created[0].id;
    const patch = { updated_at: at, updated_by: ctx.panel.id };
    if (config.field === 'VEICULO') patch.vehicle_text = value;
    if (config.field === 'PAGAMENTO') patch.payment_text = value;
    if (config.field === 'TETO' && Number.isFinite(valueJson.cents)) patch.budget_cents = valueJson.cents;
    if (config.field === 'PRAZO') {
      patch.customer_deadline_text = value;
      if (time(body.deadlineAt)) patch.customer_deadline_at = new Date(time(body.deadlineAt)).toISOString();
    }
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, patch);
  }
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id, chatId: message.chat_id,
    activityType: 'MESSAGE_FACT_MARKED', summary: 'Mensagem marcada na ficha e no checklist',
    metadata: { point_number: config.point, field: config.field || null, message_id: message.id },
    entityType: 'journey', entityId: journey.id, action: 'MESSAGE_FACT_MARK',
    after: { point_number: config.point, field: config.field || null, declaration_id: declarationId }
  });
  return send(ctx.res, 200, { pointNumber: config.point, field: config.field || null, status: 'COMPLETE' });
}

async function actionNote(ctx, journey, body) {
  const note = safeText(body.note, 4000) || null;
  const at = isoNow();
  await patchRows(ctx, 'contacts', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id }, { notes: note, updated_at: at, updated_by: ctx.panel.id });
  await recordMutation(ctx, { at, journeyId: journey.id, contactId: journey.contact_id, activityType: 'NOTE_UPDATED', summary: 'Nota atualizada', metadata: {}, entityType: 'contact', entityId: journey.contact_id, action: 'NOTE_UPDATE', after: { has_note: Boolean(note) } });
  return send(ctx.res, 200, { saved: true });
}

async function actionContactIdentity(ctx, journey, body) {
  const displayName = safeText(body.displayName, 160, true);
  const phoneRaw = safeText(body.phone, 40) || null;
  const phoneE164 = phoneRaw ? normalizeContactPhone(phoneRaw) : null;
  if (!displayName || (phoneRaw && !phoneE164)) return send(ctx.res, 400, { error: 'CONTACT_IDENTITY_INVALID' });
  if (phoneE164) {
    const currentOwners = await rows(ctx, 'contact_phones', {
      select: 'id,contact_id,is_current', environment: 'eq.' + ctx.environment,
      phone_e164: 'eq.' + phoneE164, is_current: 'is.true'
    });
    const alreadyOwnsCurrent = currentOwners.some((item) => item.contact_id === journey.contact_id);
    if (!alreadyOwnsCurrent && currentOwners.some((item) => item.contact_id !== journey.contact_id)) return send(ctx.res, 409, { error: 'CONTACT_PHONE_CONFLICT' });
    const ownRows = await rows(ctx, 'contact_phones', {
      select: 'id,is_current', environment: 'eq.' + ctx.environment,
      contact_id: 'eq.' + journey.contact_id, phone_e164: 'eq.' + phoneE164, limit: '1'
    });
    await patchRows(ctx, 'contact_phones', {
      environment: 'eq.' + ctx.environment, contact_id: 'eq.' + journey.contact_id,
      is_current: 'is.true', phone_e164: 'neq.' + phoneE164
    }, { is_current: false, retired_at: isoNow() });
    if (ownRows[0]) {
      await patchRows(ctx, 'contact_phones', { environment: 'eq.' + ctx.environment, id: 'eq.' + ownRows[0].id }, {
        is_current: true, retired_at: null, confirmed_at: isoNow()
      });
    } else {
      await insert(ctx, 'contact_phones', {
        environment: ctx.environment, contact_id: journey.contact_id, phone_e164: phoneE164,
        phone_raw: phoneRaw, is_current: true, confirmed_at: isoNow(), created_at: isoNow(), created_by: ctx.panel.id
      }, false);
    }
  }
  const at = isoNow();
  await patchRows(ctx, 'contacts', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id }, {
    display_name: displayName, updated_at: at, updated_by: ctx.panel.id
  });
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'CONTACT_IDENTITY_UPDATED', summary: 'Identificação do contato atualizada',
    metadata: { name_updated: true, phone_updated: Boolean(phoneE164) },
    entityType: 'contact', entityId: journey.contact_id, action: 'CONTACT_IDENTITY_UPDATE',
    after: { has_name: true, has_phone: Boolean(phoneE164) }
  });
  return send(ctx.res, 200, { saved: true, phoneLast4: phoneE164 ? phoneE164.slice(-4) : null });
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
  const sid = safeText(body.calcSid, 200, true);
  const ref = String(body.calcRef || '').trim().toUpperCase();
  const mode = String(body.logicalMode || '');
  if (!sid || !REF_RE.test(ref) || !['CARRO', 'VALOR'].includes(mode) || body.contactId !== journey.contact_id) return send(ctx.res, 400, { error: 'CALCULATOR_LINK_INVALID' });
  const calcRuns = await allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados', order: 'created_at.asc' });
  const request = consolidateCalcRuns(calcRuns).find((item) => item.sid === sid && item.ref === ref && item.logicalMode === mode);
  if (!request) return send(ctx.res, 404, { error: 'CALCULATOR_REQUEST_NOT_FOUND' });
  const at = isoNow();
  const payload = { environment: ctx.environment, calc_sid: sid, calc_ref: ref, logical_mode: mode, contact_id: journey.contact_id, journey_id: journey.id, linked_at: at, linked_by: ctx.panel.id };
  const linked = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/calculator_request_links?on_conflict=environment,calc_sid,calc_ref,logical_mode', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify(payload)
  });
  const existingRef = await rows(ctx, 'journey_refs', { select: 'id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, ref_code: 'eq.' + ref, calculator_sid: 'eq.' + sid, limit: '1' });
  if (!existingRef[0]) await insert(ctx, 'journey_refs', { environment: ctx.environment, journey_id: journey.id, ref_code: ref, source_message_id: null, calculator_sid: sid, created_at: at, created_by: ctx.panel.id }, false);
  const declarations = [
    request.budgetCents ? { field: 'TETO', value: String(request.budgetCents), json: { cents: request.budgetCents } } : null,
    request.vehicleText ? { field: 'VEICULO', value: request.vehicleText, json: {} } : null,
    request.paymentText ? { field: 'PAGAMENTO', value: request.paymentText, json: {} } : null,
    request.deadlineText ? { field: 'PRAZO', value: request.deadlineText, json: {} } : null
  ].filter(Boolean);
  for (const declaration of declarations) {
    const already = await rows(ctx, 'journey_declarations', {
      select: 'id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id,
      field: 'eq.' + declaration.field, source: 'eq.CALCULATOR', calc_sid: 'eq.' + sid,
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
      message_id: null, calc_sid: sid, calc_ref: ref,
      declared_at: request.occurredAt || at, created_at: at, created_by: ctx.panel.id
    });
    if (previous[0] && declarationKey(declaration.field, previous[0].value_text, previous[0].value_json) !== declarationKey(declaration.field, declaration.value, declaration.json)) await insert(ctx, 'journey_divergences', {
      environment: ctx.environment, journey_id: journey.id, field: declaration.field,
      left_declaration_id: previous[0].id, right_declaration_id: created[0].id,
      status: 'OPEN', created_at: at
    }, false);
  }
  const fill = { updated_at: at, updated_by: ctx.panel.id };
  if (!journey.vehicle_text && request.vehicleText) fill.vehicle_text = request.vehicleText;
  if (!journey.budget_cents && request.budgetCents) fill.budget_cents = request.budgetCents;
  if (!journey.payment_text && request.paymentText) fill.payment_text = request.paymentText;
  if (!journey.customer_deadline_text && request.deadlineText) fill.customer_deadline_text = request.deadlineText;
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, fill);
  await recordMutation(ctx, {
    at, journeyId: journey.id, contactId: journey.contact_id,
    activityType: 'CALCULATOR_REQUEST_LINKED', summary: 'Pedido da calculadora ligado à jornada', metadata: { calc_sid: sid, calc_ref: ref, logical_mode: mode },
    entityType: 'calculator_request_link', entityId: linked[0].id, action: 'LINK', after: { calc_sid: sid, calc_ref: ref, logical_mode: mode, journey_id: journey.id }
  });
  return send(ctx.res, 200, { id: linked[0].id, status: 'LINKED' });
}

async function actionUnit(ctx, journey, body) {
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
    const vehicle = safeText(body.vehicleText, 500, true);
    if (!vehicle) return send(ctx.res, 400, { error: 'UNIT_VEHICLE_REQUIRED' });
    const created = await insert(ctx, 'units', { environment: ctx.environment, journey_id: journey.id, vehicle_text: vehicle, details_json: {}, presented_at: at, status, created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id });
    unitId = created[0].id;
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  try {
    const body = await jsonBody(req);
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
      case 'update_contact_identity': return actionContactIdentity(ctx, journey, body);
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
      default: return send(res, 400, { error: 'PANEL_ACTION_INVALID' });
    }
  } catch (failure) {
    if (failure && failure.message === 'PAYLOAD_TOO_LARGE') return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
    return send(res, 500, { error: 'PANEL_ACTION_FAILED' });
  }
};

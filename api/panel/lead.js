'use strict';

const { leadData, ensureJourney, localToUtc, addClientDays } = require('../../panel-lead');
const { validItems, verified } = require('../../panel-note');
const { insert, isUuid, jsonBody, patchRows, requirePanel, rows, safeText, send } = require('../../panel-server');

async function delegate(req, payload) {
  const response = { code: 200, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.data = value; return value; } };
  await require('./actions')({ ...req, method: 'POST', body: payload }, response);
  return { code: response.code, data: response.data };
}

function clientDateTime(value, zone) {
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(raw)) return localToUtc(raw.slice(0, 16), zone);
  const stamp = Date.parse(raw);
  return Number.isFinite(stamp) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? new Date(stamp).toISOString() : null;
}

async function quick(ctx, lead, journey, type, at, dueAt, source = 'button') {
  const types = { ANSWERED: 'CALL_ANSWERED', NO_ANSWER: 'CALL_ATTEMPT', LATER: 'CALL_ATTEMPT', IN_PERSON: 'IN_PERSON', DEPOSIT: 'CALL_ANSWERED' };
  if (!types[type]) throw new Error('QUICK_RESULT_INVALID');
  const prior = await rows(ctx, 'journeys', { select: 'stage,status,qualified_at,next_action_at,next_action_text,last_effective_contact_at', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id, limit: '1' });
  const snapshot = prior[0] || {};
  const detail = { ANSWERED: 'Atendeu', NO_ANSWER: 'Não atendeu', LATER: 'Pediu para ligar depois', IN_PERSON: 'Conversa presencial', DEPOSIT: 'Vai pagar o depósito' }[type];
  const interaction = (await insert(ctx, 'interactions', { environment: ctx.environment, journey_id: journey.id, type: types[type], occurred_at: at, detail_text: detail, next_action_at: dueAt || null, created_at: at, created_by: ctx.panel.id }))[0];
  const patch = { updated_at: at, updated_by: ctx.panel.id };
  if (type !== 'NO_ANSWER' && type !== 'LATER') {
    patch.last_effective_contact_at = at;
    if (snapshot.stage === 'NOVO') patch.stage = 'RESPONDIDO';
  }
  if (type === 'DEPOSIT') { patch.stage = 'QUALIFICADO'; patch.qualified_at = at; }
  if (dueAt) { patch.next_action_at = dueAt; patch.next_action_text = detail; patch.next_action_missing_since = null; }
  await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, patch);
  const event = (await insert(ctx, 'lead_events', { environment: ctx.environment, ref_code: lead.ref, journey_id: journey.id, event_type: 'QUICK_' + type, detail_json: { label: detail, interactionId: interaction.id, snapshot, dueAt: dueAt || null, source }, occurred_at: at, created_by: ctx.panel.id }))[0];
  return event;
}

async function applyItem(ctx, req, lead, journey, item) {
  const type = String(item.type || '');
  const value = item.value;
  const at = new Date().toISOString();
  if (type === 'call_result') {
    const duplicate = await rows(ctx, 'lead_events', { select: 'id', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref, event_type: 'eq.QUICK_' + value, occurred_at: 'gte.' + new Date(Date.now() - 30000).toISOString(), limit: '1' });
    const dueAt = clientDateTime(item.dueAt, lead.timezone) || (['ANSWERED','NO_ANSWER'].includes(value)
      ? addClientDays(Date.now(), lead.timezone, value === 'ANSWERED' ? 2 : 1) : null);
    if (!duplicate.length) await quick(ctx, lead, journey, String(value), at, dueAt, 'annotation');
  } else if (type === 'checklist') {
    const number = Number(item.point);
    if (!Number.isInteger(number) || number < 1 || number > 6) return;
    await patchRows(ctx, 'journey_checklist', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, point_number: 'eq.' + number }, { status: 'COMPLETE', completed_at: at, updated_at: at });
  } else if (type === 'budget') {
    const cents = Math.round(Number(value) * 100);
    if (!(cents > 0 && cents <= 100000000)) return;
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { budget_cents: cents, updated_at: at, updated_by: ctx.panel.id });
    await applyItem(ctx, req, lead, journey, { type: 'checklist', point: 2 });
  } else if (type === 'payment') {
    if (!['cash','fin'].includes(value)) return;
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { payment_text: value, updated_at: at, updated_by: ctx.panel.id });
  } else if (type === 'deadline') {
    if (!['now','30d','3m','none'].includes(value)) return;
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { customer_deadline_text: value, updated_at: at, updated_by: ctx.panel.id });
  } else if (type === 'wishlist') {
    const current = await rows(ctx, 'journeys', { select: 'criteria_json', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id, limit: '1' });
    const criteria = current[0]?.criteria_json || {};
    if (!value || !Array.isArray(value.cars)) return;
    const normalized = value.cars.slice(0, 5).filter((car) => car && typeof car.model === 'string' && car.model.length <= 120).map((car) => ({ make: safeText(car.make, 80) || '', model: car.model, yearMin: Number(car.yearMin) || null, yearMax: Number(car.yearMax) || null, maxMiles: Number(car.maxMiles) || null }));
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { criteria_json: { ...criteria, wishlists: normalized, wishlistOverride: true }, updated_at: at, updated_by: ctx.panel.id });
  } else if (type === 'phone') {
    const phone = safeText(value && value.number, 30);
    if (!phone || !/^[+()\d\s.-]{7,30}$/.test(phone)) return;
    await insert(ctx, 'contact_phones', { environment: ctx.environment, contact_id: journey.contact_id, phone_raw: phone, is_current: true, created_at: at, created_by: ctx.panel.id }, false);
    await insert(ctx, 'lead_events', { environment: ctx.environment, ref_code: lead.ref, journey_id: journey.id, event_type: 'EXTRA_PHONE', detail_json: { owner: safeText(value.owner, 100) || null, number: phone }, occurred_at: at, created_by: ctx.panel.id }, false);
  } else if (type === 'promise') {
    const text = safeText(value && value.text, 1000);
    const date = Date.parse(clientDateTime(value && value.at, lead.timezone));
    if (!text || !Number.isFinite(date)) return;
    await insert(ctx, 'lead_promises', { environment: ctx.environment, ref_code: lead.ref, journey_id: journey.id, promise_text: text, due_at: new Date(date).toISOString(), created_at: at, created_by: ctx.panel.id }, false);
  } else if (type === 'return') {
    const date = Date.parse(clientDateTime(value && value.at, lead.timezone));
    if (!Number.isFinite(date)) return;
    await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { next_action_at: new Date(date).toISOString(), next_action_text: safeText(value.text, 500) || 'Retorno', updated_at: at, updated_by: ctx.panel.id });
  } else if (type === 'stage') {
    if (!['NOVO','RESPONDIDO','EM_BUSCA','DECIDINDO','QUALIFICADO'].includes(value)) return;
    await delegate(req, { action: 'set_funnel', journeyId: journey.id, value });
  } else if (type === 'disable') {
    const reason = safeText(value && value.reason, 500);
    if (!reason) return;
    await insert(ctx, 'lead_events', { environment: ctx.environment, ref_code: lead.ref, journey_id: journey.id, event_type: 'DISABLE_SUGGESTED', detail_json: { reason }, occurred_at: at, created_by: ctx.panel.id }, false);
  }
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const ref = String(req.query && req.query.ref || '').toUpperCase();
    const id = String(req.query && req.query.id || '');
    if (req.method === 'GET') {
      const lead = await leadData(ctx, req, ref, id);
      return lead ? send(res, 200, lead) : send(res, 404, { error: 'LEAD_NOT_FOUND' });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const body = await jsonBody(req, 64 * 1024);
    const lead = await leadData(ctx, req, String(body.ref || ref).toUpperCase(), body.journeyId || id);
    if (!lead) return send(res, 404, { error: 'LEAD_NOT_FOUND' });
    if (body.action === 'saved_search') {
      const key = safeText(body.key, 180, true);
      if (!key) return send(res, 400, { error: 'SEARCH_KEY_INVALID' });
      await insert(ctx, 'manheim_saved_searches', { environment: ctx.environment, search_key: key, created: body.created === true, updated_by: ctx.panel.id }, false).catch(async () => patchRows(ctx, 'manheim_saved_searches', { environment: 'eq.' + ctx.environment, search_key: 'eq.' + key }, { created: body.created === true, updated_at: new Date().toISOString(), updated_by: ctx.panel.id }));
      return send(res, 200, { saved: true });
    }
    const journey = await ensureJourney(ctx, lead);
    if (body.action === 'tracking_step') {
      const step = Number(body.step);
      if (step < 1 || step > 4 || !Number.isInteger(step)) return send(res, 400, { error: 'STEP_INVALID' });
      const result = step === 4 ? String(body.result || '') : null;
      if (step === 4 && !['WON','NOT_WON'].includes(result)) return send(res, 400, { error: 'RESULT_REQUIRED' });
      await patchRows(ctx, 'lead_tracking', { environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref }, { step, result, updated_at: new Date().toISOString() });
      return send(res, 200, { step, result });
    }
    if (body.action === 'note') {
      const note = safeText(body.note, 12000, true);
      if (!note) return send(res, 400, { error: 'NOTE_REQUIRED' });
      const proposal = validItems(note, body.proposal);
      if (proposal.length && !verified(ctx.config.secretKey, lead.ref, note, proposal, body.signature)) return send(res, 400, { error: 'PROPOSAL_INVALID' });
      const selected = Array.isArray(body.selected) ? new Set(body.selected.map(Number)) : new Set();
      const items = proposal.filter((_, index) => selected.has(index));
      const at = new Date().toISOString();
      const saved = (await insert(ctx, 'lead_notes', { environment: ctx.environment, ref_code: lead.ref, journey_id: journey.id, body_text: note, distributed_json: items, created_at: at, created_by: ctx.panel.id }))[0];
      for (const item of items) await applyItem(ctx, req, lead, journey, item);
      return send(res, 201, { noteId: saved.id, distributed: items.length, journeyId: journey.id });
    }
    if (body.action === 'quick') {
      const type = String(body.type || '');
      const earlier = await rows(ctx, 'lead_events', { select: 'id,detail_json', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref, event_type: 'eq.QUICK_' + type, undone_at: 'is.null', occurred_at: 'gte.' + new Date(Date.now() - 30 * 60000).toISOString(), order: 'occurred_at.desc', limit: '10' });
      if (earlier.some((event) => event.detail_json?.source === 'annotation')) return send(res, 200, { duplicate: true });
      const at = new Date().toISOString();
      let dueAt = null;
      if (type === 'LATER') {
        const due = Date.parse(body.dueLocal ? localToUtc(body.dueLocal, lead.timezone) : body.dueAt);
        if (!Number.isFinite(due) || due < Date.now()) return send(res, 400, { error: 'RETURN_DATE_INVALID' });
        dueAt = new Date(due).toISOString();
      } else if (['ANSWERED','NO_ANSWER','DEPOSIT'].includes(type)) {
        dueAt = type === 'DEPOSIT' ? at : addClientDays(Date.now(), lead.timezone, type === 'ANSWERED' ? 2 : 1);
      }
      const event = await quick(ctx, lead, journey, type, at, dueAt);
      return send(res, 201, { eventId: event.id, undoUntil: new Date(Date.now() + 10000).toISOString(), journeyId: journey.id });
    }
    if (body.action === 'undo') {
      const found = await rows(ctx, 'lead_events', { select: '*', environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref, id: 'eq.' + body.eventId, undone_at: 'is.null', limit: '1' });
      const event = found[0];
      if (!event || !event.event_type.startsWith('QUICK_') || Date.now() - Date.parse(event.occurred_at) > 10000) return send(res, 409, { error: 'UNDO_EXPIRED' });
      const snapshot = event.detail_json.snapshot || {};
      await patchRows(ctx, 'journeys', { environment: 'eq.' + ctx.environment, id: 'eq.' + journey.id }, { stage: snapshot.stage, status: snapshot.status, qualified_at: snapshot.qualified_at, next_action_at: snapshot.next_action_at, next_action_text: snapshot.next_action_text, last_effective_contact_at: snapshot.last_effective_contact_at, updated_at: new Date().toISOString() });
      await patchRows(ctx, 'lead_events', { environment: 'eq.' + ctx.environment, id: 'eq.' + event.id }, { undone_at: new Date().toISOString() });
      if (isUuid(event.detail_json.interactionId)) await patchRows(ctx, 'interactions', { environment: 'eq.' + ctx.environment, id: 'eq.' + event.detail_json.interactionId }, { detail_text: 'Desfeito' });
      return send(res, 200, { undone: true });
    }
    if (body.action === 'checklist') {
      const point = Number(body.point);
      if (!Number.isInteger(point) || point < 1 || point > 6) return send(res, 400, { error: 'CHECKLIST_POINT_INVALID' });
      await patchRows(ctx, 'journey_checklist', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, point_number: 'eq.' + point }, { status: body.complete ? 'COMPLETE' : 'OPEN', completed_at: body.complete ? new Date().toISOString() : null, updated_at: new Date().toISOString() });
      return send(res, 200, { saved: true });
    }
    if (body.action === 'present') {
      const found = await rows(ctx, 'manheim_vehicles', { select: 'vehicle_json', environment: 'eq.' + ctx.environment, row_fingerprint: 'eq.' + String(body.fingerprint || ''), order: 'uploaded_at.desc', limit: '1' });
      const vehicle = found[0]?.vehicle_json || lead.offers.find((item) => item.rowFingerprint === body.fingerprint);
      if (!vehicle || !lead.offers.some((item) => item.rowFingerprint === body.fingerprint)) return send(res, 400, { error: 'VEHICLE_NOT_COMPATIBLE' });
      const details = { year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim, miles: vehicle.miles, location: vehicle.locationDisplay || vehicle.location, saleDate: vehicle.saleDate, vin: vehicle.vin, mmrCents: vehicle.mmrCents };
      const at = new Date().toISOString();
      const unit = (await insert(ctx, 'units', { environment: ctx.environment, journey_id: journey.id, vehicle_text: [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' '), details_json: details, presented_at: at, status: 'PRESENTED', created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id }))[0];
      await patchRows(ctx, 'lead_tracking', { environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref, step: 'lt.2' }, { step: 2, updated_at: at });
      await insert(ctx, 'lead_events', { environment: ctx.environment, ref_code: lead.ref, journey_id: journey.id, unit_id: unit.id, event_type: 'CAR_PRESENTED', detail_json: { vehicle: unit.vehicle_text }, occurred_at: at, created_by: ctx.panel.id }, false);
      return send(res, 201, { unitId: unit.id });
    }
    if (body.action === 'retail') {
      const unit = (await rows(ctx, 'units', { select: 'id,details_json', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.unitId, limit: '1' }))[0];
      const url = safeText(body.url, 500) || '';
      if (!unit || (url && !/^https:\/\/(?:www\.)?mycarscout\.net\//i.test(url))) return send(res, 400, { error: 'RETAIL_LINK_INVALID' });
      await patchRows(ctx, 'units', { environment: 'eq.' + ctx.environment, id: 'eq.' + unit.id }, { details_json: { ...unit.details_json, retailValue: Number(body.value) || null, retailUrl: url || null }, updated_at: new Date().toISOString() });
      return send(res, 200, { saved: true });
    }
    if (body.action === 'manual') {
      const action = safeText(body.panelAction, 100);
      if (!['next_action','unit','set_funnel','toggle_journey','return_update','invert_senders','resolve_divergence'].includes(action)) return send(res, 400, { error: 'ACTION_INVALID' });
      const result = await delegate(req, { ...body.payload, action, journeyId: journey.id });
      return send(res, result.code, result.data);
    }
    return send(res, 400, { error: 'LEAD_ACTION_INVALID' });
  } catch (_) {
    return send(res, 500, { error: 'LEAD_ACTION_FAILED' });
  }
};

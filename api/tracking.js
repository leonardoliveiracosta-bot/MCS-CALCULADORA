'use strict';
const { SERVER_ENVIRONMENT, configuration, jsonBody, patchRows, rows, insert, send } = require('../panel-server');
const { orders } = require('../panel-lead');
function publicLocation(value) {
  const source = String(value || '').trim();
  const prefixed = source.match(/^([A-Z]{2})\s*-\s*([\w\s.-]+)$/i);
  if (prefixed && !/manheim|auction/i.test(prefixed[2])) return `${prefixed[2]}, ${prefixed[1].toUpperCase()}`;
  return /^[\w\s.-]+,\s*[A-Z]{2}$/i.test(source) && !/manheim|auction/i.test(source) ? source : '';
}
module.exports = async (req, res) => {
  const config = configuration();
  if (!config || !SERVER_ENVIRONMENT) return send(res, 503, { error: 'SERVICE_UNAVAILABLE' });
  const code = String(req.query && req.query.code || '');
  if (!/^[A-Za-z0-9_-]{22,80}$/.test(code)) return send(res, 404, { error: 'NOT_FOUND' });
  const ctx = { config, environment: SERVER_ENVIRONMENT };
  try {
    const track = (await rows(ctx, 'lead_tracking', { select: 'id,ref_code,journey_id,step,result,updated_at', environment: 'eq.' + SERVER_ENVIRONMENT, public_code: 'eq.' + code, limit: '1' }))[0];
    if (!track) return send(res, 404, { error: 'NOT_FOUND' });
    const journey = track.journey_id && (await rows(ctx, 'journeys', { select: 'id,contact_id,status', environment: 'eq.' + SERVER_ENVIRONMENT, id: 'eq.' + track.journey_id, limit: '1' }))[0];
    const toggle = journey && (await rows(ctx, 'journey_toggle_states', { select: 'enabled', environment: 'eq.' + SERVER_ENVIRONMENT, journey_id: 'eq.' + journey.id, limit: '1' }))[0];
    if (journey && (toggle && !toggle.enabled || journey.status === 'ENCERRADO')) return send(res, 200, { closed: true });
    if (req.method === 'POST') {
      const body = await jsonBody(req, 4096);
      const unit = journey && (await rows(ctx, 'units', { select: 'id,details_json,vehicle_text,status', environment: 'eq.' + SERVER_ENVIRONMENT, journey_id: 'eq.' + journey.id, id: 'eq.' + body.unitId, limit: '1' }))[0];
      if (!unit || !['WANT','DECLINE'].includes(body.response)) return send(res, 400, { error: 'RESPONSE_INVALID' });
      if (unit.status === 'ACCEPTED' || unit.status === 'DECLINED') return send(res, 200, { accepted: true });
      if (unit.status !== 'PRESENTED' && unit.status !== 'UNDER_REVIEW') return send(res, 409, { error: 'UNIT_UNAVAILABLE' });
      const at = new Date().toISOString();
      await patchRows(ctx, 'units', { environment: 'eq.' + SERVER_ENVIRONMENT, id: 'eq.' + unit.id }, { status: body.response === 'WANT' ? 'ACCEPTED' : 'DECLINED', decline_reason: body.response === 'DECLINE' ? 'Not for me' : null, last_customer_response_at: at, updated_at: at });
      await insert(ctx, 'lead_events', { environment: SERVER_ENVIRONMENT, ref_code: track.ref_code, journey_id: journey.id, unit_id: unit.id, event_type: body.response === 'WANT' ? 'WANT_CAR' : 'NOT_FOR_ME', detail_json: { vehicle: unit.vehicle_text }, occurred_at: at }, false);
      return send(res, 200, { accepted: true });
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const contacts = journey ? await rows(ctx, 'contacts', { select: 'display_name', environment: 'eq.' + SERVER_ENVIRONMENT, id: 'eq.' + journey.contact_id, limit: '1' }) : [];
    const fallback = !contacts[0]?.display_name ? (await orders(ctx)).find((item) => item.ref === String(track.ref_code).trim()) : null;
    const units = journey ? await rows(ctx, 'units', { select: 'id,vehicle_text,details_json,status,presented_at', environment: 'eq.' + SERVER_ENVIRONMENT, journey_id: 'eq.' + journey.id, order: 'presented_at.desc' }) : [];
    const safeUnits = units.filter((unit) => unit.status !== 'WITHDRAWN').map((unit) => {
      const d = unit.details_json || {};
      return { id: unit.id, year: d.year || null, make: d.make || '', model: d.model || unit.vehicle_text, trim: d.trim || '', miles: d.miles || null,
        location: publicLocation(d.location), saleDate: d.saleDate || null, retailValue: Number(d.retailValue) || null,
        retailUrl: /^https:\/\/(?:www\.)?mycarscout\.net\//i.test(d.retailUrl || '') ? d.retailUrl : null,
        response: unit.status === 'ACCEPTED' ? 'WANT' : unit.status === 'DECLINED' ? 'DECLINE' : null };
    });
    return send(res, 200, { firstName: String(contacts[0]?.display_name || fallback?.contactName || '').trim().split(/\s+/)[0] || 'there', ref: String(track.ref_code).trim(),
      step: Math.max(track.step, safeUnits.length ? 2 : 1), result: track.result, updatedAt: track.updated_at, cars: safeUnits });
  } catch (_) { return send(res, 500, { error: 'TRACKING_UNAVAILABLE' }); }
};

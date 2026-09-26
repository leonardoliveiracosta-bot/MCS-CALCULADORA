'use strict';

const { leadData, ensureJourney, localToUtc, addClientDays, cityForZip } = require('../../panel-lead');
const { validItems, verified, prepareItems } = require('../../panel-note');
const { insert, isUuid, jsonBody, patchRows, requirePanel, rows, safeText, send, supabase } = require('../../panel-server');

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

async function quick(ctx, lead, journey, type, dueAt, operationId) {
  return supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_quick_result',{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_actor:ctx.panel.id,p_ref:lead.ref,
      p_journey:journey.id,p_type:type,p_due:dueAt,p_operation:operationId})
  });
}

async function actionEvent(ctx, lead, journey, action) {
  await insert(ctx,'lead_events',{environment:ctx.environment,ref_code:lead.ref,journey_id:journey.id,event_type:'ACTION_'+action,
    detail_json:{},created_by:ctx.panel.id},false);
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const ref = String(req.query && req.query.ref || '').toUpperCase();
    const id = String(req.query && req.query.id || '');
    if (req.method === 'GET') {
      if (req.query?.cityZip) {
        const zip=String(req.query.cityZip);
        return /^\d{5}$/.test(zip) ? send(res,200,{city:await cityForZip(zip)}) : send(res,400,{error:'ZIP_INVALID'});
      }
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
    const journey = body.action === 'note' ? lead.record : await ensureJourney(ctx, lead);
    if (body.action === 'tracking_step') {
      const step = Number(body.step);
      if (step < 1 || step > 4 || !Number.isInteger(step)) return send(res, 400, { error: 'STEP_INVALID' });
      const result = step === 4 ? String(body.result || '') : null;
      if (step === 4 && !['WON','NOT_WON'].includes(result)) return send(res, 400, { error: 'RESULT_REQUIRED' });
      await patchRows(ctx, 'lead_tracking', { environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref }, { step, result, updated_at: new Date().toISOString() });
      await actionEvent(ctx,lead,journey,'TRACKING_STEP');
      return send(res, 200, { step, result });
    }
    if (body.action === 'note') {
      const note = safeText(body.note, 12000, true);
      if (!note || !isUuid(body.confirmationKey)) return send(res, 400, { error: 'NOTE_OR_KEY_REQUIRED' });
      const submitted = Array.isArray(body.proposal) ? body.proposal : [];
      if (submitted.length && !verified(ctx.config.secretKey, lead.ref, note, submitted, body.signature)) return send(res, 400, { error: 'PROPOSAL_INVALID' });
      const proposal = validItems(note, submitted);
      if (proposal.length !== submitted.length) return send(res, 400, { error: 'PROPOSAL_INVALID' });
      const selected = Array.isArray(body.selected) ? new Set(body.selected.map(Number)) : new Set();
      if ([...selected].some((index)=>!Number.isInteger(index)||index<0||index>=proposal.length)) return send(res,400,{error:'SELECTION_INVALID'});
      const items = prepareItems(proposal.filter((_, index) => selected.has(index)), lead);
      let selectedIndex=0;
      for (let index=0;index<proposal.length;index++) if (selected.has(index)) {
        const item=items[selectedIndex++];
        if ((item.type==='promise'||item.type==='return'||item.type==='call_result'&&item.value==='LATER')&&!item.dueUtc) {
          const due=clientDateTime(body.manualDates?.[index],lead.timezone);
          if(!due)return send(res,400,{error:'DUE_DATE_REQUIRED',message:'Informe a data no horário do cliente.'});
          item.dueUtc=due;
        }
      }
      const initial = { name: lead.order?.contactName, vehicle: lead.order?.vehicleText, wishes: lead.wishes,
        maxBidCents: lead.maxBidCents, payment: lead.payment, deadline: lead.order?.deadlineText };
      const saved = await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_confirm_lead_note',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
          p_environment:ctx.environment,p_actor:ctx.panel.id,p_ref:lead.ref,p_journey:journey?.id||null,
          p_body:note,p_items:items,p_key:body.confirmationKey,p_initial:initial
        })
      });
      return send(res, 201, saved);
    }
    if (body.action === 'quick') {
      const type = String(body.type || '');
      const operationId = String(body.operationId || '');
      if (!isUuid(operationId)) return send(res, 400, { error: 'OPERATION_ID_REQUIRED' });
      const earlier = await rows(ctx, 'lead_events', { select:'id', environment:'eq.'+ctx.environment,ref_code:'eq.'+lead.ref, 'detail_json->>operationId':'eq.'+operationId,limit:'1' });
      if (earlier.length) return send(res, 200, { duplicate:true, eventId:earlier[0].id });
      const at = new Date().toISOString();
      let dueAt = null;
      if (type === 'LATER') {
        const due = Date.parse(body.dueLocal ? localToUtc(body.dueLocal, lead.timezone) : body.dueAt);
        if (!Number.isFinite(due) || due < Date.now()) return send(res, 400, { error: 'RETURN_DATE_INVALID' });
        dueAt = new Date(due).toISOString();
      } else if (['ANSWERED','NO_ANSWER','DEPOSIT'].includes(type)) {
        dueAt = type === 'DEPOSIT' ? at : addClientDays(Date.now(), lead.timezone, type === 'ANSWERED' ? 2 : 1);
      }
      const event = await quick(ctx, lead, journey, type, dueAt, operationId);
      return send(res, event.duplicate?200:201, event);
    }
    if (body.action === 'undo') {
      if(!isUuid(body.eventId)) return send(res,400,{error:'EVENT_ID_INVALID'});
      const result=await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/rpc/panel_undo_quick',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({p_environment:ctx.environment,p_ref:lead.ref,p_journey:journey.id,p_event:body.eventId,p_actor:ctx.panel.id})
      });
      return send(res,200,result);
    }
    if (body.action === 'checklist') {
      const point = Number(body.point);
      if (!Number.isInteger(point) || point < 1 || point > 6) return send(res, 400, { error: 'CHECKLIST_POINT_INVALID' });
      await patchRows(ctx, 'journey_checklist', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, point_number: 'eq.' + point }, { status: body.complete ? 'COMPLETE' : 'OPEN', completed_at: body.complete ? new Date().toISOString() : null, updated_at: new Date().toISOString() });
      await actionEvent(ctx,lead,journey,'CHECKLIST');
      return send(res, 200, { saved: true });
    }
    if (body.action === 'total_ceiling') {
      const amount=Number(body.amount);
      if(!Number.isFinite(amount)||amount<=0||amount>10000000) return send(res,400,{error:'CEILING_INVALID'});
      await patchRows(ctx,'journeys',{environment:'eq.'+ctx.environment,id:'eq.'+journey.id},{confirmed_total_ceiling_cents:Math.round(amount*100),updated_at:new Date().toISOString(),updated_by:ctx.panel.id});
      await actionEvent(ctx,lead,journey,'CEILING');
      return send(res,200,{saved:true});
    }
    if (body.action === 'promise_complete') {
      const table=body.kind==='OLD'?'promises':'lead_promises';
      const found=await rows(ctx,table,{select:'id',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,id:'eq.'+body.promiseId,limit:'1'});
      if(!found[0]) return send(res,404,{error:'PROMISE_NOT_FOUND'});
      await patchRows(ctx,table,{environment:'eq.'+ctx.environment,id:'eq.'+body.promiseId},{status:'FULFILLED',...(table==='promises'?{fulfilled_at:new Date().toISOString()}:{})});
      await actionEvent(ctx,lead,journey,'PROMISE');
      return send(res,200,{saved:true});
    }
    if (body.action === 'present') {
      const found = await rows(ctx, 'manheim_vehicles', { select: 'vehicle_json', environment: 'eq.' + ctx.environment, row_fingerprint: 'eq.' + String(body.fingerprint || ''), order: 'uploaded_at.desc', limit: '1' });
      const vehicle = found[0]?.vehicle_json || lead.offers.find((item) => item.rowFingerprint === body.fingerprint);
      if (!vehicle || !lead.offers.some((item) => item.rowFingerprint === body.fingerprint)) return send(res, 400, { error: 'VEHICLE_NOT_COMPATIBLE' });
      const details = { year: vehicle.year, make: vehicle.make, model: vehicle.model, trim: vehicle.trim, miles: vehicle.miles, location: vehicle.locationDisplay || vehicle.location, saleDate: vehicle.saleDate, vin: vehicle.vin, mmrCents: vehicle.mmrCents };
      const at = new Date().toISOString();
      const identity=vehicle.vin?'VIN:'+String(vehicle.vin).trim().toUpperCase():'CAR:'+ [vehicle.year,vehicle.make,vehicle.model,vehicle.miles,vehicle.saleDate].map((part)=>String(part||'').toLowerCase()).join('|');
      const existing=await rows(ctx,'units',{select:'id',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,vehicle_identity:'eq.'+identity,limit:'1'});
      if(existing[0]) return send(res,200,{unitId:existing[0].id,duplicate:true});
      let unit;
      try { unit = (await insert(ctx, 'units', { environment: ctx.environment, journey_id: journey.id, vehicle_text: [vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' '), details_json: details, vehicle_identity: identity, presented_at: at, status: 'PRESENTED', created_at: at, updated_at: at, created_by: ctx.panel.id, updated_by: ctx.panel.id }))[0]; }
      catch(error) { if(error.status===409) { const prior=await rows(ctx,'units',{select:'id',environment:'eq.'+ctx.environment,journey_id:'eq.'+journey.id,vehicle_identity:'eq.'+identity,limit:'1'});if(prior[0])return send(res,200,{unitId:prior[0].id,duplicate:true}); } throw error; }
      await patchRows(ctx, 'lead_tracking', { environment: 'eq.' + ctx.environment, ref_code: 'eq.' + lead.ref, step: 'lt.2' }, { step: 2, updated_at: at });
      await insert(ctx, 'lead_events', { environment: ctx.environment, ref_code: lead.ref, journey_id: journey.id, unit_id: unit.id, event_type: 'CAR_PRESENTED', detail_json: { vehicle: unit.vehicle_text }, occurred_at: at, created_by: ctx.panel.id }, false);
      return send(res, 201, { unitId: unit.id });
    }
    if (body.action === 'retail') {
      const unit = (await rows(ctx, 'units', { select: 'id,details_json', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id, id: 'eq.' + body.unitId, limit: '1' }))[0];
      const url = safeText(body.url, 500) || '';
      if (!unit || (url && !/^https:\/\/(?:www\.)?mycarscout\.net\//i.test(url))) return send(res, 400, { error: 'RETAIL_LINK_INVALID' });
      await patchRows(ctx, 'units', { environment: 'eq.' + ctx.environment, id: 'eq.' + unit.id }, { details_json: { ...unit.details_json, retailValue: Number(body.value) || null, retailUrl: url || null }, updated_at: new Date().toISOString() });
      await actionEvent(ctx,lead,journey,'RETAIL');
      return send(res, 200, { saved: true });
    }
    if (body.action === 'manual') {
      const action = safeText(body.panelAction, 100);
      if (!['next_action','unit','set_funnel','toggle_journey','return_update','invert_senders','resolve_divergence'].includes(action)) return send(res, 400, { error: 'ACTION_INVALID' });
      const payload={...body.payload,action,journeyId:journey.id};
      if(action==='next_action'&&payload.atLocal){ payload.at=clientDateTime(payload.atLocal,lead.timezone);delete payload.atLocal;if(!payload.at)return send(res,400,{error:'RETURN_DATE_INVALID'}); }
      const result = await delegate(req, payload);
      if (result.code >= 200 && result.code < 300) await actionEvent(ctx,lead,journey,action.toUpperCase());
      return send(res, result.code, result.data);
    }
    return send(res, 400, { error: 'LEAD_ACTION_INVALID' });
  } catch (error) {
    return send(res, error.status || 500, { error: error.message || 'LEAD_ACTION_FAILED' });
  }
};

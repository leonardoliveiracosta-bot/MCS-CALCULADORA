'use strict';

const { buildConversationTimeline, checklistSummary, shortDeadline, time } = require('../../panel-domain');
const { allRows, isUuid, panelMeta, requirePanel, rows, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const id = String((req.query && req.query.id) || '');
    if (!id) {
      const [items, contacts, phones, refs, messageLinks, messages, meta] = await Promise.all([
        allRows(ctx, 'journeys', {
          select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,budget_cents,customer_deadline_at,next_action_text,next_action_at,qualified_at,closed_reason,updated_at',
          environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
        }),
        allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'messages', { select: 'id,direction,body_text,occurred_at_utc,occurred_at_local,created_at', environment: 'eq.' + ctx.environment }),
        panelMeta(ctx)
      ]);
      const contactsById = new Map(contacts.map((item) => [item.id, item]));
      const messagesById = new Map(messages.map((item) => [item.id, item]));
      return send(res, 200, { environment: ctx.environment, items: items.map((item) => {
        const ownMessages = messageLinks.filter((link) => link.journey_id === item.id).map((link) => messagesById.get(link.message_id)).filter(Boolean).sort((a, b) => (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0) - (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0));
        return { ...item, contact: contactsById.get(item.contact_id) || null, phones: phones.filter((phone) => phone.contact_id === item.contact_id), refs: refs.filter((ref) => ref.journey_id === item.id), latestMessage: ownMessages[0] || null };
      }), meta });
    }
    if (!isUuid(id)) return send(res, 400, { error: 'JOURNEY_ID_INVALID' });
    const found = await rows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
      environment: 'eq.' + ctx.environment, id: 'eq.' + id, limit: '1'
    });
    const journey = found[0];
    if (!journey) return send(res, 404, { error: 'JOURNEY_NOT_FOUND' });
    const [contacts, phones, refs, checklist, evidence, promises, units, interactions, activities, divergences, declarations, links, messages, attachments, meta] = await Promise.all([
      rows(ctx, 'contacts', { select: 'id,display_name,location_text,profile_text,notes', environment: 'eq.' + ctx.environment, id: 'eq.' + journey.contact_id, limit: '1' }),
      allRows(ctx, 'contact_phones', { select: 'id,phone_e164,phone_raw,is_current,confirmed_at,retired_at', environment: 'eq.' + ctx.environment, contact_id: 'eq.' + journey.contact_id }),
      allRows(ctx, 'journey_refs', { select: 'id,ref_code,calculator_sid,source_message_id,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id }),
      allRows(ctx, 'journey_checklist', { select: 'id,point_number,point_label,status,completed_at,updated_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'point_number.asc' }),
      allRows(ctx, 'checklist_evidence', { select: 'id,checklist_id,message_id,excerpt_text,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'promises', { select: 'id,message_id,promise_text,due_at,due_text,status,fulfilled_at,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'due_at.asc' }),
      allRows(ctx, 'units', { select: 'id,vehicle_text,details_json,presented_at,last_customer_response_at,status,decline_reason,updated_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'presented_at.desc' }),
      allRows(ctx, 'interactions', { select: 'id,message_id,type,occurred_at,detail_text,next_action_at,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'occurred_at.desc' }),
      allRows(ctx, 'activity_log', { select: 'id,activity_type,occurred_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'occurred_at.desc' }),
      allRows(ctx, 'journey_divergences', { select: 'id,field,left_declaration_id,right_declaration_id,operational_declaration_id,status,resolved_at,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id }),
      allRows(ctx, 'journey_declarations', { select: 'id,field,source,value_text,value_json,message_id,calc_sid,calc_ref,declared_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, order: 'declared_at.desc' }),
      allRows(ctx, 'message_journeys', { select: 'message_id,association_source,associated_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id }),
      allRows(ctx, 'messages', { select: 'id,chat_id,channel,direction,body_text,occurred_at_local,timezone_assumed,occurred_at_utc,time_uncertain,original_order,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'attachments', { select: 'id,chat_id,message_id,kind,original_filename,mime_type,byte_size,verified_at,created_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id }),
      panelMeta(ctx)
    ]);
    const messageIds = new Set(links.map((item) => item.message_id));
    const conversation = messages.filter((item) => messageIds.has(item.id)).sort((a, b) => {
      const delta = (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0) - (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0);
      return delta || (Number(a.original_order) || 0) - (Number(b.original_order) || 0) || a.id.localeCompare(b.id);
    });
    const points = checklist.map((point) => ({ ...point, evidence: evidence.filter((item) => item.checklist_id === point.id) }));
    const timeline = buildConversationTimeline(conversation, interactions, activities);
    return send(res, 200, {
      environment: ctx.environment,
      item: {
        ...journey, contact: contacts[0] || null, phones, refs, checklist: points, checklistSummary: checklistSummary(points),
        shortDeadline: shortDeadline(journey.customer_deadline_at), promises, units,
        interactions, divergences, declarations, attachments, conversation, timeline
      },
      meta
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_RECORDS_ERROR' });
  }
};

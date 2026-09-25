'use strict';

const { checklistSummary, shortDeadline } = require('../../panel-domain');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const [journeys, contacts, phones, refs, messageLinks, messages, checklist, evidence, divergences, meta] = await Promise.all([
      allRows(ctx, 'journeys', {
        select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,budget_cents,payment_text,customer_deadline_at,customer_deadline_text,qualified_at,closed_reason,updated_at',
        environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
      }),
      allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'messages', { select: 'id,body_text,occurred_at_utc,occurred_at_local,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_checklist', { select: 'id,journey_id,point_number,point_label,status,completed_at', environment: 'eq.' + ctx.environment, order: 'point_number.asc' }),
      allRows(ctx, 'checklist_evidence', { select: 'id,checklist_id,message_id,excerpt_text,created_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_divergences', { select: 'id,journey_id,field,status,operational_declaration_id,created_at', environment: 'eq.' + ctx.environment }),
      panelMeta(ctx)
    ]);
    const evidenceByPoint = new Map();
    for (const item of evidence) {
      if (!evidenceByPoint.has(item.checklist_id)) evidenceByPoint.set(item.checklist_id, []);
      evidenceByPoint.get(item.checklist_id).push(item);
    }
    const contactsById = new Map(contacts.map((item) => [item.id, item]));
    const messagesById = new Map(messages.map((item) => [item.id, item]));
    const items = journeys.map((journey) => {
      const points = checklist.filter((item) => item.journey_id === journey.id).map((point) => ({ ...point, evidence: evidenceByPoint.get(point.id) || [] }));
      const ownMessages = messageLinks.filter((link) => link.journey_id === journey.id).map((link) => messagesById.get(link.message_id)).filter(Boolean).sort((a, b) => Date.parse(b.occurred_at_utc || b.occurred_at_local || b.created_at) - Date.parse(a.occurred_at_utc || a.occurred_at_local || a.created_at));
      return {
        ...journey, contact: contactsById.get(journey.contact_id) || null,
        phones: phones.filter((phone) => phone.contact_id === journey.contact_id), latestMessage: ownMessages[0] || null,
        refs: refs.filter((item) => item.journey_id === journey.id),
        checklist: points, checklistSummary: checklistSummary(points),
        divergences: divergences.filter((item) => item.journey_id === journey.id),
        shortDeadline: shortDeadline(journey.customer_deadline_at)
      };
    });
    return send(res, 200, { environment: ctx.environment, items, meta });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_QUALIFICATION_ERROR' });
  }
};

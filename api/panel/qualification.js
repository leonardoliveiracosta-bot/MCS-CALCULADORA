'use strict';

const { checklistSummary, shortDeadline } = require('../../panel-domain');
const { allRows, panelMeta, requirePanel, send } = require('../../panel-server');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    const [journeys, contacts, refs, checklist, evidence, divergences, meta] = await Promise.all([
      allRows(ctx, 'journeys', {
        select: 'id,contact_id,stage,status,vehicle_text,budget_cents,payment_text,customer_deadline_at,customer_deadline_text,qualified_at,closed_reason',
        environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
      }),
      allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
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
    const items = journeys.map((journey) => {
      const points = checklist.filter((item) => item.journey_id === journey.id).map((point) => ({ ...point, evidence: evidenceByPoint.get(point.id) || [] }));
      return {
        ...journey, contact: contactsById.get(journey.contact_id) || null,
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

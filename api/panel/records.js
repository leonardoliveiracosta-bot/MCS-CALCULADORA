'use strict';

const { buildConversationTimeline, buildReturns, checklistSummary, consolidateCalcRuns, groupCalculatorByRef, journeyEnabled, reactivationEligible, shortDeadline, time, wishlistForJourney, wishlistsForJourney } = require('../../panel-domain');
const { allRows, isUuid, panelMeta, requirePanel, rows, send } = require('../../panel-server');
const { score } = require('../../panel-ready');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  try {
    if (String((req.query && req.query.view) || '') === 'manheim') {
      const [journeys, contacts, toggleStates, uploads, meta] = await Promise.all([
        allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,stage,status,criteria_json,budget_cents,vehicle_text,updated_at', environment: 'eq.' + ctx.environment, order: 'updated_at.desc' }),
        allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }),
        rows(ctx, 'manheim_uploads', { select: 'id,source_file_count,vehicle_count,matched_vehicle_count,lead_count,headers_json,header_map,uploaded_at', environment: 'eq.' + ctx.environment, order: 'uploaded_at.desc', limit: '1' }),
        panelMeta(ctx)
      ]);
      const latest = uploads[0] || null;
      const matches = latest ? await allRows(ctx, 'manheim_matches', {
        select: 'id,journey_id,calc_ref,match_kind,match_reason,mmr_status,row_fingerprint,vehicle_json,presented_unit_id,created_at',
        environment: 'eq.' + ctx.environment, upload_id: 'eq.' + latest.id, order: 'created_at.asc'
      }) : [];
      const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
      const stateByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
      const items = journeys.map((journey) => {
        const state = stateByJourney.get(journey.id);
        const item = { ...journey, enabled: state ? state.enabled : journey.status !== 'ENCERRADO', toggleManaged: Boolean(state), offReason: state && state.off_reason || null, contact: contactsById.get(journey.contact_id) || null };
        return { ...item, wishlist: wishlistForJourney(item), wishlists: wishlistsForJourney(item), reactivationEligible: reactivationEligible(item) };
      });
      const [calcRuns, calcLinks, dispositions] = await Promise.all([
        allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
        allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment })
      ]);
      const orders = groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks), dispositions)
        .filter((order) => order.disposition !== 'DISCARDED');
      return send(res, 200, { environment: ctx.environment, items, orders, upload: latest, matches, meta });
    }
    const id = String((req.query && req.query.id) || '');
    if (!id) {
      const [items, contacts, phones, refs, messageLinks, messages, toggleStates, uploads, meta, checklist, promises, archive, calcRuns, calcLinks] = await Promise.all([
        allRows(ctx, 'journeys', {
          select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_text,customer_deadline_at,next_action_text,next_action_at,qualified_at,closed_reason,updated_at',
          environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
        }),
        allRows(ctx, 'contacts', { select: 'id,display_name,location_text', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'messages', { select: 'id,direction,body_text,occurred_at_utc,occurred_at_local,created_at', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }),
        rows(ctx, 'manheim_uploads', { select: 'id', environment: 'eq.' + ctx.environment, order: 'uploaded_at.desc', limit: '1' }),
        panelMeta(ctx),
        allRows(ctx, 'journey_checklist', { select: 'journey_id,status', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'promises', { select: 'journey_id,status,due_at', environment: 'eq.' + ctx.environment }),
        allRows(ctx, 'manheim_vehicles', { select: 'vehicle_json', environment: 'eq.' + ctx.environment, uploaded_at: 'gte.' + new Date(Date.now() - 60 * 86400000).toISOString() }),
        allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
        allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment })
      ]);
      const latestMatches = uploads[0] ? await allRows(ctx, 'manheim_matches', { select: 'journey_id', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploads[0].id }) : [];
      const contactsById = new Map(contacts.map((item) => [item.id, item]));
      const messagesById = new Map(messages.map((item) => [item.id, item]));
      const stateByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
      const ordersByRef = new Map(groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks)).map((order) => [order.ref, order]));
      return send(res, 200, { environment: ctx.environment, items: items.map((item) => {
        const ownMessages = messageLinks.filter((link) => link.journey_id === item.id).map((link) => messagesById.get(link.message_id)).filter(Boolean).sort((a, b) => (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0) - (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0));
        const state = stateByJourney.get(item.id);
        const complete = { ...item, enabled: state ? state.enabled : item.status !== 'ENCERRADO', toggleManaged: Boolean(state), offReason: state && state.off_reason || null, manheimMatchCount: latestMatches.filter((match) => match.journey_id === item.id).length, contact: contactsById.get(item.contact_id) || null, phones: phones.filter((phone) => phone.contact_id === item.contact_id), refs: refs.filter((ref) => ref.journey_id === item.id), latestMessage: ownMessages[0] || null };
        const order = ordersByRef.get(String(item.reference_code || '').trim());
        const scoring = { ...complete, zip: order?.zip || complete.contact?.location_text?.match(/\b\d{5}\b/)?.[0] || '', plate: order?.plate || 'transf', wishlists: wishlistsForJourney(complete) };
        return { ...complete, ...score(scoring, complete, { checklist, promises, messages: ownMessages.map((message) => ({ ...message, journey_id: item.id })) }, archive.map((entry) => entry.vehicle_json)) };
      }), meta });
    }
    if (!isUuid(id)) return send(res, 400, { error: 'JOURNEY_ID_INVALID' });
    const found = await rows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
      environment: 'eq.' + ctx.environment, id: 'eq.' + id, limit: '1'
    });
    const journey = found[0];
    if (!journey) return send(res, 404, { error: 'JOURNEY_NOT_FOUND' });
    const [contacts, phones, refs, checklist, evidence, promises, units, interactions, activities, divergences, declarations, links, messages, attachments, toggleStates, uploads, meta] = await Promise.all([
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
      rows(ctx, 'journey_toggle_states', { select: 'enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + id, limit: '1' }),
      rows(ctx, 'manheim_uploads', { select: 'id,uploaded_at', environment: 'eq.' + ctx.environment, order: 'uploaded_at.desc', limit: '1' }),
      panelMeta(ctx)
    ]);
    const manheimMatches = uploads[0] ? await allRows(ctx, 'manheim_matches', { select: 'id,match_kind', environment: 'eq.' + ctx.environment, upload_id: 'eq.' + uploads[0].id, journey_id: 'eq.' + id }) : [];
    const [calcRuns, calcLinks, dispositions, senderAliases] = await Promise.all([
      allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
      allRows(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,updated_at', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'chat_sender_aliases', { select: 'chat_id,sender_text,direction', environment: 'eq.' + ctx.environment })
    ]);
    const refSet = new Set([journey.reference_code, ...refs.map((ref) => ref.ref_code)].filter(Boolean).map((ref) => String(ref).toUpperCase()));
    const calculatorRequests = groupCalculatorByRef(consolidateCalcRuns(calcRuns, calcLinks), dispositions).filter((order) => refSet.has(order.ref));
    const messageIds = new Set(links.map((item) => item.message_id));
    const conversation = messages.filter((item) => messageIds.has(item.id)).sort((a, b) => {
      const delta = (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0) - (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0);
      return delta || (Number(a.original_order) || 0) - (Number(b.original_order) || 0) || a.id.localeCompare(b.id);
    });
    const points = checklist.map((point) => ({ ...point, evidence: evidence.filter((item) => item.checklist_id === point.id) }));
    const timeline = buildConversationTimeline(conversation, interactions, activities);
    const toggle = toggleStates[0];
    const enabled = toggle ? toggle.enabled : journey.status !== 'ENCERRADO';
    return send(res, 200, {
      environment: ctx.environment,
      item: {
        ...journey, enabled, toggleManaged: Boolean(toggle), offReason: toggle && toggle.off_reason || null, wishlist: wishlistForJourney(journey), wishlists: wishlistsForJourney(journey), contact: contacts[0] || null, phones, refs, checklist: points, checklistSummary: checklistSummary(points),
        shortDeadline: shortDeadline(journey.customer_deadline_at), promises, units,
        returns: buildReturns(journey, promises), interactions, divergences, declarations, attachments, conversation, timeline,
        calculatorRequests, senderAliases: senderAliases.filter((alias) => conversation.some((message) => message.chat_id === alias.chat_id)),
        manheimMatchCount: manheimMatches.length, manheimUploadAt: uploads[0] && uploads[0].uploaded_at || null
      },
      meta
    });
  } catch (_) {
    return send(res, 500, { error: 'PANEL_RECORDS_ERROR' });
  }
};

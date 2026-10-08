'use strict';

const { allRows, rows } = require('./panel-server');
const { toggleEnabled } = require('./panel-domain');
const { activeRows, outOfFunnelJourneys } = require('./panel-triage');

function flattenMessageLinks(links, messages) {
  const byId = new Map((Array.isArray(messages) ? messages : []).map((message) => [message.id, message]));
  return (Array.isArray(links) ? links : []).flatMap((link) => {
    const message = byId.get(link.message_id);
    return message ? [{ ...message, journey_id: link.journey_id }] : [];
  });
}

async function operational(ctx) {
  const [journeys, contacts, phones, refs, messageLinks, messages, checklist, promises, divergences, units, suppressions, toggleStates, userIds, activeTriage] = await Promise.all([
    allRows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_set_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
      environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
    }),
    allRows(ctx, 'contacts', { select: 'id,display_name,is_lead,location_text', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'contact_phones', { select: 'id,contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'message_journeys', {
      select: 'journey_id,message_id',
      environment: 'eq.' + ctx.environment, undone_at:'is.null'
    }),
    allRows(ctx, 'messages', { select: 'id,chat_id,channel,direction,body_text,is_automatic,occurred_at_local,occurred_at_utc,time_uncertain,source_kind,whatsapp_delivered_at,whatsapp_read_at,created_at,undone_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_checklist', { select: 'id,journey_id,point_number,point_label,status,completed_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'promises', { select: 'id,journey_id,message_id,promise_text,due_at,due_text,status,fulfilled_at,created_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_divergences', { select: 'id,journey_id,field,status,created_at,operational_declaration_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'units', { select: 'id,journey_id,vehicle_text,details_json,presented_at,last_customer_response_at,status,decline_reason,updated_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_alert_suppressions', { select: 'id,journey_id,kind,action,until_at,created_at,cancelled_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'whatsapp_user_ids', { select: 'contact_id,username', environment: 'eq.' + ctx.environment }),
    // The classification read does not depend on journeys or Refs; only applying it does.
    activeRows(ctx)
  ]);
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  // Triagem: a ficha cuja conversa ficou fora do funil comercial sai das listas (os dados ficam).
  const triageOut = outOfFunnelJourneys(activeTriage, journeys, refs);
  const excludedJourneyIds=new Set(journeys.filter((journey)=>contactsById.get(journey.contact_id)?.is_lead===false||triageOut.has(journey.id)).map((journey)=>journey.id));
  const excludedRefs=[...new Set(journeys.filter((journey)=>excludedJourneyIds.has(journey.id)).flatMap((journey)=>[journey.reference_code,...refs.filter((ref)=>ref.journey_id===journey.id).map((ref)=>ref.ref_code)]).filter(Boolean).map((ref)=>String(ref).trim().toUpperCase()))];
  const toggleByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
  return { journeys: journeys.filter((journey)=>!excludedJourneyIds.has(journey.id)).map((journey) => {
    const toggle = toggleByJourney.get(journey.id);
    const ownPhones=phones.filter((phone) => phone.contact_id === journey.contact_id),user=userIds.find((entry)=>entry.contact_id===journey.contact_id);
    return { ...journey, enabled: toggleEnabled(journey.status, toggle), toggleManaged: Boolean(toggle), offReason: toggle && toggle.off_reason || null, switchedAt: toggle && toggle.switched_at || null, contact: contactsById.get(journey.contact_id) || null, phones:ownPhones,whatsappUsername:user?.username||null,whatsappWithoutPhone:Boolean(user&&!ownPhones.some((phone)=>phone.is_current!==false)) };
  }), refs,excludedRefs, messages: flattenMessageLinks(messageLinks, messages.filter((message) => !message.undone_at)), checklist, promises, divergences, units, suppressions };
}

async function journeyExists(ctx, journeyId) {
  const found = await rows(ctx, 'journeys', {
    select: 'id,contact_id,reference_code,stage,status,stage_frozen,closed_reason,vehicle_text,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,next_action_at,next_action_set_at,next_action_text,next_action_missing_since,last_effective_contact_at,search_started_at,updated_at',
    environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1'
  });
  if (!found[0]) return null;
  const states = await rows(ctx, 'journey_toggle_states', { select: 'enabled,off_reason', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, limit: '1' });
  return { ...found[0], enabled: toggleEnabled(found[0].status, states[0]), toggleManaged: Boolean(states[0]), offReason: states[0] && states[0].off_reason || null };
}

async function messageForJourney(ctx, journeyId, messageId) {
  const links = await rows(ctx, 'message_journeys', {
    select: 'message_id',
    environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId,
    message_id: 'eq.' + messageId, undone_at:'is.null', limit: '1'
  });
  if (!links[0]) return null;
  const messages = await rows(ctx, 'messages', {
    select: 'id,chat_id,channel,direction,body_text,occurred_at_utc,occurred_at_local,whatsapp_delivered_at,whatsapp_read_at,created_at',
    environment: 'eq.' + ctx.environment, id: 'eq.' + messageId, limit: '1'
  });
  return messages[0] || null;
}

module.exports = { flattenMessageLinks, journeyExists, messageForJourney, operational };

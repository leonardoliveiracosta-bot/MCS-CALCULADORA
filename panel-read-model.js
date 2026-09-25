'use strict';

const { allRows, rows } = require('./panel-server');

function flattenMessageLinks(links, messages) {
  const byId = new Map((Array.isArray(messages) ? messages : []).map((message) => [message.id, message]));
  return (Array.isArray(links) ? links : []).flatMap((link) => {
    const message = byId.get(link.message_id);
    return message ? [{ ...message, journey_id: link.journey_id }] : [];
  });
}

async function operational(ctx) {
  const [journeys, contacts, phones, messageLinks, messages, checklist, promises, divergences, units, suppressions, toggleStates] = await Promise.all([
    allRows(ctx, 'journeys', {
      select: 'id,contact_id,reference_code,source,stage,status,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_at,customer_deadline_text,next_action_text,next_action_at,next_action_missing_since,last_effective_contact_at,search_started_at,qualified_at,closed_at,closed_reason,stage_frozen,created_at,updated_at',
      environment: 'eq.' + ctx.environment, order: 'updated_at.desc'
    }),
    allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'message_journeys', {
      select: 'journey_id,message_id',
      environment: 'eq.' + ctx.environment
    }),
    allRows(ctx, 'messages', { select: 'id,chat_id,channel,direction,body_text,occurred_at_local,occurred_at_utc,time_uncertain,created_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_checklist', { select: 'id,journey_id,point_number,point_label,status,completed_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'promises', { select: 'id,journey_id,message_id,promise_text,due_at,due_text,status,fulfilled_at,created_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_divergences', { select: 'id,journey_id,field,status,created_at,operational_declaration_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'units', { select: 'id,journey_id,vehicle_text,details_json,presented_at,last_customer_response_at,status,decline_reason,updated_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_alert_suppressions', { select: 'id,journey_id,kind,action,until_at,created_at,cancelled_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: 'eq.' + ctx.environment })
  ]);
  const contactsById = new Map(contacts.map((contact) => [contact.id, contact]));
  const toggleByJourney = new Map(toggleStates.map((state) => [state.journey_id, state]));
  return { journeys: journeys.map((journey) => {
    const toggle = toggleByJourney.get(journey.id);
    return { ...journey, enabled: toggle ? toggle.enabled : journey.status !== 'ENCERRADO', toggleManaged: Boolean(toggle), offReason: toggle && toggle.off_reason || null, contact: contactsById.get(journey.contact_id) || null, phones: phones.filter((phone) => phone.contact_id === journey.contact_id) };
  }), messages: flattenMessageLinks(messageLinks, messages), checklist, promises, divergences, units, suppressions };
}

async function journeyExists(ctx, journeyId) {
  const found = await rows(ctx, 'journeys', {
    select: 'id,contact_id,reference_code,stage,status,stage_frozen,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_text,next_action_at,next_action_text,next_action_missing_since,last_effective_contact_at,search_started_at,updated_at',
    environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1'
  });
  if (!found[0]) return null;
  const states = await rows(ctx, 'journey_toggle_states', { select: 'enabled,off_reason', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, limit: '1' });
  return { ...found[0], enabled: states[0] ? states[0].enabled : found[0].status !== 'ENCERRADO', toggleManaged: Boolean(states[0]), offReason: states[0] && states[0].off_reason || null };
}

async function messageForJourney(ctx, journeyId, messageId) {
  const links = await rows(ctx, 'message_journeys', {
    select: 'message_id',
    environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId,
    message_id: 'eq.' + messageId, limit: '1'
  });
  if (!links[0]) return null;
  const messages = await rows(ctx, 'messages', {
    select: 'id,chat_id,channel,direction,body_text,occurred_at_utc,occurred_at_local,created_at',
    environment: 'eq.' + ctx.environment, id: 'eq.' + messageId, limit: '1'
  });
  return messages[0] || null;
}

module.exports = { flattenMessageLinks, journeyExists, messageForJourney, operational };

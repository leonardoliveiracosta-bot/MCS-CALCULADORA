'use strict';

// Adendo: the same contact groups of HOJE and CLIENTES for the conversations listed in ENTRADA.
// Presentation only: reads what is already stored, never writes.
const { allRows } = require('./panel-server');
const groups = require('./panel-groups');
const { loadTopic } = require('./panel-topic');
const { loadVitrineOrigins } = require('./panel-vitrine-origin');

const MESSAGE_SELECT = 'id,chat_id,channel,source_kind,direction,body_text,is_automatic,occurred_at_utc,occurred_at_local,created_at,undone_at';

async function chatGroupIndex(ctx, preloaded = {}) {
  const env = 'eq.' + ctx.environment;
  const read = (table, query) => allRows(ctx, table, query).catch(() => []);
  const [chats, messages, links, journeys, toggles, topic, vitrineOrigins] = await Promise.all([
    preloaded.chats || read('chats', { select: 'id,contact_id', environment: env }),
    preloaded.messages || read('messages', { select: MESSAGE_SELECT, environment: env }),
    read('calculator_request_links', { select: 'contact_id,journey_id,logical_mode,linked_at', environment: env }),
    read('journeys', { select: 'id,contact_id,source,status,closed_at,next_action_at,next_action_text,last_effective_contact_at,created_at,updated_at', environment: env, order: 'updated_at.desc' }),
    read('journey_toggle_states', { select: 'journey_id,enabled,switched_at', environment: env }),
    preloaded.topic !== undefined ? preloaded.topic : loadTopic(ctx).catch(() => null),
    loadVitrineOrigins(ctx).catch(() => null)
  ]);
  const byChat = new Map();
  (messages || []).forEach((message) => { if (!byChat.has(message.chat_id)) byChat.set(message.chat_id, []); byChat.get(message.chat_id).push(message); });
  const toggleOf = new Map((toggles || []).map((row) => [row.journey_id, row]));
  const journeysOf = new Map();
  (journeys || []).forEach((journey) => { if (!journeysOf.has(journey.contact_id)) journeysOf.set(journey.contact_id, []); journeysOf.get(journey.contact_id).push(journey); });
  const now = Date.now();
  const index = new Map();
  (chats || []).forEach((chat) => {
    const own = journeysOf.get(chat.contact_id) || [];
    // The person's open ficha (the most recently updated); without one, the latest ficha.
    const journey = own.find((row) => row.status !== 'ENCERRADO') || own[0] || null;
    const ownIds = new Set(own.map((row) => row.id));
    const orders = (links || []).filter((link) => (chat.contact_id && link.contact_id === chat.contact_id) || (link.journey_id && ownIds.has(link.journey_id)))
      .map((link) => ({ logicalMode: link.logical_mode, occurredAt: link.linked_at }));
    const reading = topic ? topic.chat(chat.id) : null;
    const offTopic = reading && reading.offTopic && !orders.length ? reading : null;
    const summary = groups.summaryFromMessages(byChat.get(chat.id) || []);
    const toggle = journey ? toggleOf.get(journey.id) : null;
    const vitrine = vitrineOrigins ? vitrineOrigins.forPerson({ journeyId: journey ? journey.id : null, contactId: chat.contact_id }) : null;
    const group = groups.classify(groups.factsFor({ summary, orders, journey: journey ? { ...journey, enabled: toggle ? toggle.enabled : undefined, switchedAt: toggle ? toggle.switched_at : null } : null, offTopic, vitrine }), now);
    index.set(chat.id, { group, lastCustomerMessage: orders.length ? null : groups.latestCustomerMessage(summary), journeyId: journey ? journey.id : null });
  });
  return index;
}

module.exports = { chatGroupIndex, MESSAGE_SELECT };

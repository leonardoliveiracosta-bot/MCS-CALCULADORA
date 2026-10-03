'use strict';

// One definition of "entered in contact" for every panel list.  Calculator
// rows are retained in calc_runs; this module only decides whether to show one.
const { time, normalizeDeadline } = require('./panel-domain');

function data(row) { return row && row.dados && typeof row.dados === 'object' ? row.dados : {}; }
function refOf(row) { return String(data(row).ref || '').trim().toUpperCase(); }
function at(row) { return time(row?.occurred_at_utc || row?.occurred_at_local || row?.created_at || data(row).quando) || 0; }
function messageChannel(message) {
  if (message?.source_kind === 'WHATSAPP_WEBHOOK') return 'WHATSAPP';
  if (message?.source_kind === 'WHATSAPP_HISTORY') return 'WHATSAPP_HISTORY';
  if (message?.source_kind === 'SMS_SHORTCUT') return 'SMS';
  return 'IMPORTED';
}
function clickChannel(event) {
  const values = data(event);
  const value = String(values.evento || '').trim().toLowerCase();
  const channel = String(values.canal || '').trim().toLowerCase();
  if (value === 'sms' || (value === 'busca' && channel === 'sms')) return 'SMS_CLICK';
  if (value === 'whatsapp' || (value === 'busca' && channel === 'whatsapp')) return 'WHATSAPP_CLICK';
  // Older Find submissions recorded the contact click as "busca" without a
  // channel. Keep them visible, but never claim a channel we do not have.
  if (value === 'busca' && !channel) return 'CONTACT_CLICK_UNKNOWN';
  return null;
}

function contactIndex({ calcRuns = [], messages = [], messageLinks = [] } = {}) {
  const firstWebhookAt = messages.filter((message) => message.direction === 'CUSTOMER' && message.source_kind === 'WHATSAPP_WEBHOOK')
    .reduce((minimum, message) => Math.min(minimum, at(message) ?? Infinity), Infinity);
  const byJourney = new Map();
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const add = (map, key, entry) => { if (!key || !entry.at) return; if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  for (const link of messageLinks) {
    const message = messagesById.get(link.message_id);
    if (message && message.direction === 'CUSTOMER') add(byJourney, link.journey_id, { at: at(message), channel: messageChannel(message), source: 'MESSAGE' });
  }
  // A click on the calculator's WhatsApp or SMS button is not contact: the calculator never asks for
  // a phone, so whoever clicked and did not send a message cannot be reached. Only a message that
  // really arrived (WhatsApp, SMS print or shortcut, imported history) counts. A conversation that
  // arrived without the Ref still shows in ENTRADA (and as an AI link suggestion), so nobody who wrote
  // is lost. calcRuns is kept in the signature for the callers.
  void calcRuns;
  const facts = (input = {}) => {
    // Only messages linked to the ficha count; a Ref alone (input.ref, input.refs) never does.
    const entries = [...(byJourney.get(input.journeyId) || [])];
    entries.sort((left, right) => left.at - right.at || left.channel.localeCompare(right.channel));
    const latest = entries.at(-1) || null;
    return { entered: Boolean(latest), firstAt: entries[0]?.at || null, latestAt: latest?.at || null, channel: latest?.channel || null, firstWebhookAt: Number.isFinite(firstWebhookAt) ? firstWebhookAt : null };
  };
  return { facts, firstWebhookAt: Number.isFinite(firstWebhookAt) ? firstWebhookAt : null };
}

function heatFor(item) {
  const ai = String(item.aiHeat || item.heat || '').toUpperCase();
  if (['HOT', 'WARM', 'COLD'].includes(ai)) return { key: ai, source: 'AI' };
  const score = Number(item.score || 0);
  return { key: score >= 60 ? 'HOT' : score >= 35 ? 'WARM' : 'COLD', source: 'CALCULATED' };
}
// A13: the AI reading of a conversation is a snapshot. Its heat only counts while it is recent
// (7 days), was made on the latest message, and the ficha was not closed or qualified after it.
const INSIGHT_MAX_AGE_MS = 7 * 86400000;
function insightUsable(insight, journey, latestMessageId, now = Date.now()) {
  if (!insight || !insight.heat) return false;
  if (journey && (journey.status === 'ENCERRADO' || journey.enabled === false)) return false;
  if (latestMessageId && insight.last_ai_message_id && insight.last_ai_message_id !== latestMessageId) return false;
  const updated = time(insight.updated_at);
  if (!updated || now - updated > INSIGHT_MAX_AGE_MS) return false;
  const changedAt = Math.max(time(journey?.closed_at) || 0, time(journey?.qualified_at) || 0);
  return !(changedAt && updated < changedAt);
}
// Purchase window from the deadline the client gave in the calculator (or the ficha): NOW, 30D, 3M or NONE.
function purchaseWindowOf(item) {
  const simulations = Array.isArray(item && item.simulations) ? item.simulations : [];
  const latest = simulations.slice().sort((a, b) => (time(b && (b.occurredAt || b.created_at)) || 0) - (time(a && (a.occurredAt || a.created_at)) || 0)).map((entry) => entry && entry.deadlineText).find(Boolean);
  const value = normalizeDeadline(item && item.customer_deadline_text) || normalizeDeadline(item && item.deadlineText) || normalizeDeadline(latest);
  return value === 'now' ? 'NOW' : value === '30d' ? '30D' : value === '3m' ? '3M' : 'NONE';
}
function decorateContact(item, facts, insight, journey) {
  const result = { ...item, contactAt: facts.latestAt ? new Date(facts.latestAt).toISOString() : null, contactFirstAt: facts.firstAt ? new Date(facts.firstAt).toISOString() : null, contactChannel: facts.channel || item.contactChannel || null, enteredContact: facts.entered };
  const owner = journey || (item && item.status ? item : null);
  const latestId = item?.latestMessage?.id || null;
  if (insightUsable(insight, owner, latestId)) { result.aiHeat = insight.heat; result.aiSummary = insight.summary_text || ''; result.aiNextStep = insight.next_step_text || ''; }
  const heat = heatFor(result);
  return { ...result, heat: heat.key, heatSource: heat.source, purchaseWindow: purchaseWindowOf(journey ? { ...result, customer_deadline_text: journey.customer_deadline_text || result.customer_deadline_text } : result) };
}

module.exports = { purchaseWindowOf, contactIndex, decorateContact, heatFor, insightUsable, messageChannel, clickChannel, refOf, INSIGHT_SELECT: 'journey_id,heat,summary_text,next_step_text,last_ai_message_id,updated_at' };

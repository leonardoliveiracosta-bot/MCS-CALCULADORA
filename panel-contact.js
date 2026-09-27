'use strict';

// One definition of "entered in contact" for every panel list.  Calculator
// rows are retained in calc_runs; this module only decides whether to show one.
const { time } = require('./panel-domain');

function data(row) { return row && row.dados && typeof row.dados === 'object' ? row.dados : {}; }
function refOf(row) { return String(data(row).ref || '').trim().toUpperCase(); }
function at(row) { return time(row?.occurred_at_utc || row?.occurred_at_local || row?.created_at || data(row).quando) || 0; }
function messageChannel(message) {
  if (message?.source_kind === 'WHATSAPP_WEBHOOK') return 'WHATSAPP';
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
  const byJourney = new Map(), byRef = new Map();
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const add = (map, key, entry) => { if (!key || !entry.at) return; if (!map.has(key)) map.set(key, []); map.get(key).push(entry); };
  for (const link of messageLinks) {
    const message = messagesById.get(link.message_id);
    if (message && message.direction === 'CUSTOMER') add(byJourney, link.journey_id, { at: at(message), channel: messageChannel(message), source: 'MESSAGE' });
  }
  for (const row of calcRuns) {
    if (row.is_test === true) continue;
    const channel = clickChannel(row), ref = refOf(row);
    if (!channel || !ref) continue;
    // SMS clicks always count. A WhatsApp click only counts before the first
    // real webhook inbound message, preserving the permanent global cutover.
    if (channel === 'WHATSAPP_CLICK' && Number.isFinite(firstWebhookAt) && at(row) >= firstWebhookAt) continue;
    add(byRef, ref, { at: at(row), channel, source: 'CLICK' });
  }
  const facts = (input = {}) => {
    const refs = [input.ref, ...(input.refs || [])].filter(Boolean).map((value) => String(value).trim().toUpperCase());
    const entries = [...(byJourney.get(input.journeyId) || [])];
    refs.forEach((ref) => entries.push(...(byRef.get(ref) || [])));
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
function decorateContact(item, facts, insight) {
  const result = { ...item, contactAt: facts.latestAt ? new Date(facts.latestAt).toISOString() : null, contactFirstAt: facts.firstAt ? new Date(facts.firstAt).toISOString() : null, contactChannel: facts.channel || item.contactChannel || null, enteredContact: facts.entered };
  if (insight?.heat) { result.aiHeat = insight.heat; result.aiSummary = insight.summary_text || ''; result.aiNextStep = insight.next_step_text || ''; }
  const heat = heatFor(result);
  return { ...result, heat: heat.key, heatSource: heat.source };
}

module.exports = { contactIndex, decorateContact, heatFor, messageChannel, clickChannel, refOf };

'use strict';

const webpush = require('web-push');
const { allRows, isUuid, patchRows, query, rows, supabase } = require('./panel-server');
const { allowedCustomerChatIds, isEligibleCustomerMessage } = require('./panel-notifications');

const THROTTLE_MS = 5 * 60 * 1000;

function clean(value, maximum = 160) {
  const text = String(value || '').normalize('NFC').replace(/s+/g, ' ').trim();
  return text ? text.slice(0, maximum) : null;
}

function notificationTitle({ name, phone, ref, vehicle }) {
  const person = clean(name) || clean(phone) || 'Cliente';
  const parts = [person];
  if (clean(ref, 20)) parts.push('Ref ' + clean(ref, 20));
  if (clean(vehicle, 180)) parts.push(clean(vehicle, 180));
  if (parts.length === 1) parts.push('nova mensagem');
  return parts.join(' · ');
}

function canSendForContact(lastSentAt, now = Date.now()) {
  const previous = Date.parse(String(lastSentAt || ''));
  return !Number.isFinite(previous) || now - previous >= THROTTLE_MS;
}

function vapidDetails() {
  const publicKey = clean(process.env.VAPID_PUBLIC_KEY, 300);
  const privateKey = clean(process.env.VAPID_PRIVATE_KEY, 300);
  const subject = clean(process.env.VAPID_SUBJECT, 320);
  if (!publicKey || !privateKey || !subject || !/^mailto:|^https:///.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

function configureWebPush() {
  const details = vapidDetails();
  if (!details) return null;
  webpush.setVapidDetails(details.subject, details.publicKey, details.privateKey);
  return details;
}

function subscriptionPayload(subscription) {
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.p256dh, auth: subscription.auth }
  };
}

function errorStatus(error) {
  const status = Number(error && (error.statusCode || error.status));
  return Number.isInteger(status) ? status : null;
}

async function removeSubscription(ctx, id) {
  await supabase(ctx.config.url, ctx.config.secretKey,
    '/rest/v1/panel_push_subscriptions?' + query({ id: 'eq.' + id, environment: 'eq.' + ctx.environment }),
    { method: 'DELETE', headers: { prefer: 'return=minimal' } });
}

async function noteFailure(ctx, subscription, status) {
  await patchRows(ctx, 'panel_push_subscriptions', {
    id: 'eq.' + subscription.id, environment: 'eq.' + ctx.environment
  }, {
    failure_count: Math.min(Number(subscription.failure_count || 0) + 1, 9999),
    last_failure_at: new Date().toISOString(), last_failure_status: status
  });
}

async function subscriptionsFor(ctx, panelUserId) {
  return allRows(ctx, 'panel_push_subscriptions', {
    select: 'id,endpoint,p256dh,auth,failure_count', environment: 'eq.' + ctx.environment,
    ...(panelUserId ? { panel_user_id: 'eq.' + panelUserId } : {})
  });
}

async function deliverToSubscriptions(ctx, subscriptions, payload) {
  if (!configureWebPush()) return { accepted: 0, failed: 0, unavailable: true };
  let accepted = 0;
  let failed = 0;
  const body = JSON.stringify(payload);
  for (const subscription of subscriptions) {
    try {
      const response = await webpush.sendNotification(subscriptionPayload(subscription), body, { TTL: 60 });
      await patchRows(ctx, 'panel_push_subscriptions', {
        id: 'eq.' + subscription.id, environment: 'eq.' + ctx.environment
      }, { last_success_at: new Date().toISOString(), failure_count: 0, last_failure_at: null, last_failure_status: null });
      if (response.statusCode === 201) accepted++;
      else failed++;
    } catch (error) {
      failed++;
      const status = errorStatus(error);
      if (status === 404 || status === 410) await removeSubscription(ctx, subscription.id).catch(() => null);
      else await noteFailure(ctx, subscription, status).catch(() => null);
    }
  }
  return { accepted, failed, unavailable: false };
}

async function claimContactThrottle(ctx, contactId, messageId) {
  if (!isUuid(contactId)) return false;
  const claimed = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_claim_push_throttle', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_environment: ctx.environment, p_contact_id: contactId, p_message_id: messageId })
  });
  return claimed === true;
}

async function messageContext(ctx, candidate, allowedChatIds) {
  if (!isUuid(candidate.messageId)) return null;
  const message = (await rows(ctx, 'messages', {
    select: 'id,chat_id,channel,direction,is_automatic,source_kind', environment: 'eq.' + ctx.environment,
    id: 'eq.' + candidate.messageId, limit: '1'
  }))[0];
  if (!isEligibleCustomerMessage(message, allowedChatIds)) return null;
  const journeyId = isUuid(candidate.journeyId) ? candidate.journeyId : null;
  const journey = journeyId ? (await rows(ctx, 'journeys', {
    select: 'id,contact_id,reference_code,vehicle_text', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1'
  }))[0] : null;
  const contactId = isUuid(candidate.contactId) ? candidate.contactId : journey && journey.contact_id;
  const contact = isUuid(contactId) ? (await rows(ctx, 'contacts', {
    select: 'id,display_name', environment: 'eq.' + ctx.environment, id: 'eq.' + contactId, limit: '1'
  }))[0] : null;
  return { message, journey, contact, contactId, journeyId, phone: clean(candidate.phone, 40) };
}

async function sendPanelPush(ctx, input) {
  const subscriptions = await subscriptionsFor(ctx, input.panelUserId || null);
  if (!subscriptions.length) return { accepted: 0, failed: 0, skipped: 'NO_SUBSCRIPTIONS' };
  if (input.contactId) {
    const claimed = await claimContactThrottle(ctx, input.contactId, input.messageId || null);
    if (!claimed) return { accepted: 0, failed: 0, skipped: 'THROTTLED' };
  }
  return deliverToSubscriptions(ctx, subscriptions, input.payload);
}

async function sendCustomerMessagePushes(ctx, candidates) {
  if (!Array.isArray(candidates) || !candidates.length || !configureWebPush()) return { accepted: 0, failed: 0 };
  const allowedChatIds = await allowedCustomerChatIds(ctx);
  if (!allowedChatIds.size) return { accepted: 0, failed: 0 };
  let accepted = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const details = await messageContext(ctx, candidate, allowedChatIds).catch(() => null);
    if (!details || !details.contactId) continue;
    const title = notificationTitle({
      name: details.contact && details.contact.display_name, phone: details.phone,
      ref: details.journey && details.journey.reference_code, vehicle: details.journey && details.journey.vehicle_text
    });
    const result = await sendPanelPush(ctx, {
      contactId: details.contactId, messageId: details.message.id,
      payload: { type: 'customer-message', messageId: details.message.id, journeyId: details.journeyId, title }
    }).catch(() => ({ accepted: 0, failed: 0 }));
    accepted += result.accepted || 0;
    failed += result.failed || 0;
  }
  return { accepted, failed };
}

async function sendTestPush(ctx) {
  const subscriptions = await subscriptionsFor(ctx, ctx.panel.id);
  return deliverToSubscriptions(ctx, subscriptions, {
    type: 'test', messageId: null, journeyId: null,
    title: 'My Car Scout · aviso de teste', body: 'Seu dispositivo está pronto para receber avisos.'
  });
}

module.exports = {
  THROTTLE_MS, canSendForContact, deliverToSubscriptions, notificationTitle,
  sendCustomerMessagePushes, sendPanelPush, sendTestPush, vapidDetails
};

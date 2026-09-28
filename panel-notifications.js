'use strict';

const { allRows } = require('./panel-server');

const MAX_CURSOR_AGE_MS = 24 * 60 * 60 * 1000;

function notificationCursor(value, now = Date.now()) {
  const stamp = Date.parse(String(value || ''));
  if (!Number.isFinite(stamp) || stamp > now + 60 * 1000 || now - stamp > MAX_CURSOR_AGE_MS) return null;
  return new Date(stamp).toISOString();
}

function isEligibleCustomerMessage(message, allowedChatIds) {
  return message
    && message.channel === 'WHATSAPP'
    && message.direction === 'CUSTOMER'
    && message.is_automatic !== true
    && message.source_kind === 'WHATSAPP_WEBHOOK'
    && allowedChatIds.has(message.chat_id);
}

async function customerMessageNotifications(ctx, after) {
  const chats = await allRows(ctx, 'chats', {
    select: 'id', environment: 'eq.' + ctx.environment,
    channel: 'eq.WHATSAPP', is_group: 'is.false'
  });
  const allowedChatIds = new Set(chats.map((chat) => chat.id));
  if (!allowedChatIds.size) return [];

  const messages = await allRows(ctx, 'messages', {
    select: 'id,chat_id,channel,direction,is_automatic,source_kind,created_at',
    environment: 'eq.' + ctx.environment,
    chat_id: 'in.(' + [...allowedChatIds].join(',') + ')',
    channel: 'eq.WHATSAPP', direction: 'eq.CUSTOMER', is_automatic: 'is.false',
    source_kind: 'eq.WHATSAPP_WEBHOOK', created_at: 'gt.' + after,
    order: 'created_at.asc'
  });
  return messages.filter((message) => isEligibleCustomerMessage(message, allowedChatIds));
}

module.exports = { MAX_CURSOR_AGE_MS, customerMessageNotifications, isEligibleCustomerMessage, notificationCursor };

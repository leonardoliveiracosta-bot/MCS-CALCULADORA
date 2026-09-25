'use strict';

const crypto = require('crypto');
const { consolidateCalcRuns, normalizeContactPhone } = require('../../panel-domain');
const { allRows, requirePanel, send, supabase, isUuid } = require('../../panel-server');

const json = async (req) => {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const now = () => new Date().toISOString();
const query = (params) => new URLSearchParams(params).toString();
const normalized = (value) => String(value || '').normalize('NFC').replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '').trim().toLocaleLowerCase('pt-BR');

async function rows(ctx, table, params) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table + '?' + query(params));
}

async function phoneMatches(ctx, phoneRaw) {
  const normalizedPhone = normalizeContactPhone(phoneRaw);
  if (!normalizedPhone) return { normalizedPhone: null, contacts: [] };
  const phones = await rows(ctx, 'contact_phones', {
    select: 'contact_id,phone_e164,is_current', environment: 'eq.' + ctx.environment,
    phone_e164: 'eq.' + normalizedPhone, is_current: 'is.true'
  });
  const ids = [...new Set(phones.map((item) => item.contact_id))];
  const contacts = ids.length ? await rows(ctx, 'contacts', {
    select: 'id,display_name', environment: 'eq.' + ctx.environment,
    id: 'in.(' + ids.join(',') + ')'
  }) : [];
  return { normalizedPhone, contacts };
}

async function attachPhone(ctx, contactId, phoneRaw) {
  if (!String(phoneRaw || '').trim()) return null;
  const match = await phoneMatches(ctx, phoneRaw);
  if (!match.normalizedPhone) throw new Error('CONTACT_PHONE_INVALID');
  if (match.contacts.length) {
    if (match.contacts.some((item) => item.id === contactId)) return match.normalizedPhone;
    throw new Error('CONTACT_PHONE_CONFLICT');
  }
  const existing = await rows(ctx, 'contact_phones', {
    select: 'id,is_current', environment: 'eq.' + ctx.environment,
    contact_id: 'eq.' + contactId, phone_e164: 'eq.' + match.normalizedPhone, limit: '1'
  });
  if (existing[0]) {
    if (!existing[0].is_current) {
      await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contact_phones?id=eq.' + existing[0].id + '&environment=eq.' + ctx.environment, {
        method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
        body: JSON.stringify({ is_current: true, retired_at: null, confirmed_at: now() })
      });
    }
    return match.normalizedPhone;
  }
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contact_phones', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({
      environment: ctx.environment, contact_id: contactId, phone_e164: match.normalizedPhone,
      phone_raw: String(phoneRaw).normalize('NFC').trim().slice(0, 40), is_current: true,
      confirmed_at: now(), created_at: now(), created_by: ctx.panel.id
    })
  });
  return match.normalizedPhone;
}

async function createContact(ctx, name, channel, phoneRaw) {
  const displayName = String(name || '').normalize('NFC').trim().slice(0, 160);
  if (!displayName) return null;
  const match = String(phoneRaw || '').trim() ? await phoneMatches(ctx, phoneRaw) : { normalizedPhone: null, contacts: [] };
  if (String(phoneRaw || '').trim() && !match.normalizedPhone) throw new Error('CONTACT_PHONE_INVALID');
  if (match.contacts.length === 1) return match.contacts[0];
  if (match.contacts.length > 1) throw new Error('CONTACT_PHONE_AMBIGUOUS');
  const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({
      environment: ctx.environment, display_name: displayName,
      source: channel === 'SMS' ? 'SMS_DIRECT' : 'WHATSAPP_DIRECT',
      created_at: now(), updated_at: now(), created_by: ctx.panel.id, updated_by: ctx.panel.id
    })
  });
  if (phoneRaw) {
    try {
      await attachPhone(ctx, created[0].id, phoneRaw);
    } catch (failure) {
      await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts?id=eq.' + created[0].id + '&environment=eq.' + ctx.environment, {
        method: 'DELETE', headers: { prefer: 'return=minimal' }
      }).catch(() => null);
      throw failure;
    }
  }
  return created[0];
}

async function ensureContact(ctx, chat, channel) {
  if (chat.isGroup) return null;
  if (chat.contactId) {
    if (!isUuid(chat.contactId)) return false;
    const found = await rows(ctx, 'contacts', { select: 'id', environment: 'eq.' + ctx.environment, id: 'eq.' + chat.contactId, limit: '1' });
    if (!found[0]) return false;
    await attachPhone(ctx, found[0].id, chat.contactPhone);
    return found[0];
  }
  return createContact(ctx, chat.newContactName, channel, chat.contactPhone) || false;
}

async function matchContact(ctx, body) {
  const raw = String(body.phone || '').trim().slice(0, 40);
  const match = await phoneMatches(ctx, raw);
  if (!match.normalizedPhone) return send(ctx.res, 400, { error: 'CONTACT_PHONE_INVALID' });
  const matches = match.contacts.map((contact) => ({ id: contact.id, displayName: contact.display_name || 'Sem nome' }));
  return send(ctx.res, 200, {
    status: matches.length === 1 ? 'unique' : matches.length > 1 ? 'ambiguous' : 'none',
    normalizedPhone: match.normalizedPhone, phoneLast4: match.normalizedPhone.slice(-4), matches
  });
}

async function storeAlias(ctx, chatId, aliasText) {
  const alias = String(aliasText || '').normalize('NFC').trim().slice(0, 255);
  if (!alias) return;
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chat_aliases?on_conflict=environment,chat_id,alias_normalized', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      environment: ctx.environment, chat_id: chatId, alias_text: alias,
      alias_normalized: normalized(alias), first_seen_at: now(), last_seen_at: now(),
      confirmed_at: now(), confirmed_by: ctx.panel.id, created_at: now()
    })
  });
}

async function storeSenders(ctx, chatId, senderAliases) {
  if (!Array.isArray(senderAliases) || !senderAliases.length || senderAliases.length > 50) throw new Error('SENDER_ALIASES_INVALID');
  const payload = senderAliases.map((item) => {
    const text = String(item.senderText || '').normalize('NFC').trim().slice(0, 200);
    if (!text || !['CUSTOMER', 'MCS'].includes(item.direction)) throw new Error('SENDER_ALIAS_INVALID');
    return {
      environment: ctx.environment, chat_id: chatId, sender_text: text,
      sender_normalized: normalized(text), direction: item.direction,
      confirmed_at: now(), confirmed_by: ctx.panel.id, created_at: now()
    };
  });
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chat_sender_aliases?on_conflict=environment,chat_id,sender_normalized', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload)
  });
}

async function createJob(ctx, body) {
  const sourceKind = ['WHATSAPP_ZIP', 'WHATSAPP_TXT', 'SMS_PASTE'].includes(body.sourceKind) ? body.sourceKind : null;
  const chat = body.chat || {};
  const sourceSha = String(body.sourceSha256 || '');
  if (!sourceKind || !['WHATSAPP', 'SMS'].includes(chat.channel) || typeof chat.isGroup !== 'boolean' || !/^[a-f0-9]{64}$/i.test(sourceSha)) {
    return send(ctx.res, 400, { error: 'IMPORT_METADATA_INVALID' });
  }
  if (chat.chatId && chat.newContactName) return send(ctx.res, 409, { error: 'EXISTING_CHAT_CANNOT_CREATE_CONTACT' });
  const contact = await ensureContact(ctx, chat, chat.channel);
  if (contact === false) return send(ctx.res, 400, { error: 'CONTACT_NOT_FOUND' });
  let storedChat;
  if (chat.chatId) {
    if (!isUuid(chat.chatId)) return send(ctx.res, 400, { error: 'CHAT_ID_INVALID' });
    const found = await rows(ctx, 'chats', { select: 'id,contact_id,resolution_status,is_group,channel', environment: 'eq.' + ctx.environment, id: 'eq.' + chat.chatId, limit: '1' });
    storedChat = found[0];
    if (!storedChat || storedChat.channel !== chat.channel) return send(ctx.res, 400, { error: 'CHAT_NOT_FOUND' });
    if (Boolean(storedChat.is_group) !== chat.isGroup) return send(ctx.res, 409, { error: 'CHAT_TYPE_CONFLICT' });
    if (contact && storedChat.contact_id && storedChat.contact_id !== contact.id) return send(ctx.res, 409, { error: 'CHAT_CONTACT_CONFLICT' });
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats?id=eq.' + encodeURIComponent(storedChat.id) + '&environment=eq.' + ctx.environment, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({ contact_id: contact ? contact.id : null, resolution_status: chat.isGroup ? 'GROUP' : 'RESOLVED', last_seen_at: now(), updated_at: now() })
    });
  } else {
    const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify({
        environment: ctx.environment, channel: chat.channel, canonical_key: crypto.randomUUID(),
        contact_id: contact ? contact.id : null, resolution_status: chat.isGroup ? 'GROUP' : 'RESOLVED',
        is_group: chat.isGroup, first_seen_at: now(), last_seen_at: now(), created_at: now(), updated_at: now()
      })
    });
    storedChat = created[0];
  }
  await storeAlias(ctx, storedChat.id, chat.aliasText);
  if (chat.channel === 'WHATSAPP') await storeSenders(ctx, storedChat.id, chat.senderAliases);

  const jobs = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({
      environment: ctx.environment, chat_id: storedChat.id, channel: chat.channel, source_kind: sourceKind,
      source_filename: String(body.sourceFilename || '').slice(0, 255) || null,
      source_sha256: sourceSha,
      status: chat.isGroup ? 'REVIEW' : 'PROCESSING', selected_file_count: 1,
      review_reason: chat.isGroup ? 'grupo do WhatsApp exige revisão' : null, created_by: ctx.panel.id
    })
  });
  return send(ctx.res, 201, { importJobId: jobs[0].id, chatId: storedChat.id, contactId: contact ? contact.id : null });
}

async function createReview(ctx, body) {
  const sourceKind = ['WHATSAPP_ZIP', 'WHATSAPP_TXT'].includes(body.sourceKind) ? body.sourceKind : null;
  const sourceSha = String(body.sourceSha256 || '');
  if (!sourceKind || !/^[a-f0-9]{64}$/i.test(sourceSha)) return send(ctx.res, 400, { error: 'IMPORT_METADATA_INVALID' });
  const jobs = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({
      environment: ctx.environment, channel: 'WHATSAPP', source_kind: sourceKind,
      source_filename: String(body.sourceFilename || '').slice(0, 255) || null,
      source_sha256: sourceSha,
      status: 'REVIEW', message_count: 0, review_reason: 'formato não suportado',
      created_by: ctx.panel.id, completed_at: now()
    })
  });
  return send(ctx.res, 201, { importJobId: jobs[0].id, status: 'REVIEW' });
}

async function receiveBatch(ctx, body) {
  if (!isUuid(body.importJobId) || !Number.isInteger(Number(body.batchNumber)) || Number(body.batchNumber) < 1) return send(ctx.res, 400, { error: 'IMPORT_BATCH_INVALID' });
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const bytes = Buffer.byteLength(JSON.stringify(messages), 'utf8');
  if (!messages.length || messages.length > 500 || bytes > 1024 * 1024) return send(ctx.res, 400, { error: 'IMPORT_BATCH_LIMIT' });
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_reconcile_import_batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      p_environment: ctx.environment, p_import_job_id: body.importJobId,
      p_batch_number: Number(body.batchNumber),
      p_payload_sha256: crypto.createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
      p_messages: messages
    })
  });
  return send(ctx.res, 200, { inserted: result[0] ? result[0].inserted_count : 0, alreadyPresent: result[0] ? result[0].already_present_count : 0 });
}

async function recordImportedInteractions(ctx, importJobId, journeyId) {
  if (!isUuid(journeyId)) return;
  const importedRows = await allRows(ctx, 'messages', {
    select: 'id,direction,occurred_at_utc,created_at', environment: 'eq.' + ctx.environment,
    import_job_id: 'eq.' + importJobId, direction: 'neq.SYSTEM', order: 'created_at.asc'
  });
  const associated = await allRows(ctx, 'message_journeys', {
    select: 'message_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId
  });
  const associatedIds = new Set(associated.map((item) => item.message_id));
  const imported = importedRows.filter((item) => associatedIds.has(item.id) && item.occurred_at_utc);
  if (!imported.length) return;
  const existing = await allRows(ctx, 'interactions', {
    select: 'message_id', environment: 'eq.' + ctx.environment,
    journey_id: 'eq.' + journeyId, message_id: 'not.is.null'
  });
  const known = new Set(existing.map((item) => item.message_id));
  const payload = imported.filter((item) => !known.has(item.id)).map((item) => ({
    environment: ctx.environment, journey_id: journeyId, message_id: item.id,
    type: item.direction === 'MCS' ? 'OUTBOUND_MESSAGE' : 'INBOUND_MESSAGE',
    occurred_at: item.occurred_at_utc || item.created_at, detail_text: null,
    created_at: now(), created_by: ctx.panel.id
  }));
  for (let offset = 0; offset < payload.length; offset += 500) {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/interactions', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify(payload.slice(offset, offset + 500))
    });
  }
  const effective = imported.filter((item) => item.direction === 'MCS').sort((a, b) => Date.parse(a.occurred_at_utc || a.created_at) - Date.parse(b.occurred_at_utc || b.created_at)).at(-1);
  const latestEvent = imported.slice().sort((a, b) => Date.parse(a.occurred_at_utc || a.created_at) - Date.parse(b.occurred_at_utc || b.created_at)).at(-1);
  const journeys = await rows(ctx, 'journeys', { select: 'id,stage,status,stage_frozen,next_action_at,last_effective_contact_at', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' });
  const journey = journeys[0];
  if (!journey || journey.stage_frozen || journey.status === 'ENCERRADO') return;
  if (effective) {
    const effectiveAt = effective.occurred_at_utc || effective.created_at;
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/journeys?id=eq.' + journeyId + '&environment=eq.' + ctx.environment, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
      body: JSON.stringify({
        stage: journey.stage === 'NOVO' ? 'RESPONDIDO' : journey.stage,
        last_effective_contact_at: effectiveAt,
        next_action_missing_since: journey.next_action_at ? null : effectiveAt,
        updated_at: now(), updated_by: ctx.panel.id
      })
    });
  }
  const eventAt = latestEvent.occurred_at_utc || latestEvent.created_at;
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/journey_alert_suppressions?environment=eq.' + ctx.environment + '&journey_id=eq.' + journeyId + '&cancelled_at=is.null&created_at=lt.' + encodeURIComponent(eventAt), {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ cancelled_at: now(), cancelled_by: ctx.panel.id })
  });
}

async function linkUniqueCalculatorRef(ctx, journeyId, refs) {
  if (!isUuid(journeyId) || !Array.isArray(refs) || refs.length !== 1) return null;
  const calcRuns = await allRows(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados', order: 'created_at.asc' });
  const matches = consolidateCalcRuns(calcRuns).filter((item) => item.ref === refs[0]);
  if (matches.length !== 1) return null;
  const request = matches[0];
  const existing = await rows(ctx, 'calculator_request_links', { select: 'id', environment: 'eq.' + ctx.environment, calc_ref: 'eq.' + request.ref, logical_mode: 'eq.' + request.logicalMode, limit: '1' });
  if (existing[0]) return null;
  const journeys = await rows(ctx, 'journeys', { select: 'id,contact_id,vehicle_text,budget_cents,payment_text,customer_deadline_text', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' });
  const journey = journeys[0];
  if (!journey) return null;
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/calculator_request_links', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ environment: ctx.environment, calc_sid: request.sid, calc_ref: request.ref, logical_mode: request.logicalMode, contact_id: journey.contact_id, journey_id: journey.id, linked_at: now(), linked_by: ctx.panel.id })
  });
  const patch = { updated_at: now(), updated_by: ctx.panel.id };
  if (!journey.vehicle_text && request.vehicleText) patch.vehicle_text = request.vehicleText;
  if (!journey.budget_cents && request.budgetCents) patch.budget_cents = request.budgetCents;
  if (!journey.payment_text && request.paymentText) patch.payment_text = request.paymentText;
  if (!journey.customer_deadline_text && request.deadlineText) patch.customer_deadline_text = request.deadlineText;
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/journeys?id=eq.' + journey.id + '&environment=eq.' + ctx.environment, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(patch)
  });
  return request.ref;
}

async function finishJob(ctx, body) {
  if (!isUuid(body.importJobId)) return send(ctx.res, 400, { error: 'IMPORT_JOB_ID_INVALID' });
  const jobs = await rows(ctx, 'import_jobs', { select: 'id,chat_id', id: 'eq.' + body.importJobId, environment: 'eq.' + ctx.environment, limit: '1' });
  if (!jobs[0]) return send(ctx.res, 404, { error: 'IMPORT_JOB_NOT_FOUND' });
  const chats = await rows(ctx, 'chats', { select: 'id,contact_id,resolution_status,is_group', id: 'eq.' + jobs[0].chat_id, environment: 'eq.' + ctx.environment, limit: '1' });
  const chat = chats[0];
  if (!chat) return send(ctx.res, 404, { error: 'CHAT_NOT_FOUND' });
  const uncertain = await rows(ctx, 'messages', { select: 'id', environment: 'eq.' + ctx.environment, import_job_id: 'eq.' + body.importJobId, time_uncertain: 'is.true', limit: '1' });
  let journeyId = null;
  if (!chat.is_group) {
    const journey = body.journey || {};
    if (!chat.contact_id || !['new', 'existing'].includes(journey.mode)) return send(ctx.res, 400, { error: 'JOURNEY_CHOICE_REQUIRED' });
    if (journey.mode === 'existing' && !isUuid(journey.journeyId)) return send(ctx.res, 400, { error: 'JOURNEY_ID_INVALID' });
    const refs = Array.isArray(body.refs) ? body.refs.map((item) => String(item).toUpperCase()).filter((item) => /^[A-HJ-NP-Z2-9]{5}$/.test(item)).slice(0, 20) : [];
    const resolved = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_finalize_import_resolution', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        p_environment: ctx.environment, p_import_job_id: body.importJobId,
        p_contact_id: chat.contact_id, p_journey_id: journey.mode === 'existing' ? journey.journeyId : null,
        p_create_new: journey.mode === 'new', p_refs: refs, p_actor_id: ctx.panel.id
      })
    });
    journeyId = resolved;
    await recordImportedInteractions(ctx, body.importJobId, journeyId);
    await linkUniqueCalculatorRef(ctx, journeyId, refs);
  }
  const pending = Boolean(chat.is_group || uncertain.length);
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs?id=eq.' + encodeURIComponent(body.importJobId), {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify({ status: pending ? 'REVIEW' : 'COMPLETED', completed_at: now(), review_reason: chat.is_group ? 'grupo do WhatsApp exige revisão' : uncertain.length ? 'hora incerta exige revisão' : null })
  });
  return send(ctx.res, 200, { pending, destination: pending ? 'ENTRADA' : 'FICHAS', journeyId });
}

async function queue(ctx, res) {
  const [chats, counts, contacts, contactPhones, journeys, journeyRefs, chatAliases, senderAliases, reviews] = await Promise.all([
    allRows(ctx, 'chats', { select: 'id,channel,canonical_key,resolution_status,is_group,last_seen_at,contact_id', environment: 'eq.' + ctx.environment, order: 'last_seen_at.desc' }),
    supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_last_import_counts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment }) }),
    allRows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment, order: 'display_name.asc' }),
    allRows(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current', environment: 'eq.' + ctx.environment, is_current: 'is.true' }),
    allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,vehicle_text,stage,status,created_at', environment: 'eq.' + ctx.environment, status: 'neq.ENCERRADO', stage: 'neq.QUALIFICADO', order: 'updated_at.desc' }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'chat_aliases', { select: 'chat_id,alias_text,alias_normalized', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'chat_sender_aliases', { select: 'chat_id,sender_text,direction', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'import_jobs', { select: 'id,source_filename,review_reason', environment: 'eq.' + ctx.environment, status: 'eq.REVIEW', review_reason: 'eq.formato não suportado', order: 'created_at.desc' })
  ]);
  const byChat = Object.fromEntries(counts.map((item) => [item.chat_id, item]));
  const contactsWithPhone = contacts.map((contact) => {
    const phone = contactPhones.find((item) => item.contact_id === contact.id);
    const digits = String(phone && (phone.phone_e164 || phone.phone_raw) || '').replace(/\D/g, '');
    return { ...contact, phoneLast4: digits.slice(-4) || null };
  });
  const contactsById = new Map(contactsWithPhone.map((item) => [item.id, item]));
  return send(res, 200, {
    chats: chats.map((chat) => ({ ...chat, contact: contactsById.get(chat.contact_id) || null, newMessageCount: byChat[chat.id] ? byChat[chat.id].inserted_count : 0, hasTimeUncertain: Boolean(byChat[chat.id] && byChat[chat.id].has_time_uncertain) })),
    reviews, contacts: contactsWithPhone, journeys: journeys.map((journey) => ({ ...journey, refs: journeyRefs.filter((item) => item.journey_id === journey.id) })), chatAliases, senderAliases
  });
}

async function resolveChat(ctx, body) {
  if (!isUuid(body.chatId)) return send(ctx.res, 400, { error: 'CHAT_ID_INVALID' });
  const chats = await rows(ctx, 'chats', { select: 'id,contact_id', id: 'eq.' + body.chatId, environment: 'eq.' + ctx.environment, limit: '1' });
  if (!chats[0]) return send(ctx.res, 404, { error: 'CHAT_NOT_FOUND' });
  if (body.resolution === 'review') {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats?id=eq.' + body.chatId + '&environment=eq.' + ctx.environment, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ resolution_status: 'REVIEW', updated_at: now() })
    });
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/activity_log', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ environment: ctx.environment, contact_id: chats[0].contact_id, chat_id: body.chatId, activity_type: 'ENTRY_KEPT_IN_REVIEW', summary: 'Conversa mantida em revisão', metadata: {}, occurred_at: now(), actor_user_id: ctx.panel.id })
    });
    return send(ctx.res, 200, { status: 'REVIEW' });
  }
  return send(ctx.res, 400, { error: 'RESOLUTION_INVALID' });
}

module.exports = async (req, res) => {
  const ctx = await requirePanel(req, res);
  if (!ctx) return;
  ctx.res = res;
  let action = null;
  try {
    if (req.method === 'GET') return queue(ctx, res);
    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const input = await json(req);
    action = input.action;
    if (action === 'start') return createJob(ctx, input);
    if (action === 'match_contact') return matchContact(ctx, input);
    if (action === 'review') return createReview(ctx, input);
    if (action === 'batch') return receiveBatch(ctx, input);
    if (action === 'finish') return finishJob(ctx, input);
    if (action === 'resolve') return resolveChat(ctx, input);
    return send(res, 400, { error: 'IMPORT_ACTION_INVALID' });
  } catch (_) {
    const safeErrors = {
      start: 'IMPORT_START_FAILED', review: 'IMPORT_START_FAILED',
      batch: 'IMPORT_BATCH_FAILED', finish: 'IMPORT_FINISH_FAILED',
      resolve: 'IMPORT_RESOLUTION_FAILED', match_contact: 'CONTACT_MATCH_FAILED'
    };
    if (['CONTACT_PHONE_INVALID', 'CONTACT_PHONE_CONFLICT', 'CONTACT_PHONE_AMBIGUOUS'].includes(_.message)) return send(res, 409, { error: _.message });
    return send(res, 500, { error: safeErrors[action] || 'IMPORT_REQUEST_FAILED' });
  }
};

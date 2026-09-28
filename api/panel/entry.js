'use strict';

const crypto = require('crypto');
const { consolidateCalcRuns } = require('../../panel-domain');
const { allRows, requirePanel, send, supabase, isUuid } = require('../../panel-server');
const { normalizePhone } = require('../../panel-phone');
const { lastRealMessageAt } = require('../../panel-sort');

const json = async (req) => {
  if (typeof req.body === 'object' && req.body !== null) return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};
const now = () => new Date().toISOString();
const query = (params) => new URLSearchParams(params).toString();
const normalized = (value) => String(value || '').normalize('NFC').replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, '').trim().toLocaleLowerCase('pt-BR');
const identityName = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/^~+\s*/, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, '');
const inferredContactName = (value) => String(value || '').replace(/\.txt$/i, '').replace(/^WhatsApp Chat with\s+/i, '').replace(/^Conversa do WhatsApp com\s+/i, '').replace(/^chat(?:\s+with)?\s+/i, '').trim();

async function rows(ctx, table, params) {
  return supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/' + table + '?' + query(params));
}

async function createContact(ctx, name, channel) {
  const displayName = String(name || '').normalize('NFC').trim().slice(0, 160);
  if (!displayName) return null;
  const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({
      environment: ctx.environment, display_name: displayName,
      source: channel === 'SMS' ? 'SMS_DIRECT' : 'WHATSAPP_DIRECT',
      created_at: now(), updated_at: now(), created_by: ctx.panel.id, updated_by: ctx.panel.id
    })
  });
  return created[0];
}

async function ensureContact(ctx, chat, channel) {
  if (chat.isGroup) return null;
  if (chat.contactId) {
    if (!isUuid(chat.contactId)) return false;
    const found = await rows(ctx, 'contacts', { select: 'id,display_name', environment: 'eq.' + ctx.environment, id: 'eq.' + chat.contactId, limit: '1' });
    return found[0] || false;
  }
  return createContact(ctx, chat.newContactName, channel) || false;
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

async function storeSenders(ctx, chatId, senderAliases, contactName, sourceName) {
  if (!Array.isArray(senderAliases) || !senderAliases.length || senderAliases.length > 50) throw new Error('SENDER_ALIASES_INVALID');
  const forbidden = [contactName, inferredContactName(sourceName)].map(identityName).filter(Boolean);
  const payload = senderAliases.map((item) => {
    const text = String(item.senderText || '').normalize('NFC').trim().slice(0, 200);
    if (!text || !['CUSTOMER', 'MCS'].includes(item.direction)) throw new Error('SENDER_ALIAS_INVALID');
    if (item.direction === 'MCS' && forbidden.includes(identityName(text))) throw new Error('MCS_SENDER_CONTACT_CONFLICT');
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
  const newPhone=sourceKind==='SMS_PASTE'&&!chat.contactId?normalizePhone(chat.phone):null;
  if(sourceKind==='SMS_PASTE'&&!chat.contactId&&!newPhone)return send(ctx.res,400,{error:'PHONE_REQUIRED'});
  const contact = await ensureContact(ctx, chat, chat.channel);
  if (contact === false) return send(ctx.res, 400, { error: 'CONTACT_NOT_FOUND' });
  if(newPhone)await supabase(ctx.config.url,ctx.config.secretKey,'/rest/v1/contact_phones',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({environment:ctx.environment,contact_id:contact.id,phone_raw:chat.phone,phone_e164:newPhone,is_current:true,is_primary:true,created_at:now(),created_by:ctx.panel.id})});
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
  if (chat.channel === 'WHATSAPP') await storeSenders(ctx, storedChat.id, chat.senderAliases, contact && contact.display_name, chat.aliasText || body.sourceFilename);

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
    select: 'id,direction,is_automatic,occurred_at_utc,created_at', environment: 'eq.' + ctx.environment,
    import_job_id: 'eq.' + importJobId, direction: 'neq.SYSTEM', order: 'created_at.asc'
  });
  const associated = await allRows(ctx, 'message_journeys', {
    select: 'message_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, undone_at:'is.null'
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
  const effective = imported.filter((item) => item.direction === 'MCS' && !item.is_automatic).sort((a, b) => Date.parse(a.occurred_at_utc || a.created_at) - Date.parse(b.occurred_at_utc || b.created_at)).at(-1);
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
  const [chats, counts, contacts, journeys, journeyRefs, chatAliases, senderAliases, reviews, chatMessages] = await Promise.all([
    allRows(ctx, 'chats', { select: 'id,channel,canonical_key,resolution_status,is_group,last_seen_at,contact_id', environment: 'eq.' + ctx.environment, order: 'last_seen_at.desc' }),
    supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_last_import_counts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment }) }),
    allRows(ctx, 'contacts', { select: 'id,display_name,is_lead', environment: 'eq.' + ctx.environment, order: 'display_name.asc' }),
    allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code,vehicle_text,stage,status,created_at', environment: 'eq.' + ctx.environment, status: 'neq.ENCERRADO', stage: 'neq.QUALIFICADO', order: 'updated_at.desc' }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'chat_aliases', { select: 'chat_id,alias_text,alias_normalized', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'chat_sender_aliases', { select: 'chat_id,sender_text,direction', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'import_jobs', { select: 'id,source_filename,review_reason', environment: 'eq.' + ctx.environment, status: 'eq.REVIEW', review_reason: 'eq.formato não suportado', order: 'created_at.desc' }),
    allRows(ctx, 'messages', { select: 'chat_id,is_automatic,occurred_at_utc,occurred_at_local,undone_at', environment: 'eq.' + ctx.environment })
  ]);
  /* ordem Mais recentes/antigas: ultima mensagem real da conversa (last_seen_at foi atualizado pela importacao) */
  const messagesByChat = new Map();
  chatMessages.forEach((message) => { if (!messagesByChat.has(message.chat_id)) messagesByChat.set(message.chat_id, []); messagesByChat.get(message.chat_id).push(message); });
  const byChat = Object.fromEntries(counts.map((item) => [item.chat_id, item]));
  const contactsById = new Map(contacts.map((item) => [item.id, item]));
  return send(res, 200, {
    chats: chats.map((chat) => ({ ...chat, lastRealMessageAt: lastRealMessageAt(messagesByChat.get(chat.id)), sortAt: lastRealMessageAt(messagesByChat.get(chat.id)), contact: contactsById.get(chat.contact_id) || null, newMessageCount: byChat[chat.id] ? byChat[chat.id].inserted_count : 0, hasTimeUncertain: Boolean(byChat[chat.id] && byChat[chat.id].has_time_uncertain) })),
    reviews, contacts, journeys: journeys.map((journey) => ({ ...journey, refs: journeyRefs.filter((item) => item.journey_id === journey.id) })), chatAliases, senderAliases
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

const checklistLabels = [
  'Carro ou faixa de valor definido',
  'Teto confirmado pelo cliente depois da conversa',
  'Forma de pagamento', 'Prazo',
  'Aceita carro fora da Flórida com custo de transporte',
  'Entendeu o modelo sem test drive e sem devolução'
];

async function reviewTarget(ctx, body) {
  const kind = body.kind === 'review' ? 'review' : 'chat';
  if (!isUuid(body.id)) return null;
  if (kind === 'review') {
    const jobs = await rows(ctx, 'import_jobs', { select: 'id,status,review_reason,source_filename,chat_id', environment: 'eq.' + ctx.environment, id: 'eq.' + body.id, limit: '1' });
    return jobs[0] ? { kind, row: jobs[0] } : null;
  }
  const chats = await rows(ctx, 'chats', { select: 'id,contact_id,resolution_status,canonical_key,channel,is_group', environment: 'eq.' + ctx.environment, id: 'eq.' + body.id, limit: '1' });
  return chats[0] ? { kind, row: chats[0] } : null;
}

async function journeyTarget(ctx, journeyId) {
  if (!isUuid(journeyId)) return null;
  const found = await rows(ctx, 'journeys', { select: 'id,contact_id,status,stage', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' });
  return found[0] && found[0].status !== 'ENCERRADO' ? found[0] : null;
}

async function createReviewJourney(ctx, target) {
  let contactId = target.kind === 'chat' ? target.row.contact_id : null;
  let createdContactId = null;
  if (!contactId) {
    const suggested = target.row.source_filename || target.row.canonical_key || 'Lead da entrada';
    const contact = await createContact(ctx, inferredContactName(suggested) || 'Lead da entrada', target.row.channel || 'WHATSAPP');
    if (!contact) throw new Error('CONTACT_CREATE_FAILED');
    contactId = createdContactId = contact.id;
  } else {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts?id=eq.' + contactId + '&environment=eq.' + ctx.environment, {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ is_lead: true, updated_at: now(), updated_by: ctx.panel.id })
    });
  }
  const journeys = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/journeys', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
    body: JSON.stringify({ environment: ctx.environment, contact_id: contactId, source: target.row.channel === 'SMS' ? 'SMS_DIRECT' : 'WHATSAPP_DIRECT', stage: 'NOVO', status: 'ATIVO', criteria_json: {}, stage_frozen: false, created_at: now(), updated_at: now(), created_by: ctx.panel.id, updated_by: ctx.panel.id })
  });
  const journey = journeys[0];
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/journey_checklist', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=minimal' },
    body: JSON.stringify(checklistLabels.map((label, index) => ({ environment: ctx.environment, journey_id: journey.id, point_number: index + 1, point_label: label, status: 'OPEN', created_at: now(), updated_at: now() })))
  });
  return { journey, createdContactId };
}

async function associateReviewChat(ctx, chat, journey) {
  const messages = await allRows(ctx, 'messages', { select: 'id', environment: 'eq.' + ctx.environment, chat_id: 'eq.' + chat.id });
  const existing = await allRows(ctx, 'message_journeys', { select: 'message_id,undone_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journey.id });
  const existingById = new Map(existing.map((row) => [row.message_id, row]));
  const linkedMessageIds = messages.filter((message) => !existingById.has(message.id) || existingById.get(message.id).undone_at).map((message) => message.id);
  if (linkedMessageIds.length) {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/message_journeys?on_conflict=environment,message_id,journey_id', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(linkedMessageIds.map((messageId) => ({ environment: ctx.environment, message_id: messageId, journey_id: journey.id, association_source: 'ENTRY_MANUAL', associated_at: now(), associated_by: ctx.panel.id, undone_at: null, undone_by: null })))
    });
  }
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats?id=eq.' + chat.id + '&environment=eq.' + ctx.environment, {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ contact_id: journey.contact_id, resolution_status: 'RESOLVED', updated_at: now() })
  });
  return linkedMessageIds;
}

async function applyReviewAction(ctx, body) {
  const target = await reviewTarget(ctx, body);
  if (!target) return send(ctx.res, 404, { error: 'REVIEW_NOT_FOUND' });
  if (body.action === 'review_link') {
    const journey = await journeyTarget(ctx, body.journeyId);
    if (!journey) return send(ctx.res, 404, { error: 'JOURNEY_NOT_FOUND' });
    let linkedMessageIds = [];
    if (target.kind === 'chat') linkedMessageIds = await associateReviewChat(ctx, target.row, journey);
    else await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs?id=eq.' + target.row.id + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'COMPLETED', review_reason: 'ligado manualmente ao lead', completed_at: now() }) });
    return send(ctx.res, 200, { journeyId: journey.id, undo: { kind: target.kind, id: target.row.id, previousContactId: target.row.contact_id || null, previousResolution: target.row.resolution_status || null, previousStatus: target.row.status || null, previousReason: target.row.review_reason || null, journeyId: journey.id, linkedMessageIds } });
  }
  if (body.action === 'review_create') {
    const created = await createReviewJourney(ctx, target);
    let linkedMessageIds = [];
    if (target.kind === 'chat') linkedMessageIds = await associateReviewChat(ctx, target.row, created.journey);
    else await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs?id=eq.' + target.row.id + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'COMPLETED', review_reason: 'lead criado manualmente', completed_at: now() }) });
    return send(ctx.res, 200, { journeyId: created.journey.id, undo: { kind: target.kind, id: target.row.id, previousContactId: target.row.contact_id || null, previousResolution: target.row.resolution_status || null, previousStatus: target.row.status || null, previousReason: target.row.review_reason || null, journeyId: created.journey.id, createdJourneyId: created.journey.id, createdContactId: created.createdContactId, linkedMessageIds } });
  }
  if (body.action === 'review_dismiss') {
    let contactWasLead = null;
    if (target.kind === 'chat') {
      if (target.row.contact_id) {
        const contacts = await rows(ctx, 'contacts', { select: 'id,is_lead', environment: 'eq.' + ctx.environment, id: 'eq.' + target.row.contact_id, limit: '1' });
        contactWasLead = contacts[0]?.is_lead !== false;
        await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts?id=eq.' + target.row.contact_id + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ is_lead: false, updated_at: now(), updated_by: ctx.panel.id }) });
      }
      await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats?id=eq.' + target.row.id + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ resolution_status: 'RESOLVED', updated_at: now() }) });
    } else await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs?id=eq.' + target.row.id + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'COMPLETED', review_reason: 'dispensado — não é cliente', completed_at: now() }) });
    return send(ctx.res, 200, { undo: { kind: target.kind, id: target.row.id, previousContactId: target.row.contact_id || null, previousResolution: target.row.resolution_status || null, previousStatus: target.row.status || null, previousReason: target.row.review_reason || null, contactWasLead } });
  }
  return send(ctx.res, 400, { error: 'REVIEW_ACTION_INVALID' });
}

async function undoReviewAction(ctx, body) {
  const undo = body.undo || {};
  if (!['chat', 'review'].includes(undo.kind) || !isUuid(undo.id)) return send(ctx.res, 400, { error: 'REVIEW_UNDO_INVALID' });
  if (Array.isArray(undo.linkedMessageIds) && isUuid(undo.journeyId)) {
    for (const messageId of undo.linkedMessageIds.filter(isUuid)) {
      await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/message_journeys?environment=eq.' + ctx.environment + '&journey_id=eq.' + undo.journeyId + '&message_id=eq.' + messageId, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ undone_at: now(), undone_by: ctx.panel.id }) });
    }
  }
  if (undo.kind === 'chat') {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/chats?id=eq.' + undo.id + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ contact_id: isUuid(undo.previousContactId) ? undo.previousContactId : null, resolution_status: ['UNIDENTIFIED', 'REVIEW', 'GROUP', 'RESOLVED'].includes(undo.previousResolution) ? undo.previousResolution : 'REVIEW', updated_at: now() }) });
    if (isUuid(undo.previousContactId) && typeof undo.contactWasLead === 'boolean') await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts?id=eq.' + undo.previousContactId + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ is_lead: undo.contactWasLead, updated_at: now(), updated_by: ctx.panel.id }) });
  } else await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/import_jobs?id=eq.' + undo.id + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: undo.previousStatus || 'REVIEW', review_reason: undo.previousReason || 'formato não suportado', completed_at: now() }) });
  if (isUuid(undo.createdJourneyId)) await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/journeys?id=eq.' + undo.createdJourneyId + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ status: 'ENCERRADO', closed_at: now(), closed_reason: 'Ação da entrada desfeita', updated_at: now(), updated_by: ctx.panel.id }) });
  if (isUuid(undo.createdContactId)) await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/contacts?id=eq.' + undo.createdContactId + '&environment=eq.' + ctx.environment, { method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ is_lead: false, updated_at: now(), updated_by: ctx.panel.id }) });
  return send(ctx.res, 200, { undone: true });
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
    if (action === 'review') return createReview(ctx, input);
    if (action === 'batch') return receiveBatch(ctx, input);
    if (action === 'finish') return finishJob(ctx, input);
    if (action === 'resolve') return resolveChat(ctx, input);
    if (['review_link', 'review_create', 'review_dismiss'].includes(action)) return applyReviewAction(ctx, input);
    if (action === 'review_undo') return undoReviewAction(ctx, input);
    return send(res, 400, { error: 'IMPORT_ACTION_INVALID' });
  } catch (_) {
    const safeErrors = {
      start: 'IMPORT_START_FAILED', review: 'IMPORT_START_FAILED',
      batch: 'IMPORT_BATCH_FAILED', finish: 'IMPORT_FINISH_FAILED',
      resolve: 'IMPORT_RESOLUTION_FAILED', review_link: 'REVIEW_ACTION_FAILED',
      review_create: 'REVIEW_ACTION_FAILED', review_dismiss: 'REVIEW_ACTION_FAILED',
      review_undo: 'REVIEW_UNDO_FAILED'
    };
    return send(res, 500, { error: safeErrors[action] || 'IMPORT_REQUEST_FAILED' });
  }
};

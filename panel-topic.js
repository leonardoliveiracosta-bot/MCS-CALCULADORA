'use strict';

// "Fora do assunto": a conversa nunca tratou de carro (veículo, compra, financiamento de veículo,
// orçamento ou serviço da MCS). Quem decide é a leitura da triagem (about_car) ou a sua correção,
// que sempre prevalece e fica guardada. Na dúvida (sem leitura, leitura sem resposta, erro), a
// conversa fica no fluxo principal. Nada é apagado, enviado ou encerrado por esta classificação.
const { allRows, isUuid, rows, supabase } = require('./panel-server');

const stamp = (value) => Date.parse(value || '') || 0;

// Both tables may not exist yet (migration not applied): then nobody is off-topic and every list
// stays exactly as before.
async function loadTopic(ctx, read = allRows) {
  const env = 'eq.' + ctx.environment;
  const [readings, overrides] = await Promise.all([
    read(ctx, 'conversation_triage', { select: 'chat_id,journey_id,about_car,reason,created_at', environment: env, source: 'eq.AI', about_car: 'not.is.null' }).catch(() => []),
    read(ctx, 'conversation_topic_overrides', { select: 'id,chat_id,journey_id,about_car,created_at', environment: env, undone_at: 'is.null' }).catch(() => [])
  ]);
  return topicIndex(readings || [], overrides || []);
}

// Per conversation: the latest correction wins; without one, the latest AI reading of the whole
// conversation. Per ficha: off-topic only when it has a reading or correction, every one of its
// conversations is off-topic and it has no calculator order (a calculator order is always about a car).
function topicIndex(readings, overrides) {
  const latest = (list) => { const map = new Map(); list.forEach((row) => { const current = map.get(row.chat_id); if (!current || stamp(row.created_at) >= stamp(current.created_at)) map.set(row.chat_id, row); }); return map; };
  const ai = latest(readings.filter((row) => row && row.chat_id && typeof row.about_car === 'boolean'));
  const manual = latest(overrides.filter((row) => row && row.chat_id && typeof row.about_car === 'boolean'));
  const byChat = new Map();
  new Set([...ai.keys(), ...manual.keys()]).forEach((chatId) => {
    const own = manual.get(chatId), reading = ai.get(chatId);
    const row = own || reading;
    byChat.set(chatId, { offTopic: row.about_car === false, source: own ? 'MANUAL' : 'AI', reason: own ? 'Correção sua' : reading.reason || '', overrideId: own ? own.id : null, journeyId: (own && own.journey_id) || (reading && reading.journey_id) || null });
  });
  const chatsByJourney = new Map();
  [...readings, ...overrides].forEach((row) => { if (!row || !row.journey_id || !row.chat_id) return; if (!chatsByJourney.has(row.journey_id)) chatsByJourney.set(row.journey_id, new Set()); chatsByJourney.get(row.journey_id).add(row.chat_id); });
  function chat(chatId) { return byChat.get(chatId) || null; }
  function journey(journeyId, { hasCalculator = false, chatIds = null } = {}) {
    if (!journeyId || hasCalculator) return null;
    const ids = [...new Set([...(chatsByJourney.get(journeyId) || []), ...(chatIds || [])])];
    const known = ids.map((id) => byChat.get(id)).filter(Boolean);
    if (!known.length || known.length !== ids.length || !known.every((entry) => entry.offTopic)) return null;
    return { offTopic: true, source: known.some((entry) => entry.source === 'MANUAL') ? 'MANUAL' : 'AI', reason: known.find((entry) => entry.reason)?.reason || '', chatIds: ids };
  }
  const offTopicChats = () => [...byChat].filter(([, entry]) => entry.offTopic).map(([chatId, entry]) => ({ chatId, ...entry }));
  return { chat, journey, offTopicChats, size: byChat.size };
}

// The conversations of a ficha (to record a correction for the person as a whole).
async function chatsOfJourney(ctx, journeyId) {
  const links = await allRows(ctx, 'message_journeys', { select: 'message_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, undone_at: 'is.null' });
  const ids = [...new Set(links.map((link) => link.message_id).filter(isUuid))];
  const chats = new Set();
  for (let index = 0; index < ids.length; index += 100) {
    (await rows(ctx, 'messages', { select: 'chat_id', environment: 'eq.' + ctx.environment, id: 'in.(' + ids.slice(index, index + 100).join(',') + ')' })).forEach((row) => { if (row.chat_id) chats.add(row.chat_id); });
  }
  return [...chats];
}

// Records a correction (one new row per conversation; the previous one is kept and marked undone,
// so the history stays). Returns the new rows' ids for "Desfazer".
async function correct(ctx, { chatId = null, journeyId = null, aboutCar }) {
  if (typeof aboutCar !== 'boolean') { const failure = new Error('TOPIC_VALUE_INVALID'); failure.code = 'TOPIC_VALUE_INVALID'; throw failure; }
  const chatIds = isUuid(chatId) ? [chatId] : isUuid(journeyId) ? await chatsOfJourney(ctx, journeyId) : [];
  if (!chatIds.length) { const failure = new Error('TOPIC_CHAT_REQUIRED'); failure.code = 'TOPIC_CHAT_REQUIRED'; throw failure; }
  const now = new Date().toISOString();
  const env = ctx.environment;
  const previous = await rows(ctx, 'conversation_topic_overrides', { select: 'id,chat_id', environment: 'eq.' + env, chat_id: 'in.(' + chatIds.join(',') + ')', undone_at: 'is.null' });
  const patch = (ids, values) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/conversation_topic_overrides?environment=eq.' + env + '&id=in.(' + ids.join(',') + ')', {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(values)
  });
  // One active correction per conversation (unique index): the previous one is closed first and
  // comes back if the new one cannot be written.
  if (previous.length) await patch(previous.map((row) => row.id), { undone_at: now, undone_by: ctx.panel.id });
  let created;
  try {
    created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/conversation_topic_overrides', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'return=representation' },
      body: JSON.stringify(chatIds.map((id) => ({ environment: env, chat_id: id, journey_id: isUuid(journeyId) ? journeyId : null, about_car: aboutCar, created_by: ctx.panel.id, created_at: now, replaces_ids: previous.filter((row) => row.chat_id === id).map((row) => row.id) })))
    });
  } catch (error) {
    if (previous.length) await patch(previous.map((row) => row.id), { undone_at: null, undone_by: null }).catch(() => null);
    throw error;
  }
  return { ids: (created || []).map((row) => row.id), chatIds, aboutCar };
}

// Undo: the corrections just made are marked undone and the ones they replaced come back.
async function undoCorrection(ctx, ids) {
  const wanted = (Array.isArray(ids) ? ids : []).filter(isUuid).slice(0, 100);
  if (!wanted.length) { const failure = new Error('TOPIC_UNDO_INVALID'); failure.code = 'TOPIC_UNDO_INVALID'; throw failure; }
  const env = ctx.environment, now = new Date().toISOString();
  const own = await rows(ctx, 'conversation_topic_overrides', { select: 'id,replaces_ids', environment: 'eq.' + env, id: 'in.(' + wanted.join(',') + ')', undone_at: 'is.null' });
  if (!own.length) return { undone: 0 };
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/conversation_topic_overrides?environment=eq.' + env + '&id=in.(' + own.map((row) => row.id).join(',') + ')', {
    method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ undone_at: now, undone_by: ctx.panel.id })
  });
  const restore = [...new Set(own.flatMap((row) => row.replaces_ids || []))].filter(isUuid);
  if (restore.length) {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/conversation_topic_overrides?environment=eq.' + env + '&id=in.(' + restore.join(',') + ')', {
      method: 'PATCH', headers: { 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ undone_at: null, undone_by: null })
    });
  }
  return { undone: own.length, restored: restore.length };
}

module.exports = { loadTopic, topicIndex, chatsOfJourney, correct, undoCorrection };

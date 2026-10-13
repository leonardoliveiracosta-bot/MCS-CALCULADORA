'use strict';

// RETOMAR (/retomar): clients who wrote more than 15 days ago and got no reply, with the 3 messages ready to send one
// at a time by WhatsApp or SMS. Who is listed follows the suggestions queue (panel-reply-suggest.js queue): one ficha,
// one destination, no opt-out, not closed, not off, not "not a lead", not discarded, not out of the funnel. The part
// already sent is saved in the database (retomar_progress), so the phone and the computer continue from the same
// point; on WhatsApp the parts really sent are also recognised in the conversation. When the 3rd part goes out, the
// ficha gets the RESULTADO "Opções enviadas", the same as the panel button.
const crypto = require('node:crypto');
const { allRows, insert, isUuid, patchRows, rows, rpc } = require('./panel-server');
const { queue } = require('./panel-reply-suggest');
const messages = require('./retomar/mensagens');
const groups = require('./panel-groups');

const MIN_DAYS = 15;
const DAY_MS = 86400000;
const DONE_DAYS = 30;
const SITE = 'https://www.mycarscout.net';
const CAR = /^[\p{L}\p{N} .,'&/+-]{2,60}$/u;
const KEY = /^journey:([0-9a-f-]{36}):(VALOR|CARRO)$/;

const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
const stamp = (message) => Date.parse(message.occurred_at_utc || message.created_at || '') || 0;
const offerTotal = (offer) => (Number(offer && offer.lane) || 0) + (Number(offer && offer.offLane) || 0) + (Number(offer && offer.incomplete) || 0);
const easternDay = (value) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(value));

// The demand of the ficha with options in the active batch (the same rule as the panel's options link) and the car of
// its first wish. CARRO first.
function optionsOf(view, journeyId) {
  const demands = ((view && view.demands) || []).filter((demand) => demand.journeyId === journeyId && KEY.test(demand.key || ''));
  demands.sort((a, b) => (a.mode === 'CARRO' ? 0 : 1) - (b.mode === 'CARRO' ? 0 : 1));
  const wish = demands.map((demand) => (demand.wishes || [])[0]).find((item) => item && (item.make || item.model));
  // How people name the car: the model alone when it stands on its own (Escalade, G-Class), with the make when it is
  // short or only digits (BMW X5, Chrysler 300). The trim is left out: it is rarely filled and often loose text.
  const model = wish ? String(wish.model || '').trim() : '';
  const car = wish ? (model.length >= 3 && /\p{L}/u.test(model) ? model : [wish.make, model].filter(Boolean).join(' ').trim()) : null;
  const withCars = view && view.upload ? demands.find((demand) => !demand.expired && (demand.offer ? offerTotal(demand.offer) : Number(demand.matchCount) || 0) > 0) : null;
  return { car: car && CAR.test(car) ? car : null, options: withCars ? { key: withCars.key, count: withCars.offer ? offerTotal(withCars.offer) : Number(withCars.matchCount) || 0 } : null };
}

// Our messages and the client's after the sequence started: which prepared parts were really sent (WhatsApp echoes and
// SMS recorded by the page) and whether the client answered.
async function conversationAfter(ctx, progress, read) {
  const byJourney = new Map();
  const ids = progress.map((row) => row.journey_id);
  for (let index = 0; index < ids.length; index += 100) {
    const links = await read(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment, undone_at: 'is.null', journey_id: 'in.(' + ids.slice(index, index + 100).join(',') + ')' });
    const messageIds = [...new Set(links.map((row) => row.message_id))];
    const found = [];
    for (let at = 0; at < messageIds.length; at += 100) {
      found.push(...await read(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,occurred_at_utc,created_at,undone_at', environment: 'eq.' + ctx.environment, id: 'in.(' + messageIds.slice(at, at + 100).join(',') + ')' }));
    }
    const byId = new Map(found.map((row) => [row.id, row]));
    links.forEach((row) => { const message = byId.get(row.message_id); if (!message || message.undone_at) return; if (!byJourney.has(row.journey_id)) byJourney.set(row.journey_id, []); byJourney.get(row.journey_id).push(message); });
  }
  const out = new Map();
  progress.forEach((row) => {
    const since = (Date.parse(row.started_at) || 0) - 60000;
    const after = (byJourney.get(row.journey_id) || []).filter((message) => stamp(message) >= since);
    const ours = new Set(after.filter((message) => message.direction === 'MCS').map((message) => norm(message.body_text)));
    const detected = (Array.isArray(row.texts) ? row.texts : []).map((text) => ours.has(norm(text)));
    const replied = after.some((message) => message.direction === 'CUSTOMER' && !message.is_automatic && String(message.body_text || '').trim() && stamp(message) > (Date.parse(row.started_at) || 0));
    out.set(row.journey_id, { detected, replied });
  });
  return out;
}

function progressView(row, seen) {
  if (!row) return null;
  const detected = (seen && seen.detected) || [false, false, false];
  const lastDetected = detected.lastIndexOf(true) + 1;
  return {
    channel: row.channel, lang: row.lang, texts: row.texts, link: row.option_link || null,
    partsSent: Math.max(Number(row.parts_sent) || 0, lastDetected), detected, replied: Boolean(seen && seen.replied),
    startedAt: row.started_at, completedAt: row.completed_at || null, resultRecorded: Boolean(row.result_event_id)
  };
}

async function list(ctx, options = {}, services = {}) {
  const now = options.now || Date.now();
  const read = services.allRows || allRows;
  const progressRows = await read(ctx, 'retomar_progress', { select: 'journey_id,channel,lang,texts,option_link,parts_sent,result_event_id,started_at,updated_at,completed_at', environment: 'eq.' + ctx.environment });
  // In the sequence (or finished in the last 30 days): listed even though our message made the conversation recent.
  const kept = progressRows.filter((row) => !row.completed_at || now - Date.parse(row.completed_at) < DONE_DAYS * DAY_MS);
  const keepIds = new Set(kept.map((row) => row.journey_id));
  const [found, view, classification] = await Promise.all([
    (services.queue || queue)(ctx, { minDays: MIN_DAYS, now, includeSms: true, keepIds }, services),
    (services.manheimView || require('./panel-buscas-view').manheimView)(ctx, { queue: true }).catch(() => null),
    (services.loadClassification || require('./panel-classification').loadClassification)(ctx).catch(() => null)
  ]);
  // Came by the site's calculator: the panel's Ref rule (Ref proven, or calculator origin with the Ref to recover).
  // Unknown when the identity could not be read (null): the page then shows everyone and says so.
  const originOf = (journeyId) => {
    if (!classification) return null;
    const identity = classification.identityOf(journeyId);
    if (!identity || identity.state === 'INDISPONIVEL') return null;
    return groups.refStateOf({ identity }) === 'SEM_REF' ? 'OUTRA' : 'CALCULADORA';
  };
  const progressByJourney = new Map(kept.map((row) => [row.journey_id, row]));
  const started = kept.filter((row) => Number(row.parts_sent) > 0);
  const seen = started.length ? await conversationAfter(ctx, started, read) : new Map();
  const items = [];
  (found.eligible || []).forEach((item) => {
    const row = progressByJourney.get(item.journeyId) || null;
    const customerAt = Date.parse(item.lastCustomerAt || '') || 0;
    const waiting = item.lastFrom === 'CUSTOMER' && now - customerAt >= MIN_DAYS * DAY_MS;
    if (!waiting && !row) return;
    const extra = optionsOf(view, item.journeyId);
    items.push({
      journeyId: item.journeyId, name: item.name, ref: item.ref, phone: item.phone, channel: item.channel || 'WHATSAPP',
      language: messages.LANGS.includes(item.language) ? item.language : 'en', languageDetected: Boolean(item.language),
      days: customerAt ? Math.floor((now - customerAt) / DAY_MS) : item.days, lastCustomerAt: item.lastCustomerAt || null,
      lastMessage: item.lastFrom === 'CUSTOMER' ? item.lastMessage : null,
      origin: originOf(item.journeyId), car: extra.car, options: extra.options, optionsKnown: Boolean(view),
      progress: progressView(row, seen.get(item.journeyId))
    });
  });
  items.sort((a, b) => (Date.parse(b.lastCustomerAt || '') || 0) - (Date.parse(a.lastCustomerAt || '') || 0));
  const today = easternDay(now);
  return {
    minDays: MIN_DAYS, items, generatedAt: new Date(now).toISOString(),
    today: { started: started.filter((row) => easternDay(row.started_at) === today).length, completed: kept.filter((row) => row.completed_at && easternDay(row.completed_at) === today).length },
    excluded: found.reasons || {}, optionsAvailable: Boolean(view && view.upload)
  };
}

// The 3 texts of a ficha. Once a part went out the texts are fixed (the other device sends exactly the same); before
// that, a new language or a new link rebuilds them.
async function prepare(ctx, body, services = {}) {
  const journeyId = String(body.journeyId || '');
  if (!isUuid(journeyId)) return { status: 400, error: 'JOURNEY_INVALID' };
  const channel = body.channel === 'SMS' ? 'SMS' : 'WHATSAPP';
  const lang = messages.LANGS.includes(body.lang) ? body.lang : 'en';
  const read = services.rows || rows;
  const [journeys, existing] = await Promise.all([
    read(ctx, 'journeys', { select: 'id,contact_id', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' }),
    read(ctx, 'retomar_progress', { select: 'journey_id,channel,lang,texts,option_link,parts_sent,result_event_id,started_at,completed_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, limit: '1' })
  ]);
  if (!journeys.length) return { status: 404, error: 'LEAD_NOT_FOUND' };
  const current = existing[0] || null;
  if (current && Number(current.parts_sent) > 0 && !current.completed_at) return { status: 200, progress: progressView(current, null) };
  const contact = (await read(ctx, 'contacts', { select: 'display_name', environment: 'eq.' + ctx.environment, id: 'eq.' + journeys[0].contact_id, limit: '1' }))[0] || null;
  let link = null;
  const key = String(body.optionsKey || '');
  const keyMatch = key.match(KEY);
  if (keyMatch) {
    if (keyMatch[1] !== journeyId) return { status: 400, error: 'OPTIONS_KEY_INVALID' };
    const code = await (services.linkFor || require('./panel-option-links').linkFor)(ctx, key, ctx.panel && ctx.panel.id);
    link = SITE + '/o/' + code;
  }
  const car = CAR.test(String(body.car || '')) ? String(body.car).trim() : null;
  const texts = messages.sequence({ lang, name: contact && contact.display_name, link, car });
  const fields = { channel, lang, texts, option_link: link, parts_sent: 0, result_operation: crypto.randomUUID(), result_event_id: null, completed_at: null, started_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  const saved = current
    ? ((await (services.patchRows || patchRows)(ctx, 'retomar_progress', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId }, fields, true)) || [])[0]
    : ((await (services.insert || insert)(ctx, 'retomar_progress', { environment: ctx.environment, journey_id: journeyId, created_by: ctx.panel && ctx.panel.id || null, ...fields })) || [])[0];
  return { status: 200, progress: progressView(saved || { ...fields, journey_id: journeyId }, null), review: messages.review({ name: contact && contact.display_name, link, car }) };
}

// The part reached (0 to 3). The 3rd part records "Opções enviadas" once (same operation id on a repeat).
async function step(ctx, body, services = {}) {
  const journeyId = String(body.journeyId || '');
  const parts = Number(body.parts);
  if (!isUuid(journeyId)) return { status: 400, error: 'JOURNEY_INVALID' };
  if (!Number.isInteger(parts) || parts < 0 || parts > 3) return { status: 400, error: 'PARTS_INVALID' };
  const read = services.rows || rows;
  const found = (await read(ctx, 'retomar_progress', { select: 'journey_id,channel,lang,texts,option_link,parts_sent,result_operation,result_event_id,started_at,completed_at', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, limit: '1' }))[0];
  if (!found) return { status: 409, error: 'NOT_PREPARED' };
  const now = new Date().toISOString();
  const fields = { parts_sent: parts, updated_at: now };
  if (Number(found.parts_sent) === 0 && parts > 0) fields.started_at = now;
  if (parts === 3 && !found.completed_at) fields.completed_at = now;
  if (parts < 3) fields.completed_at = null;
  if (parts === 3 && !found.result_event_id) {
    const journey = (await read(ctx, 'journeys', { select: 'id,reference_code', environment: 'eq.' + ctx.environment, id: 'eq.' + journeyId, limit: '1' }))[0];
    try {
      const event = await (services.rpc || rpc)(ctx, 'panel_quick_result', { p_environment: ctx.environment, p_actor: ctx.panel && ctx.panel.id, p_ref: journey && journey.reference_code || '', p_journey: journeyId, p_type: 'IN_PERSON', p_due: null, p_operation: found.result_operation });
      const eventId = event && event.eventId;
      if (eventId) fields.result_event_id = eventId;
    } catch (error) {
      // A closed or frozen ficha keeps the sequence; the result is not recorded and the page says so.
      fields.result_event_id = null;
      const saved = ((await (services.patchRows || patchRows)(ctx, 'retomar_progress', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId }, fields, true)) || [])[0];
      return { status: 200, progress: progressView(saved || { ...found, ...fields }, null), resultError: String(error && (error.code || error.message) || 'RESULT_FAILED').slice(0, 80) };
    }
  }
  const saved = ((await (services.patchRows || patchRows)(ctx, 'retomar_progress', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId }, fields, true)) || [])[0];
  return { status: 200, progress: progressView(saved || { ...found, ...fields }, null) };
}

module.exports = { MIN_DAYS, list, prepare, step, optionsOf, progressView, norm };

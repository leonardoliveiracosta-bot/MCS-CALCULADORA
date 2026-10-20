'use strict';

// Dados do assistente: uma leitura só por pergunta (contatos, telefones, fichas, Refs, conversas e
// mensagens; a base é pequena) e as funções que respondem em cima dela: achar o lead (nome, Ref,
// telefone, carro ou texto da conversa, tolerante a acento, maiúscula e erro de digitação), períodos
// no horário de Nova York, conversas e contagens. Só leitura. Ref e telefone sempre juntos.
const { allRows } = require('./panel-server');
const refProof = require('./panel-ref-proof');

const ZONE = 'America/New_York';
const REF_RE = /^[A-HJ-NP-Z2-9]{5}$/;

// ------------------------------------------------------------------ texto
const fold = (value) => String(value || '').normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
const words = (value) => fold(value).split(/[^a-z0-9]+/).filter(Boolean);
function distance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
// Uma palavra pedida bate com uma palavra do texto: igual, começo (3+ letras) ou erro de digitação pequeno.
function wordHits(query, word) {
  if (query === word) return true;
  if (query.length >= 3 && word.startsWith(query)) return true;
  const tolerance = query.length <= 3 ? 0 : query.length <= 6 ? 1 : 2;
  return tolerance > 0 && distance(query, word, tolerance) <= tolerance;
}
// Todas as palavras pedidas aparecem no texto (cada uma do jeito acima).
function textMatches(queryWords, text) {
  if (!queryWords.length) return false;
  const own = words(text);
  return queryWords.every((q) => own.some((w) => wordHits(q, w)));
}
function excerpt(text, queryWords, size = 90) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const folded = fold(raw);
  let at = -1;
  for (const q of queryWords) { at = folded.indexOf(q.slice(0, Math.max(3, q.length - 1))); if (at >= 0) break; }
  if (at < 0) return raw.slice(0, size * 2);
  const start = Math.max(0, at - size);
  return (start > 0 ? '…' : '') + raw.slice(start, at + size) + (at + size < raw.length ? '…' : '');
}

// ------------------------------------------------------------------ telefone e datas
const digits = (value) => String(value || '').replace(/\D/g, '');
function phoneText(e164) {
  const d = digits(e164);
  if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return e164 ? String(e164) : '';
}
function offsetMinutes(at) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
  const match = /GMT([+-]\d+)(?::(\d+))?/.exec(part ? part.value : '');
  return match ? Number(match[1]) * 60 + Math.sign(Number(match[1])) * Number(match[2] || 0) : -300;
}
// Meia-noite de Nova York do dia de "at" mais "days".
function nyMidnight(at, days = 0) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day + days, 0, 0);
  return new Date(guess - offsetMinutes(new Date(guess + 12 * 3600e3)) * 60e3);
}
const nyText = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Intl.DateTimeFormat('pt-BR', { timeZone: ZONE, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(t)) : null; };
// "hoje", "ontem", "semana", "mes", "24h", "3d", "2026-10-18" ou "2026-10-01..2026-10-18".
function period(value, now = new Date()) {
  const text = fold(value).trim() || 'hoje';
  const end = now;
  if (text === 'hoje' || text === 'today') return { from: nyMidnight(now), to: end, label: 'hoje' };
  if (text === 'ontem' || text === 'yesterday') return { from: nyMidnight(now, -1), to: nyMidnight(now), label: 'ontem' };
  if (/^(semana|7d|ultimos 7 dias|esta semana)$/.test(text)) return { from: nyMidnight(now, -6), to: end, label: 'últimos 7 dias' };
  if (/^(mes|30d|este mes)$/.test(text)) return { from: nyMidnight(now, -29), to: end, label: 'últimos 30 dias' };
  const hours = /^(\d{1,3})\s*h/.exec(text);
  if (hours) return { from: new Date(now.getTime() - Number(hours[1]) * 3600e3), to: end, label: `últimas ${hours[1]} h` };
  const days = /^(\d{1,3})\s*d/.exec(text);
  if (days) return { from: nyMidnight(now, -(Number(days[1]) - 1)), to: end, label: `últimos ${days[1]} dias` };
  const range = /^(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*(\d{4}-\d{2}-\d{2}))?$/.exec(text);
  if (range) {
    const from = nyMidnight(new Date(Date.parse(range[1] + 'T12:00:00Z')));
    const last = nyMidnight(new Date(Date.parse((range[2] || range[1]) + 'T12:00:00Z')), 1);
    return { from, to: last < end ? last : end, label: range[2] ? `${range[1]} a ${range[2]}` : range[1] };
  }
  return { from: nyMidnight(now), to: end, label: 'hoje' };
}

// ------------------------------------------------------------------ leitura única
const at = (m) => m.occurred_at_utc || m.created_at || null;
async function load(ctx, read = allRows) {
  const env = 'eq.' + ctx.environment;
  const [contacts, phones, journeys, refs, toggles, chats, links, messages, runs] = await Promise.all([
    read(ctx, 'contacts', { select: 'id,display_name,is_lead,notes,created_at', environment: env }),
    read(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,is_current,retired_at,is_primary', environment: env }),
    read(ctx, 'journeys', { select: 'id,contact_id,reference_code,status,stage,stage_frozen,closed_reason,vehicle_text,criteria_json,budget_cents,payment_text,customer_deadline_text,next_action_text,next_action_at,created_at,updated_at', environment: env }),
    read(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env }),
    read(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: env }),
    read(ctx, 'chats', { select: 'id,contact_id,channel', environment: env }),
    read(ctx, 'message_journeys', { select: 'message_id,journey_id', environment: env, undone_at: 'is.null' }),
    read(ctx, 'messages', { select: 'id,chat_id,channel,direction,body_text,occurred_at_utc,created_at,is_automatic,media_kind', environment: env, undone_at: 'is.null' }),
    read(ctx, 'calc_runs', { select: 'ref:dados->>ref,is_test' }).catch(() => [])
  ]);
  const runRefs = new Set(runs.filter((r) => r && r.is_test !== true).map((r) => String(r.ref || '').toUpperCase()).filter((r) => REF_RE.test(r)));
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const phonesByContact = new Map();
  phones.filter((p) => !p.retired_at).forEach((p) => { if (!phonesByContact.has(p.contact_id)) phonesByContact.set(p.contact_id, []); phonesByContact.get(p.contact_id).push(p); });
  phonesByContact.forEach((list) => list.sort((a, b) => Number(Boolean(b.is_primary)) - Number(Boolean(a.is_primary)) || Number(Boolean(b.is_current)) - Number(Boolean(a.is_current))));
  const toggleByJourney = new Map(toggles.map((t) => [t.journey_id, t]));
  const refsByJourney = new Map();
  refs.forEach((r) => { if (!refsByJourney.has(r.journey_id)) refsByJourney.set(r.journey_id, []); refsByJourney.get(r.journey_id).push(String(r.ref_code || '').toUpperCase()); });
  const chatById = new Map(chats.map((c) => [c.id, c]));
  const journeysByContact = new Map();
  journeys.forEach((j) => { if (!journeysByContact.has(j.contact_id)) journeysByContact.set(j.contact_id, []); journeysByContact.get(j.contact_id).push(j); });
  journeysByContact.forEach((list) => list.sort((a, b) => (Date.parse(b.updated_at || b.created_at) || 0) - (Date.parse(a.updated_at || a.created_at) || 0)));
  const linkByMessage = new Map(links.map((l) => [l.message_id, l.journey_id]));
  const journeyById = new Map(journeys.map((j) => [j.id, j]));
  // A mensagem é da ficha a que foi ligada; sem ligação, da ficha mais recente do contato da conversa.
  const journeyOfMessage = (m) => {
    const linked = linkByMessage.get(m.id);
    if (linked && journeyById.has(linked)) return linked;
    const chat = chatById.get(m.chat_id);
    const own = chat && journeysByContact.get(chat.contact_id);
    return own && own[0] ? own[0].id : null;
  };
  const messagesByJourney = new Map();
  messages.forEach((m) => { const jid = journeyOfMessage(m); if (!jid) return; if (!messagesByJourney.has(jid)) messagesByJourney.set(jid, []); messagesByJourney.get(jid).push(m); });
  messagesByJourney.forEach((list) => list.sort((a, b) => (Date.parse(at(a)) || 0) - (Date.parse(at(b)) || 0)));
  return { contacts, contactById, phonesByContact, journeys, journeyById, journeysByContact, refsByJourney, toggleByJourney, chatById, messages, messagesByJourney, runRefs, journeyOfMessage };
}
// Uma leitura por pergunta (o modelo pode chamar várias ferramentas seguidas).
function snapshot(ctx) {
  if (!ctx.__assistantData) ctx.__assistantData = load(ctx).catch((error) => { ctx.__assistantData = null; throw error; });
  return ctx.__assistantData;
}

// ------------------------------------------------------------------ o lead
// A Ref da calculadora comprovada (simulação existe ou o cliente escreveu); o código interno da ficha nunca é Ref.
function calcRefsOf(data, journey) {
  const owned = [...new Set([...(data.refsByJourney.get(journey.id) || []), String(journey.reference_code || '').toUpperCase()].filter((r) => REF_RE.test(r)))];
  const explicit = (data.messagesByJourney.get(journey.id) || []).filter((m) => m.direction === 'CUSTOMER').flatMap((m) => refProof.explicitRefs(m.body_text));
  return [...new Set([...owned.filter((r) => data.runRefs.has(r) || explicit.includes(r)), ...explicit])];
}
function statusOf(data, journey) {
  const toggle = data.toggleByJourney.get(journey.id);
  if (journey.status === 'ENCERRADO') return journey.closed_reason === 'WHATSAPP_LINKED' ? 'juntada a outra ficha' : 'encerrada';
  if (toggle && toggle.enabled === false) return 'desligado' + (toggle.off_reason ? ' (' + ({ MCS_PURCHASE: 'comprou com a MCS', OTHER_PURCHASE: 'comprou em outro lugar', GAVE_UP: 'desistiu', NO_RESPONSE: 'sem resposta' }[toggle.off_reason] || toggle.off_reason) + ')' : '');
  const contact = data.contactById.get(journey.contact_id);
  if (contact && contact.is_lead === false) return 'não é lead';
  return 'ligado';
}
function leadOf(data, journey) {
  const contact = data.contactById.get(journey.contact_id) || {};
  const phones = (data.phonesByContact.get(journey.contact_id) || []).map((p) => p.phone_e164 || p.phone_raw).filter(Boolean);
  const refs = calcRefsOf(data, journey);
  const name = contact.display_name && !/^\+?\d[\d\s()-]{6,}$/.test(contact.display_name) ? contact.display_name : null;
  const ref = refs[0] || null;
  const phone = phones[0] ? phoneText(phones[0]) : 'sem telefone';
  const line = [ref || 'Sem Ref', name, phone].filter(Boolean).join(' · ');
  return { journey_id: journey.id, linha: line, ref, refs, nome: name, telefone: phone, telefones: phones.map(phoneText), situacao: statusOf(data, journey), carro: journey.vehicle_text || null };
}
// "R893Z", "+1 954…", "(954) 478-5595", um journey_id ou um nome: a ficha certa, ou as candidatas.
function resolveLead(data, value) {
  const text = String(value || '').trim();
  if (!text) return { candidatas: [] };
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
    const journey = data.journeyById.get(text.toLowerCase());
    return journey ? { journey } : { candidatas: [] };
  }
  const upper = text.toUpperCase().replace(/^REF\s*/, '');
  if (REF_RE.test(upper)) {
    const list = data.journeys.filter((j) => calcRefsOf(data, j).includes(upper) || String(j.reference_code || '').toUpperCase() === upper);
    if (list.length === 1) return { journey: list[0] };
    if (list.length > 1) return { candidatas: list };
  }
  const d = digits(text);
  if (d.length >= 7) {
    const list = data.journeys.filter((j) => (data.phonesByContact.get(j.contact_id) || []).some((p) => digits(p.phone_e164 || p.phone_raw).endsWith(d.slice(-10))));
    if (list.length === 1) return { journey: list[0] };
    if (list.length > 1) return { candidatas: list };
  }
  const q = words(text);
  const list = data.journeys.filter((j) => textMatches(q, (data.contactById.get(j.contact_id) || {}).display_name));
  if (list.length === 1) return { journey: list[0] };
  return { candidatas: list };
}

// Busca em nome, Ref, telefone, carro e no texto das conversas (inclusive Sem Ref).
function search(data, term, limit = 15) {
  const text = String(term || '').trim();
  const q = words(text);
  const d = digits(text);
  const upper = text.toUpperCase();
  const found = new Map();
  const hit = (journey, where, quote) => {
    if (!journey) return;
    const entry = found.get(journey.id) || { journey, onde: new Set(), trechos: [] };
    entry.onde.add(where);
    if (quote && entry.trechos.length < 2) entry.trechos.push(quote);
    found.set(journey.id, entry);
  };
  for (const journey of data.journeys) {
    const contact = data.contactById.get(journey.contact_id) || {};
    if (REF_RE.test(upper) && (calcRefsOf(data, journey).includes(upper) || String(journey.reference_code || '').toUpperCase() === upper)) hit(journey, 'Ref');
    if (d.length >= 4 && (data.phonesByContact.get(journey.contact_id) || []).some((p) => digits(p.phone_e164 || p.phone_raw).includes(d))) hit(journey, 'telefone');
    if (q.length && textMatches(q, contact.display_name)) hit(journey, 'nome');
    const car = [journey.vehicle_text, ...((journey.criteria_json && journey.criteria_json.wishlists) || []).map((w) => [w.make, w.model, w.trim].join(' '))].join(' ');
    if (q.length && textMatches(q, car)) hit(journey, 'carro');
  }
  if (q.length) {
    for (const m of data.messages) {
      if (!textMatches(q, m.body_text)) continue;
      const jid = data.journeyOfMessage(m);
      const journey = jid && data.journeyById.get(jid);
      if (journey) hit(journey, 'conversa', `${m.direction === 'CUSTOMER' ? 'cliente' : 'MCS'} em ${nyText(at(m))}: ${excerpt(m.body_text, q)}`);
    }
  }
  const rank = (e) => (e.onde.has('Ref') || e.onde.has('telefone') ? 0 : e.onde.has('nome') ? 1 : e.onde.has('carro') ? 2 : 3);
  const list = [...found.values()].sort((a, b) => rank(a) - rank(b) || (lastAt(data, b.journey) - lastAt(data, a.journey)));
  return { total: list.length, leads: list.slice(0, limit).map((e) => ({ ...leadOf(data, e.journey), achado_em: [...e.onde].join(', '), trechos: e.trechos })) };
}
const lastAt = (data, journey) => { const list = data.messagesByJourney.get(journey.id) || []; const last = list[list.length - 1]; return Date.parse(last ? at(last) : journey.updated_at) || 0; };

// Mensagens reais de um lead (WhatsApp e SMS), no período.
function conversation(data, journey, range, limit = 80) {
  const list = (data.messagesByJourney.get(journey.id) || []).filter((m) => { const t = Date.parse(at(m)) || 0; return (!range || (t >= range.from.getTime() && t <= range.to.getTime())); });
  const shown = list.slice(-limit);
  return {
    total_no_periodo: list.length,
    mensagens: shown.map((m) => ({ quando: nyText(at(m)), de: m.direction === 'CUSTOMER' ? 'cliente' : m.is_automatic ? 'MCS (automática)' : 'MCS', canal: m.channel, texto: String(m.body_text || (m.media_kind ? '[' + m.media_kind + ']' : '')).slice(0, 1200) }))
  };
}

// Com quem houve conversa no período e como terminou cada uma (o modelo julga o pendente lendo as últimas falas).
function conversationsIn(data, range, limit = 40) {
  const out = [];
  for (const journey of data.journeys) {
    const list = data.messagesByJourney.get(journey.id) || [];
    const inRange = list.filter((m) => { const t = Date.parse(at(m)) || 0; return t >= range.from.getTime() && t <= range.to.getTime(); });
    if (!inRange.length) continue;
    const real = list.filter((m) => !m.is_automatic);
    const last = real[real.length - 1] || list[list.length - 1];
    const lastCustomer = [...real].reverse().find((m) => m.direction === 'CUSTOMER');
    out.push({
      ...leadOf(data, journey),
      recebidas: inRange.filter((m) => m.direction === 'CUSTOMER').length, enviadas: inRange.filter((m) => m.direction !== 'CUSTOMER').length,
      ultima_fala_de: last ? (last.direction === 'CUSTOMER' ? 'cliente' : 'MCS') : null, ultima_em: last ? nyText(at(last)) : null,
      espera_horas: last && last.direction === 'CUSTOMER' ? Math.round((Date.now() - (Date.parse(at(last)) || Date.now())) / 36e5) : null,
      ultimas_falas: real.slice(-5).map((m) => `${m.direction === 'CUSTOMER' ? 'cliente' : 'MCS'}: ${String(m.body_text || (m.media_kind ? '[' + m.media_kind + ']' : '')).replace(/\s+/g, ' ').slice(0, 220)}`),
      ultima_do_cliente: lastCustomer ? nyText(at(lastCustomer)) : null
    });
  }
  out.sort((a, b) => (b.recebidas + b.enviadas) - (a.recebidas + a.enviadas));
  return { periodo: range.label, conversas: out.length, lista: out.slice(0, limit) };
}

function countMessages(data, range) {
  const inRange = data.messages.filter((m) => { const t = Date.parse(at(m)) || 0; return t >= range.from.getTime() && t <= range.to.getTime(); });
  const people = new Set(inRange.filter((m) => m.direction === 'CUSTOMER').map((m) => data.journeyOfMessage(m)).filter(Boolean));
  return {
    periodo: range.label,
    recebidas: inRange.filter((m) => m.direction === 'CUSTOMER').length,
    enviadas: inRange.filter((m) => m.direction !== 'CUSTOMER' && !m.is_automatic).length,
    automaticas: inRange.filter((m) => m.direction !== 'CUSTOMER' && m.is_automatic).length,
    whatsapp: inRange.filter((m) => m.channel === 'WHATSAPP').length, sms: inRange.filter((m) => m.channel === 'SMS').length,
    pessoas_que_escreveram: people.size
  };
}
function newLeads(data, range) {
  const list = data.journeys.filter((j) => { const t = Date.parse(j.created_at) || 0; return t >= range.from.getTime() && t <= range.to.getTime(); });
  return { periodo: range.label, leads_novos: list.length, lista: list.slice(0, 30).map((j) => leadOf(data, j)) };
}

module.exports = { ZONE, fold, words, distance, wordHits, textMatches, excerpt, digits, phoneText, nyMidnight, nyText, period, load, snapshot, calcRefsOf, statusOf, leadOf, resolveLead, search, conversation, conversationsIn, countMessages, newLeads, at };

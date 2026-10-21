'use strict';
// Lance do modelo antigo da calculadora. A mensagem antiga trazia "Maximum bid: $50,000" (ou "Lance máximo" /
// "Oferta máxima") e não tinha a linha "Ref:", então o lance nunca chegou à ficha e a busca POR VALOR ficava
// sem carro. O painel lê esse lance da própria mensagem ligada à ficha (message_journeys) e o usa só quando a
// ficha não tem lance nenhum: o lance digitado, o da Ref e o da ficha continuam vencendo. Nada é gravado.
const { allRows } = require('./panel-server');
const { isCalculator } = require('./panel-calc-message');
const { parseMoneyCents } = require('./money-text');

const LABEL = /(?:^|\n)[ \t*_-]*(?:maximum bid|lance m[aá]ximo|oferta m[aá]xima)[ \t*_]*:[ \t]*([^\n]*)/i;
const MIN_CENTS = 300000, MAX_CENTS = 30000000; // os mesmos limites do "Salvar lance"
// Sem espaço nem acento no filtro (PostgREST): o texto exato é conferido depois por bidCentsFromText.
const FILTER = '(body_text.ilike.*maximum*bid*,body_text.ilike.*lance*m*ximo*,body_text.ilike.*oferta*m*xima*)';
const CHUNK = 80;

// "Maximum bid: $50,000" → 5000000. Um número curto ("$40") é lido em milhares, como o cliente quis dizer.
function bidCentsFromText(text) {
  const body = String(text || '');
  if (!isCalculator(body)) return null;
  const found = body.match(LABEL);
  if (!found) return null;
  const raw = found[1].trim();
  let cents = parseMoneyCents(raw);
  if (cents === null) {
    const short = raw.replace(/^(?:US)?\$\s*/i, '').match(/^(\d{1,3})(?![\d.,])/);
    if (short) cents = Number(short[1]) * 1000 * 100;
  }
  return cents && cents >= MIN_CENTS && cents <= MAX_CENTS ? cents : null;
}

const inList = (values) => 'in.(' + values.join(',') + ')';
const chunks = (values) => { const out = []; for (let at = 0; at < values.length; at += CHUNK) out.push(values.slice(at, at + CHUNK)); return out; };

// journey_id → lance (centavos) da mensagem antiga mais recente da ficha. `journeyIds` limita a leitura a essas
// fichas (uma ficha aberta); sem ele, lê as mensagens com o rótulo do lance e depois os vínculos delas.
async function loadMessageBids(ctx, read = allRows, journeyIds = null) {
  const env = 'eq.' + ctx.environment;
  let links, messages;
  if (Array.isArray(journeyIds)) {
    const ids = [...new Set(journeyIds.filter(Boolean))];
    if (!ids.length) return new Map();
    links = (await Promise.all(chunks(ids).map((part) => read(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null', journey_id: inList(part) })))).flat();
    const messageIds = [...new Set(links.map((link) => link.message_id))];
    messages = (await Promise.all(chunks(messageIds).map((part) => read(ctx, 'messages', { select: 'id,body_text,occurred_at_utc', environment: env, direction: 'eq.CUSTOMER', id: inList(part), or: FILTER })))).flat();
  } else {
    messages = await read(ctx, 'messages', { select: 'id,body_text,occurred_at_utc', environment: env, direction: 'eq.CUSTOMER', or: FILTER });
    const messageIds = [...new Set(messages.map((message) => message.id))];
    links = (await Promise.all(chunks(messageIds).map((part) => read(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null', message_id: inList(part) })))).flat();
  }
  const bidById = new Map();
  for (const message of messages || []) {
    if (message.undone_at) continue;
    const cents = bidCentsFromText(message.body_text);
    if (cents) bidById.set(message.id, { cents, at: Date.parse(message.occurred_at_utc) || 0 });
  }
  const best = new Map();
  for (const link of links || []) {
    const bid = bidById.get(link.message_id);
    if (!bid) continue;
    const current = best.get(link.journey_id);
    if (!current || bid.at > current.at) best.set(link.journey_id, bid);
  }
  return new Map([...best].map(([journeyId, bid]) => [journeyId, bid.cents]));
}

// Põe `message_bid_cents` nas fichas lidas. Uma falha de leitura nunca derruba a lista: a ficha só fica como era.
async function attachMessageBids(ctx, journeys, read = allRows, options = {}) {
  const list = (journeys || []).filter((journey) => journey && journey.id);
  if (!list.length) return journeys;
  const bids = await loadMessageBids(ctx, read, options.scoped ? list.map((journey) => journey.id) : null).catch(() => new Map());
  for (const journey of list) if (bids.has(journey.id)) journey.message_bid_cents = bids.get(journey.id);
  return journeys;
}

module.exports = { bidCentsFromText, loadMessageBids, attachMessageBids };

'use strict';

// PESQUISAS → ficha → OPÇÕES. Um pedido lido da conversa (origem CONVERSA), completo para a busca,
// vai para a ficha da conversa pelo mesmo caminho de "marcar carro na mensagem"
// (panel_mark_message_fact_v2: histórico, evidência na mensagem do cliente e desfazer), e o pedido
// da ficha é comparado com o lote ativo na hora: os carros aparecem em OPÇÕES (Lane/Run etc.).
// Só entra em ficha que ainda não tem carro nem tipo de busca: nada que o operador já definiu é
// trocado. Nada é enviado ao cliente.
const { rpc } = require('./panel-server');
const { normalizeWishlist, modeVehicleText, modeWishText, wishlistText, SEARCH_MODES } = require('./panel-domain');
const { inferredMakeOf } = require('./vehicle-requests');
const vehicleMatch = require('./vehicle-match');

// "2020 ou mais novo" é de 2020 até o ano-modelo atual; "menos de 60 mil milhas" é de 1 a 60 mil.
// É o sentido literal do que o cliente disse; o lado que ele não disse não é inventado de outro jeito.
function wishFor(criteria, mode, now = new Date()) {
  const c = criteria || {};
  const wish = normalizeWishlist({ make: c.make || inferredMakeOf(c) || '', model: c.model || '', trim: c.trim || '', yearMin: c.yearMin || null, yearMax: c.yearMax || null, minMiles: c.minMiles || null, maxMiles: c.maxMiles || null });
  if (mode === 'CARRO') {
    if (wish.yearMin && !wish.yearMax) wish.yearMax = now.getUTCFullYear() + 1;
    if (wish.maxMiles && !wish.minMiles) wish.minMiles = 1;
  } else {
    // POR VALOR: só o carro; ano e milhagem não fazem parte dessa busca (regra da mesa).
    ['yearMin', 'yearMax', 'minMiles', 'maxMiles'].forEach((field) => { wish[field] = null; });
  }
  return wish;
}

// Ficha de cada mensagem de evidência; o pedido só vai para uma ficha quando todas apontam para a mesma.
function fichaOf(item, base) {
  const byMessage = new Map();
  (base.messageLinks || []).forEach((link) => { if (!link.undone_at) { if (!byMessage.has(link.message_id)) byMessage.set(link.message_id, new Set()); byMessage.get(link.message_id).add(link.journey_id); } });
  const owners = new Set((item.evidence || []).flatMap((message) => [...(byMessage.get(message.id) || [])]));
  return owners.size === 1 ? [...owners][0] : null;
}

// Which conversation requests can go to their ficha now, and why the others cannot. The requests
// of one ficha and one search type go together (up to 5 cars, as when marking cars on a message);
// a ficha gets one search type per round (the one with more requests).
function carryPlan(items, base) {
  const customer = new Set((base.messages || []).filter((message) => message.direction === 'CUSTOMER' && !message.undone_at).map((message) => message.id));
  const groups = new Map(), skipped = [];
  for (const item of items) {
    if (item.source !== 'CONVERSA' || item.completeness !== 'PRONTO' || !SEARCH_MODES.includes(item.searchMode)) continue;
    const journeyId = fichaOf(item, base);
    const journey = journeyId ? base.journeyById.get(journeyId) : null;
    if (!journey) { skipped.push({ key: item.key, reason: 'SEM_FICHA_UNICA' }); continue; }
    if (journey.status === 'ENCERRADO' || journey.stage_frozen) { skipped.push({ key: item.key, reason: 'FICHA_ENCERRADA' }); continue; }
    // A ficha that already has a car or a search type keeps what the operator defined.
    if ((base.demands.byJourney.get(journey.id) || []).length) { skipped.push({ key: item.key, reason: 'FICHA_JA_TEM_CARRO', journeyId: journey.id }); continue; }
    const evidence = (item.evidence || []).filter((message) => customer.has(message.id)).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (!evidence) { skipped.push({ key: item.key, reason: 'SEM_MENSAGEM_DO_CLIENTE' }); continue; }
    if (!groups.has(journey.id)) groups.set(journey.id, new Map());
    const byMode = groups.get(journey.id);
    if (!byMode.has(item.searchMode)) byMode.set(item.searchMode, []);
    byMode.get(item.searchMode).push({ item, evidence });
  }
  const plan = [];
  const sameCar = (left, right) => vehicleMatch.fold(left.make) === vehicleMatch.fold(right.make) && vehicleMatch.fold(left.model) === vehicleMatch.fold(right.model);
  groups.forEach((byMode, journeyId) => {
    const [mode, entries] = [...byMode.entries()].sort((a, b) => b[1].length - a[1].length)[0];
    byMode.forEach((others, other) => { if (other !== mode) others.forEach(({ item }) => skipped.push({ key: item.key, reason: 'OUTRO_TIPO_DE_BUSCA', journeyId })); });
    const wishes = [];
    entries.forEach(({ item }) => { const wish = wishFor(item.criteria, mode); if (wish.model && !wishes.some((known) => sameCar(known, wish))) wishes.push(wish); });
    // The most recent customer message among the evidence (the mark is unique per message).
    const evidence = entries.map((entry) => entry.evidence).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    plan.push({ key: entries[0].item.key, keys: entries.map((entry) => entry.item.key), journeyId, mode, messageId: evidence.id, wishes: wishes.slice(0, 5), wish: wishes[0] });
  });
  return { plan, skipped };
}

// Writes one planned request into its ficha (one search type, its car). Returns the demand key.
async function carryOne(ctx, entry, options = {}) {
  const call = options.rpc || rpc;
  const wishes = entry.wishes && entry.wishes.length ? entry.wishes : [entry.wish];
  const text = modeWishText(entry.mode, wishes);
  const vehicleText = modeVehicleText([entry.mode], { [entry.mode]: text });
  await call(ctx, 'panel_mark_message_fact_v2', {
    p_environment: ctx.environment, p_journey_id: entry.journeyId, p_message_id: entry.messageId, p_kind: 'VEHICLE', p_actor_id: ctx.panel.id,
    p_value: String(wishlistText(wishes) || text).slice(0, 500),
    p_value_json: { mode: entry.mode, modeWishlists: wishes, ...(vehicleText && vehicleText.length <= 500 ? { vehicleText } : {}), origin: 'PESQUISAS', requestKey: entry.key },
    p_deadline_at: null, p_simulate_failure: false
  });
  return `journey:${entry.journeyId}:${entry.mode}`;
}

module.exports = { carryOne, carryPlan, fichaOf, wishFor };

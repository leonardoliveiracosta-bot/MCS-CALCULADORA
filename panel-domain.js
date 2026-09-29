'use strict';

const vehicleCatalog = require('./vehicle-catalog');
const vehicleMatch = require('./vehicle-match');

const DAY_MS = 24 * 60 * 60 * 1000;
const REF_RE = /^[A-HJ-NP-Z2-9]{5}$/;

function time(value) {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function clean(value) {
  return String(value || '').normalize('NFC').trim();
}

function fold(value) {
  return clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
}

function dataFor(row) {
  return row && row.dados && typeof row.dados === 'object' && !Array.isArray(row.dados) ? row.dados : {};
}

function normalizedMode(value) {
  const mode = fold(value).replace(/[\s_-]+/g, '');
  if (['carro', 'vehicle', 'veiculo', 'find', 'finditforme'].includes(mode)) return 'CARRO';
  if (['valor', 'value', 'budget', 'orcamento', 'calculadora', 'calculator'].includes(mode)) return 'VALOR';
  return null;
}

function logicalMode(row) {
  const data = dataFor(row);
  const event = clean(data.evento).toLocaleLowerCase('pt-BR');
  const explicit = normalizedMode(data.logical_mode || data.logicalMode || data.modo || data.mode || (row && row.logical_mode) || (row && row.logicalMode));
  if (explicit) return explicit;
  if (event === 'busca' || /(?:^|-)find(?:-|$)/i.test(clean(data.sid))) return 'CARRO';
  if (['simulacao', 'saida', 'share', 'whatsapp', 'sms'].includes(event)) return 'VALOR';
  return 'REVIEW';
}

function journeyLogicalMode(journey) {
  const criteria = journey && journey.criteria_json && typeof journey.criteria_json === 'object' && !Array.isArray(journey.criteria_json) ? journey.criteria_json : {};
  return normalizedMode(criteria.logical_mode || criteria.logicalMode || criteria.modo || criteria.mode || criteria.tipo || criteria.evento) || 'REVIEW';
}

function calcOrder(row) {
  const data = row && row.dados && typeof row.dados === 'object' ? row.dados : {};
  return [time(data.quando) || time(row.created_at) || 0, clean(row.id)];
}

function newer(left, right) {
  const a = calcOrder(left);
  const b = calcOrder(right);
  return a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0] - b[0];
}

function normalizeState(value) {
  let current = value;
  if (typeof current === 'string') {
    const trimmed = clean(current);
    if (trimmed.startsWith('{')) {
      try { current = JSON.parse(trimmed); } catch (_) { return trimmed.toUpperCase(); }
    } else return trimmed.toUpperCase();
  }
  if (!current || typeof current !== 'object') return clean(current).toUpperCase();
  return clean(current.uf || current.state || current.sigla || current.code || current.nome).toUpperCase();
}

function latestValue(events, getter) {
  const ordered = events.slice().sort(newer).reverse();
  for (const row of ordered) {
    const value = getter(dataFor(row), row);
    if (value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return null;
}

function moneyCents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

function finiteInteger(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function normalizeWishlist(source) {
  const value = source && typeof source === 'object' && !Array.isArray(source) ? source : {};
  return {
    make: clean(value.make),
    model: clean(value.model),
    yearMin: finiteInteger(value.yearMin),
    yearMax: finiteInteger(value.yearMax),
    // milhas_de is the minimum mileage the customer accepts (CARRO); it is never the limit.
    minMiles: finiteInteger(value.minMiles),
    maxMiles: finiteInteger(value.maxMiles),
    trim: clean(value.trim)
  };
}

function wishlistsForJourney(journey) {
  const criteria = journey && journey.criteria_json && typeof journey.criteria_json === 'object' && !Array.isArray(journey.criteria_json) ? journey.criteria_json : {};
  const nested = criteria.wishlist && typeof criteria.wishlist === 'object' && !Array.isArray(criteria.wishlist) && Array.isArray(criteria.wishlist.wishlists) ? criteria.wishlist.wishlists : null;
  const sources = Array.isArray(criteria.wishlists) ? criteria.wishlists : nested || (criteria.wishlist && typeof criteria.wishlist === 'object' && !Array.isArray(criteria.wishlist) ? [criteria.wishlist] : []);
  return sources.slice(0, 5).map(normalizeWishlist).filter((wishlist) => wishlist.model);
}

// R1: once a Ref is linked to a ficha (journey), the ficha is the source of truth. The
// calculator only fills what the ficha does not have. R2: budget_cents is the maximum bid;
// the confirmed total ceiling is never used as a bid here.
function effectiveCriteria(journey, order) {
  const journeyWishes = journey ? wishlistsForJourney(journey) : [];
  const orderWishes = (order && Array.isArray(order.wishlists) ? order.wishlists : []).map(normalizeWishlist).filter((wish) => wish.model);
  const journeyBid = Number(journey && journey.budget_cents) > 0 ? Number(journey.budget_cents) : null;
  const orderBid = Number(order && order.budgetCents) > 0 ? Number(order.budgetCents) : null;
  // The ficha's wishes win. For the SAME model, fields the ficha does not have yet are filled
  // from the linked Ref (the year range stays one unit). Models that only exist in the Ref are
  // never added when the ficha already has wishes.
  const sameModel = (left, right) => vehicleCatalog.modelTokens(left.model, left.make).join(' ') === vehicleCatalog.modelTokens(right.model, right.make).join(' ')
    && (!left.make || !right.make || fold(left.make) === fold(right.make));
  // A:P6: a confirmed override (note or AI) that removed every car keeps the ficha empty; the
  // calculator Ref does not bring the old car back.
  const overridden = Boolean(journey && journey.criteria_json && journey.criteria_json.wishlistOverride === true);
  const wishes = journeyWishes.length
    ? journeyWishes.map((wish) => { const evidence = orderWishes.find((candidate) => sameModel(wish, candidate)); return evidence ? normalizeWishlist(mergeWishlist(wish, evidence)) : wish; })
    : overridden ? [] : orderWishes;
  return {
    wishes,
    wishesSource: journeyWishes.length || overridden ? 'FICHA' : orderWishes.length ? 'CALCULADORA' : null,
    bidCents: journeyBid || orderBid,
    bidSource: journeyBid ? 'FICHA' : orderBid ? 'CALCULADORA' : null,
    ceilingCents: Number(journey && journey.confirmed_total_ceiling_cents) > 0 ? Number(journey.confirmed_total_ceiling_cents) : null
  };
}

// R1: calculator values that differ from what the ficha already has. They are shown to the
// operator as "nova informação da calculadora" and never written into the ficha automatically.
function calculatorNews(journey, contactName, order) {
  if (!journey || !order) return [];
  const news = [];
  const differs = (left, right) => clean(left) && clean(right) && fold(left) !== fold(right);
  if (Number(journey.budget_cents) > 0 && Number(order.budgetCents) > 0 && Number(journey.budget_cents) !== Number(order.budgetCents)) news.push({ field: 'LANCE', fichaCents: Number(journey.budget_cents), calculatorCents: Number(order.budgetCents) });
  if (differs(journey.payment_text, order.paymentText)) news.push({ field: 'PAGAMENTO', ficha: clean(journey.payment_text), calculator: clean(order.paymentText) });
  if (differs(journey.vehicle_text, order.vehicleText)) news.push({ field: 'VEICULO', ficha: clean(journey.vehicle_text), calculator: clean(order.vehicleText) });
  if (differs(contactName, order.contactName) && !/^contato da ref/i.test(clean(contactName))) news.push({ field: 'NOME', ficha: clean(contactName), calculator: clean(order.contactName) });
  return news;
}

function wishlistForJourney(journey) {
  return wishlistsForJourney(journey)[0] || normalizeWishlist({});
}

// Fills what `current` does not have from `incoming`. The year range is one unit: both years
// come from the same source, so two sources never mix into an impossible range (A6).
// The mileage range is one unit too: minimum and maximum always come from the same source.
const WISH_FIELD_GROUPS = [['make'], ['model'], ['trim'], ['yearMin', 'yearMax'], ['minMiles', 'maxMiles']];
function mergeWishlist(current, incoming) {
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const proposed = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  const empty = (value) => value === null || value === undefined || value === '';
  const result = { ...existing };
  for (const group of WISH_FIELD_GROUPS) {
    if (group.every((field) => empty(result[field])) && group.some((field) => !empty(proposed[field]))) {
      for (const field of group) result[field] = empty(proposed[field]) ? (result[field] ?? null) : proposed[field];
    }
  }
  return result;
}

function mergeWishlists(current, incoming) {
  const result = (Array.isArray(current) ? current : current ? [current] : []).slice(0, 5).map(normalizeWishlist).filter((wishlist) => wishlist.model);
  for (const proposed of (Array.isArray(incoming) ? incoming : incoming ? [incoming] : []).map(normalizeWishlist).filter((wishlist) => wishlist.model)) {
    const index = result.findIndex((existing) => vehicleCatalog.modelTokens(existing.model, existing.make).join(' ') === vehicleCatalog.modelTokens(proposed.model, proposed.make).join(' ')
      && (!existing.make || !proposed.make || fold(existing.make) === fold(proposed.make)));
    if (index >= 0) result[index] = mergeWishlist(result[index], proposed);
    else if (result.length < 5) result.push(proposed);
  }
  return result;
}

function wishlistText(wishlist) {
  const wishes = Array.isArray(wishlist) ? wishlist : [wishlist || {}];
  return wishes.slice(0, 5).map((wish) => {
    const years = wish.yearMin && wish.yearMax && wish.yearMin !== wish.yearMax ? `${wish.yearMin}–${wish.yearMax}` : wish.yearMin || wish.yearMax || null;
    return clean([years, wish.make, wish.model].filter(Boolean).join(' '));
  }).filter(Boolean).join(' · ');
}

// The rule per mode lives in vehicle-match.js, shared with the browser.
function matchManheimDemand(vehicle, demand) {
  return demand && demand.active !== false ? vehicleMatch.matchDemand(vehicle, demand) : null;
}

// A5: ENCERRADO always wins over the on/off switch. A closed ficha only comes back through an
// explicit reopen; switching it on or off never makes it active again.
function toggleEnabled(status, state) {
  if (status === 'ENCERRADO') return false;
  return state ? state.enabled !== false : true;
}

function journeyEnabled(journey) {
  if (!journey || journey.status === 'ENCERRADO') return false;
  if (typeof journey.enabled === 'boolean') return journey.enabled;
  return true;
}

function reactivationEligible(journey) {
  if (!journey) return false;
  if (journey.status === 'PARADO') return true;
  // A closed ficha stays closed until it is reopened explicitly (A5): it is never reactivated by a car.
  if (journey.status === 'ENCERRADO') return false;
  return !journeyEnabled(journey) && ['GAVE_UP', 'NO_RESPONSE'].includes(clean(journey.offReason || journey.off_reason));
}

function buildReturns(journey, promises) {
  const result = [];
  if (journey && journey.next_action_at) result.push({
    id: 'next:' + journey.id, kind: 'NEXT_ACTION', dueAt: journey.next_action_at,
    text: clean(journey.next_action_text), origin: 'Manual', status: 'OPEN'
  });
  for (const promise of Array.isArray(promises) ? promises : []) result.push({
    id: promise.id, kind: 'PROMISE', dueAt: promise.due_at, text: clean(promise.promise_text),
    origin: 'Mensagem', status: promise.status
  });
  return result.sort((a, b) => (time(a.dueAt) || 0) - (time(b.dueAt) || 0) || a.id.localeCompare(b.id));
}

function modelWithMake(makeValue, modelValue) {
  const make = clean(makeValue);
  let model = clean(modelValue);
  if (/^(not sure|n[ãa]o tenho certeza|no estoy seguro|n[ãa]o sei)$/i.test(model)) model = '';
  if (/^other model$/i.test(model)) model = 'Outro modelo';
  if (!make) return model;
  if (!model) return make;
  const makeFold = fold(make);
  const modelFold = fold(model);
  return modelFold === makeFold || modelFold.startsWith(makeFold + ' ') ? model : `${make} ${model}`;
}

function vehicleFor(data) {
  const years = data.ano_de && data.ano_ate && data.ano_de !== data.ano_ate
    ? `${data.ano_de}–${data.ano_ate}`
    : data.ano_de || data.ano_ate;
  const vehicle = modelWithMake(data.marca, data.modelo);
  const trim = clean(data.trim);
  const usefulTrim = /^(not sure|n[ãa]o tenho certeza|no estoy seguro|n[ãa]o sei)$/i.test(trim) ? '' : trim;
  return clean([years, vehicle, usefulTrim].filter(Boolean).join(' '));
}

function compactWishlistText(wishlists) {
  const items = (Array.isArray(wishlists) ? wishlists : []).filter((wish) => clean(wish && wish.model));
  if (!items.length) return '';
  // Keep the requested model years visible when requests under one Ref are combined.
  if (items.some((wish) => wish.yearMin || wish.yearMax)) return wishlistText(items);
  const makes = [...new Map(items.filter((wish) => clean(wish.make)).map((wish) => [fold(wish.make), clean(wish.make)])).values()];
  if (makes.length === 1 && items.every((wish) => !clean(wish.make) || fold(wish.make) === fold(makes[0]))) {
    const make = makes[0];
    const models = [...new Set(items.map((wish) => {
      let model = clean(wish.model);
      if (/^(not sure|n[ãa]o tenho certeza|no estoy seguro|n[ãa]o sei)$/i.test(model)) model = '';
      if (/^other model$/i.test(model)) model = 'Outro modelo';
      const makeKey = fold(make);
      return fold(model).startsWith(makeKey + ' ') ? clean(model.slice(make.length)) : model;
    }).filter(Boolean))];
    return clean(`${make} ${models.join(' · ')}`);
  }
  return [...new Set(items.map((wish) => modelWithMake(wish.make, wish.model)).filter(Boolean))].join(' · ');
}

function wishlistsFromCalculatorEvents(events) {
  const collected = [];
  // Newest first: inside a Ref the most recent value of each field wins (A6).
  for (const row of events.slice().sort(newer).reverse()) {
    const data = dataFor(row);
    const arrays = [data.carros, data.veiculos, data.vehicles].find(Array.isArray);
    const sources = arrays || [data];
    for (const source of sources) {
      const wishlist = normalizeWishlist({
        make: source.marca ?? source.make,
        model: source.modelo ?? source.model,
        yearMin: source.ano_de ?? source.yearMin,
        yearMax: source.ano_ate ?? source.yearMax,
        // A:P10: milhas_de is the minimum the customer accepts, never the mileage limit.
        minMiles: source.milhas_de ?? source.minMiles,
        maxMiles: source.milhas_ate ?? source.maxMiles,
        trim: /^(not sure|n[ãa]o tenho certeza|no estoy seguro|n[ãa]o sei)$/i.test(clean(source.trim)) ? '' : source.trim
      });
      if (wishlist.model) collected.push(wishlist);
    }
  }
  return mergeWishlists([], collected);
}

function contactChannel(events) {
  const latestContact = events.filter((row) => ['whatsapp', 'sms'].includes(fold(dataFor(row).evento))).sort(newer).at(-1);
  if (latestContact) return fold(dataFor(latestContact).evento).toUpperCase();
  const channel = latestValue(events, (data) => data.evento === 'busca' ? data.canal : null);
  return ['whatsapp', 'sms'].includes(fold(channel)) ? fold(channel).toUpperCase() : null;
}

function calculatorEventStatus(item) {
  if (item && item.contactChannel === 'WHATSAPP') return 'WHATSAPP CLICADO';
  if (item && item.contactChannel === 'SMS') return 'SMS CLICADO';
  const event = fold(item && item.event);
  if (event === 'share') return 'COMPARTILHADO';
  if (event === 'saida') return 'FINALIZADO';
  if (event === 'simulacao') return 'SIMULADO';
  if (event === 'busca') return 'BUSCA ENVIADA';
  return 'EM REVISÃO';
}

function consolidateCalcRuns(rows, links = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const data = dataFor(row);
    const mode = logicalMode(row);
    const sid = clean(data.sid);
    const ref = clean(data.ref).toUpperCase();
    if (row && row.is_test === true) continue;
    if (mode === 'REVIEW' || !sid || !REF_RE.test(ref) || ref === 'ABCDE') continue;
    const key = [ref, mode].join('\u001f');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].map(([key, events]) => {
    const snapshot = events.slice().sort(newer).at(-1);
    const data = dataFor(snapshot);
    const [ref, mode] = key.split('\u001f');
    const sids = [...new Set(events.map((row) => clean(dataFor(row).sid)).filter(Boolean))];
    const link = (Array.isArray(links) ? links : []).find((candidate) => clean(candidate.calc_ref).toUpperCase() === ref && clean(candidate.logical_mode) === mode && sids.includes(clean(candidate.calc_sid))) || null;
    const vehicles = [...new Set(events.map((row) => vehicleFor(dataFor(row))).filter(Boolean))];
    const budget = latestValue(events, (event, row) => event.lance ?? row.lance);
    const payment = latestValue(events, (event, row) => event.pagamento ?? row.pagamento);
    const state = latestValue(events, (event, row) => event.estado ?? row.estado);
    const wishlists = wishlistsFromCalculatorEvents(events);
    const channel = contactChannel(events);
    const item = {
      key: 'calculator:' + key, sid: sids[0], sids, ref, logicalMode: mode,
      eventCount: events.length,
      event: clean(data.evento),
      occurredAt: data.quando || snapshot.created_at || null,
      vehicles,
      vehicleText: compactWishlistText(wishlists) || vehicles.join(' · ') || null,
      wishlist: wishlists[0] || normalizeWishlist({}),
      wishlists,
      budgetCents: moneyCents(budget),
      paymentText: clean(payment) || null,
      contactName: clean(latestValue(events, (event) => event.nome)) || null,
      plate: clean(latestValue(events, (event) => event.placa)) || null,
      registrationFlorida: normalizeState(state) === 'FL',
      deadlineText: clean(latestValue(events, (event) => event.prazo)) || null,
      yearsText: clean(latestValue(events, (event) => event.ano_de || event.ano_ate) && [latestValue(events, (event) => event.ano_de), latestValue(events, (event) => event.ano_ate)].filter(Boolean).join('–')) || null,
      mileageText: clean([latestValue(events, (event) => event.milhas_de), latestValue(events, (event) => event.milhas_ate)].filter((value) => value !== null).join('–')) || null,
      state: normalizeState(state) || null,
      zip: clean(latestValue(events, (event, row) => event.zip ?? row.zip)) || null,
      contactChannel: channel,
      clickedContact: Boolean(channel),
      link: link ? { contactId: link.contact_id || null, journeyId: link.journey_id || null } : null
    };
    item.eventStatus = calculatorEventStatus(item);
    return item;
  }).sort((a, b) => (time(b.occurredAt) || 0) - (time(a.occurredAt) || 0) || a.key.localeCompare(b.key));
}


function groupCalculatorByRef(orders, dispositions = []) {
  const dispositionMap = new Map((Array.isArray(dispositions) ? dispositions : [])
    .filter((item) => item.item_kind === 'REF')
    .map((item) => [clean(item.item_key).toUpperCase(), item]));
  const grouped = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    const ref = clean(order && order.ref).toUpperCase();
    if (!REF_RE.test(ref)) continue;
    if (!grouped.has(ref)) grouped.set(ref, []);
    grouped.get(ref).push(order);
  }
  return [...grouped.entries()].map(([ref, simulations]) => {
    const sorted = simulations.slice().sort((a, b) => (time(b.occurredAt) || 0) - (time(a.occurredAt) || 0) || String(a.key).localeCompare(String(b.key)));
    const latest = sorted[0];
    const contacted = sorted.find((item) => item.clickedContact) || latest;
    const links = sorted.map((item) => item.link && item.link.journeyId).filter(Boolean);
    const journeyIds = [...new Set(links)];
    const modes = [...new Set(sorted.map((item) => item.logicalMode).filter((mode) => ['CARRO', 'VALOR'].includes(mode)))];
    const disposition = dispositionMap.get(ref) || null;
    // One person, one card. Inside it the two modes stay separate: the wishes of each mode are
    // merged only with the same mode (newest value wins, A6) and tagged with it; the bid only
    // comes from VALOR and years/mileage only from CARRO. Nothing is combined across modes.
    const byMode = (mode) => sorted.filter((item) => item.logicalMode === mode);
    const modeWishes = (mode) => mergeWishlists([], byMode(mode).flatMap((item) => item.wishlists || [])).map((wish) => ({ ...(mode === 'VALOR' ? { ...wish, yearMin: null, yearMax: null, minMiles: null, maxMiles: null } : wish), mode }));
    const wishlists = [...modeWishes('VALOR'), ...modeWishes('CARRO')];
    const newest = (getter, list = sorted) => { for (const item of list) { const value = getter(item); if (value !== null && value !== undefined && value !== '') return value; } return null; };
    const modeText = (mode) => compactWishlistText(modeWishes(mode)) || byMode(mode).map((item) => item.vehicleText).find(Boolean) || null;
    const vehicleText = modes.length > 1
      ? modeVehicleText(modes, { VALOR: modeText('VALOR'), CARRO: modeText('CARRO') })
      : compactWishlistText(wishlists) || latest.vehicleText;
    const valorBid = newest((item) => Number(item.budgetCents) > 0 ? Number(item.budgetCents) : null, byMode('VALOR'));
    return {
      ...latest,
      budgetCents: valorBid,
      paymentText: newest((item) => item.paymentText),
      deadlineText: newest((item) => item.deadlineText),
      zip: newest((item) => item.zip),
      state: newest((item) => item.state),
      yearsText: newest((item) => item.yearsText, byMode('CARRO')),
      mileageText: newest((item) => item.mileageText, byMode('CARRO')),
      key: 'ref:' + ref,
      ref,
      kind: 'CALCULATOR',
      simulations: sorted,
      simulationCount: sorted.length,
      logicalModes: modes,
      // A person with both modes has no single mode: logicalModes lists them, each demand separate.
      logicalMode: modes.length === 1 ? modes[0] : null,
      modeSummaries: Object.fromEntries(modes.map((mode) => [mode, { vehicleText: modeText(mode), budgetCents: mode === 'VALOR' ? valorBid : null, yearsText: mode === 'CARRO' ? newest((item) => item.yearsText, byMode('CARRO')) : null, mileageText: mode === 'CARRO' ? newest((item) => item.mileageText, byMode('CARRO')) : null }])),
      eventCount: sorted.reduce((sum, item) => sum + Number(item.eventCount || 0), 0),
      vehicleText,
      wishlist: wishlists[0] || latest.wishlist,
      wishlists,
      clickedContact: sorted.some((item) => item.clickedContact),
      contactChannel: contacted && contacted.clickedContact ? contacted.contactChannel : null,
      contactName: sorted.find((item) => item.contactName)?.contactName || null,
      plate: sorted.find((item) => item.plate)?.plate || null,
      link: journeyIds.length === 1 ? { journeyId: journeyIds[0], contactId: (sorted.find((item) => item.link && item.link.journeyId === journeyIds[0]) || {}).link?.contactId || null } : null,
      journeyId: journeyIds.length === 1 ? journeyIds[0] : null,
      disposition: disposition ? disposition.status : null,
      discardReason: disposition ? disposition.discard_reason || null : null,
      dispositionUpdatedAt: disposition ? disposition.updated_at : null,
      pending: !disposition,
      outOfStandard: Number(valorBid) > 0 && !standardBudget(valorBid)
    };
  }).sort((a, b) => (time(b.occurredAt) || 0) - (time(a.occurredAt) || 0) || a.ref.localeCompare(b.ref));
}

function standardBudget(budgetCents) {
  const value = Number(budgetCents) || 0;
  return !value || (value >= 300000 && value <= 30000000);
}

function reasonSuppressed(suppressions, journeyId, kind, eventAt, nowMs) {
  return (Array.isArray(suppressions) ? suppressions : []).some((item) => {
    if (item.journey_id !== journeyId || item.kind !== kind || item.cancelled_at) return false;
    const created = time(item.created_at) || 0;
    if (eventAt && eventAt > created) return false;
    if (item.action === 'DEFER') return (time(item.until_at) || 0) > nowMs;
    return item.action === 'DISMISS';
  });
}

function buildTodayItems(input, nowValue = new Date()) {
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : time(nowValue);
  const journeys = Array.isArray(input.journeys) ? input.journeys : [];
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const promises = Array.isArray(input.promises) ? input.promises : [];
  const divergences = Array.isArray(input.divergences) ? input.divergences : [];
  const units = Array.isArray(input.units) ? input.units : [];
  const checklist = Array.isArray(input.checklist) ? input.checklist : [];
  const suppressions = Array.isArray(input.suppressions) ? input.suppressions : [];
  const result = [];
  for (const journey of journeys) {
    // QUALIFICADO stays active since "Cliente deu OK" no longer closes: its returns still count.
    if (!journeyEnabled(journey) || journey.stage_frozen) continue;
    const ownMessages = messages.filter((item) => item.journey_id === journey.id && item.direction !== 'SYSTEM').sort((a, b) => (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0) - (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0));
    const latest = ownMessages.at(-1);
    const latestEvent = Math.max(time(latest && (latest.occurred_at_utc || latest.occurred_at_local || latest.created_at)) || 0, time(journey.last_effective_contact_at) || 0);
    const reasons = [];
    const add = (kind, label, anchor, extra = {}) => {
      if (!reasonSuppressed(suppressions, journey.id, kind, latestEvent, nowMs)) reasons.push({ kind, label, anchor: anchor || nowMs, ...extra });
    };
    // B1: an unreadable date is not an overdue return.
    if (journey.next_action_at && time(journey.next_action_at) !== null) {
      const due = time(journey.next_action_at);
      if (due <= nowMs) add('NEXT_ACTION', 'RETORNO VENCIDO', due, { dueAt: journey.next_action_at, detail: clean(journey.next_action_text), urgency: 'red' });
      else if (due - nowMs <= 2 * 60 * 60 * 1000) add('NEXT_ACTION', 'RETORNO EM ATÉ 2H', due, { dueAt: journey.next_action_at, detail: clean(journey.next_action_text), urgency: 'yellow' });
    }
    const missingSince = time(journey.next_action_missing_since);
    if (!journey.next_action_at && missingSince && nowMs - missingSince >= 2 * DAY_MS) add('MISSING_NEXT_ACTION', 'SEM PRÓXIMA AÇÃO', missingSince + 2 * DAY_MS);
    for (const item of divergences.filter((value) => value.journey_id === journey.id && value.status === 'OPEN')) add('DIVERGENCE', `DIVERGÊNCIA: ${item.field}`, time(item.created_at));
    for (const item of promises.filter((value) => value.journey_id === journey.id && value.status === 'OPEN' && time(value.due_at) !== null)) {
      const due = time(item.due_at);
      if (due <= nowMs) add('PROMISE', 'RETORNO VENCIDO', due, { dueAt: item.due_at, detail: clean(item.promise_text), urgency: 'red' });
      else if (due - nowMs <= 2 * 60 * 60 * 1000) add('PROMISE', 'RETORNO EM ATÉ 2H', due, { dueAt: item.due_at, detail: clean(item.promise_text), urgency: 'yellow' });
    }
    const ownUnits = units.filter((value) => value.journey_id === journey.id);
    const searchAt = time(journey.search_started_at);
    if (searchAt && !ownUnits.length && nowMs - searchAt >= 5 * DAY_MS) add('SEARCH_STALLED', 'BUSCA PARADA — 5 DIAS', searchAt + 5 * DAY_MS);
    for (const unit of ownUnits.filter((value) => value.status === 'UNDER_REVIEW')) {
      const anchor = Math.max(time(unit.presented_at) || 0, time(unit.last_customer_response_at) || 0);
      if (anchor && nowMs - anchor >= 7 * DAY_MS) add('UNIT_NO_RESPONSE', 'UNIDADE SEM RESPOSTA — 7 DIAS', anchor + 7 * DAY_MS, { detail: clean(unit.vehicle_text) });
    }
    if (!reasons.length) continue;
    const completed = checklist.filter((item) => item.journey_id === journey.id && item.status === 'COMPLETE').length;
    const waitingSince = Math.min(...reasons.map((item) => item.anchor));
    result.push({
      id: journey.id,
      contactId: journey.contact_id,
      referenceCode: clean(journey.reference_code) || null,
      phoneLast4: clean((journey.phones || []).find((phone) => phone.is_current !== false)?.phone_e164 || (journey.phones || [])[0]?.phone_raw).replace(/\D/g, '').slice(-4) || null,
      source: journey.source,
      name: clean(journey.contact && journey.contact.display_name) || 'Contato sem nome',
      vehicleText: clean(journey.vehicle_text) || null,
      stage: journey.stage,
      status: journey.status,
      enabled: journeyEnabled(journey),
      offReason: journey.offReason || journey.off_reason || null,
      budgetCents: Number(journey.budget_cents) || 0,
      checklistComplete: completed,
      checklistLabel: completed === 6 ? 'checklist completo' : `${completed}/6`,
      waitingSince: new Date(waitingSince).toISOString(),
      waitMs: Math.max(0, nowMs - waitingSince),
      waitColor: nowMs - waitingSince < DAY_MS ? 'green' : nowMs - waitingSince < 3 * DAY_MS ? 'yellow' : 'red',
      reasons
    });
  }
  return result.sort((a, b) => b.waitMs - a.waitMs || b.budgetCents - a.budgetCents || b.checklistComplete - a.checklistComplete || a.id.localeCompare(b.id));
}

function buildTodayOrderItems(orders, nowValue = new Date()) {
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : time(nowValue);
  return (Array.isArray(orders) ? orders : []).filter((item) => item.clickedContact && !item.link).map((item) => {
    const occurred = time(item.occurredAt) || nowMs;
    return {
      id: item.key,
      kind: 'CALCULATOR_ORDER',
      orderKey: item.key,
      name: item.ref ? `Ref ${item.ref}` : 'Pedido da calculadora',
      vehicleText: item.vehicleText,
      budgetCents: item.budgetCents || 0,
      checklistComplete: 0,
      checklistLabel: (item.logicalModes || []).length > 1 ? 'por valor e por ano e milhagem' : item.logicalMode === 'CARRO' ? 'carro ideal' : 'por valor',
      waitingSince: new Date(occurred).toISOString(),
      waitMs: Math.max(0, nowMs - occurred),
      waitColor: nowMs - occurred < DAY_MS ? 'green' : nowMs - occurred < 3 * DAY_MS ? 'yellow' : 'red',
      reasons: [{ kind: 'CONTACT_CLICK', label: `${item.contactChannel} CLICADO`, anchor: occurred }]
    };
  }).sort((a, b) => b.waitMs - a.waitMs || b.budgetCents - a.budgetCents || a.id.localeCompare(b.id));
}

function checklistSummary(points) {
  const completed = (Array.isArray(points) ? points : []).filter((item) => item.status === 'COMPLETE').length;
  return { completed, total: 6, label: completed === 6 ? 'checklist completo' : `${completed}/6` };
}

// M1: one vocabulary for the customer's deadline. The calculator sends "3mo" (Within 3 months);
// the panel stores "3m". An empty value is unknown, never "sem prazo".
function normalizeDeadline(value) {
  const text = fold(value);
  if (!text) return null;
  if (['now', 'agora', 'ready to buy now'].includes(text)) return 'now';
  if (['30d', '30 dias', 'within 30 days'].includes(text)) return '30d';
  if (['3m', '3mo', '90d', '30–90 dias', '3 meses', 'within 3 months'].includes(text)) return '3m';
  if (['none', 'sem prazo', 'no set date yet'].includes(text)) return 'none';
  return ['6m', '12m'].includes(text) ? text : null;
}

// M11 / E:M4: payment is "cash", "fin" or unknown (null). Free text such as "financiado" or
// "vou financiar" is financing, never cash by default.
function normalizePayment(value) {
  const text = fold(value);
  if (!text) return null;
  if (/\b(fin|financ\w*|loan|parcel\w*)/.test(text)) return 'fin';
  if (/\b(cash|a vista|vista|dinheiro)\b/.test(text)) return 'cash';
  return null;
}

function shortDeadline(deadline, nowValue = new Date()) {
  const due = time(deadline);
  const nowMs = nowValue instanceof Date ? nowValue.getTime() : time(nowValue);
  return Boolean(due && due >= nowMs && due - nowMs <= 30 * DAY_MS);
}

function searchMatches(query, record) {
  const needle = fold(query);
  if (!needle) return false;
  const values = [record.display_name, record.phone_e164, record.phone_raw, record.ref_code].map(fold);
  const compact = needle.replace(/\D/g, '');
  const phoneLike = /^[+\d\s().-]+$/.test(clean(query));
  return values.some((value) => value.includes(needle))
    || Boolean(phoneLike && compact && values.some((value) => value.replace(/\D/g, '').includes(compact)));
}

function orderSearchMatches(query, order) {
  const raw = clean(query);
  const needle = fold(raw.replace(/^ref\s*:?[\s-]*/i, ''));
  if (!needle) return false;
  return [order && order.ref, order && order.vehicleText, order && order.zip].map(fold).some((value) => value.includes(needle));
}

// Stages only move forward on their own (owner's rule); a manual change is always possible.
const STAGE_RANK = Object.freeze({ NOVO: 0, RESPONDIDO: 1, EM_BUSCA: 2, DECIDINDO: 3, QUALIFICADO: 4 });

function forwardStage(currentStage, targetStage) {
  const current = STAGE_RANK[currentStage], target = STAGE_RANK[targetStage];
  if (target === undefined) return currentStage;
  return current === undefined || target > current ? targetStage : currentStage;
}

// A presented car (any unit not withdrawn) means the search is on; a customer reviewing or
// accepting a car means the customer is deciding. Never moves a stage back.
function nextStageForUnits(currentStage, units) {
  const live = (Array.isArray(units) ? units : []).filter((item) => item && item.status !== 'WITHDRAWN');
  if (live.some((item) => item.status === 'UNDER_REVIEW' || item.status === 'ACCEPTED')) return forwardStage(currentStage, 'DECIDINDO');
  if (live.length) return forwardStage(currentStage, 'EM_BUSCA');
  return currentStage;
}

// "Cliente deu OK" = the customer agreed to proceed: the journey becomes QUALIFICADO and stays
// open (owner's decision). Closing is an explicit action (the on/off switch).
function clientOkPatch(at, messageId, currentStage) {
  if (currentStage === 'QUALIFICADO') return { updated_at: at };
  return { stage: 'QUALIFICADO', qualified_at: at, qualified_message_id: messageId, updated_at: at };
}

const INTERACTION_TIMELINE_LABELS = Object.freeze({
  CALL_ANSWERED: 'Ligação atendida',
  CALL_ATTEMPT: 'Tentativa de ligação',
  IN_PERSON: 'Interação presencial',
  NEXT_ACTION_CREATED: 'Retorno agendado',
  NEXT_ACTION_COMPLETED: 'Retorno concluído',
  NEXT_ACTION_REMOVED: 'Retorno removido',
  SEARCH_STARTED: 'Busca iniciada',
  JOURNEY_CLOSED: 'Jornada encerrada',
  JOURNEY_QUALIFIED: 'Jornada qualificada'
});

const SYSTEM_TIMELINE_LABELS = Object.freeze({
  JOURNEY_FUNNEL_CHANGED: 'Etapa alterada',
  CLIENT_GAVE_OK: 'Cliente deu OK: jornada qualificada',
  PROMISE_RECORDED: 'Promessa registrada',
  PROMISE_FULFILLED: 'Promessa cumprida',
  UNIT_UPDATED: 'Unidade atualizada'
});

function buildConversationTimeline(messages, interactions, activities) {
  const result = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    result.push({
      ...message,
      timelineType: 'message',
      occurredAt: message.occurred_at_utc || message.occurred_at_local || message.created_at
    });
  }
  for (const interaction of Array.isArray(interactions) ? interactions : []) {
    const label = INTERACTION_TIMELINE_LABELS[interaction.type];
    if (!label || interaction.message_id) continue;
    result.push({ id: 'interaction:' + interaction.id, timelineType: 'interaction', occurredAt: interaction.occurred_at || interaction.created_at, eventType: interaction.type, label });
  }
  for (const activity of Array.isArray(activities) ? activities : []) {
    const label = SYSTEM_TIMELINE_LABELS[activity.activity_type];
    if (!label) continue;
    result.push({ id: 'activity:' + activity.id, timelineType: 'system', occurredAt: activity.occurred_at, eventType: activity.activity_type, label });
  }
  return result.sort((left, right) => {
    const delta = (time(left.occurredAt) || 0) - (time(right.occurredAt) || 0);
    if (delta) return delta;
    const order = (Number(left.original_order) || 0) - (Number(right.original_order) || 0);
    return order || String(left.id).localeCompare(String(right.id));
  });
}

// ---------------------------------------------------------------------------------------------
// Search demands (BUSCAS and Manheim). A demand is one person (a ficha or a Ref without ficha)
// in one logical mode. VALOR and CARRO of the same person are two independent demands and
// never share criteria: VALOR keeps make, model and the VALOR bid; CARRO keeps make, model,
// trim (information only), and both year and mileage ranges. There is no combined demand.
const SEARCH_MODES = Object.freeze(['VALOR', 'CARRO']);

// The vehicle text of a person with searches: with both modes each one is labelled, VALOR first
// ("Por valor: X · Por ano e milhagem: Y"); with one mode, only that mode's text. BUSCAS and the
// ficha's vehicle_text use this same rule.
const MODE_TEXT_LABELS = [['VALOR', 'Por valor'], ['CARRO', 'Por ano e milhagem']];
function modeVehicleText(modes, textByMode) {
  const list = MODE_TEXT_LABELS.filter(([mode]) => (modes || []).includes(mode));
  if (list.length > 1) return list.map(([mode, label]) => textByMode[mode] ? `${label}: ${textByMode[mode]}` : null).filter(Boolean).join(' · ');
  return list.length ? textByMode[list[0][0]] || '' : '';
}

// Text of one mode's wishes as BUSCAS shows it: VALOR never shows years or mileage.
function modeWishText(mode, wishes) {
  return compactWishlistText(mode === 'VALOR' ? valorWishes(wishes) : carroWishes(wishes));
}

function valorWishes(wishes) {
  return (wishes || []).map(normalizeWishlist).filter((wish) => wish.model).map((wish) => ({ make: wish.make, model: wish.model, trim: wish.trim, yearMin: null, yearMax: null, minMiles: null, maxMiles: null }));
}

function carroWishes(wishes) {
  return (wishes || []).map(normalizeWishlist).filter((wish) => wish.model);
}

function finalizeDemand(demand) {
  const issues = [];
  const active = [];
  const wishes = demand.wishes || [];
  if (demand.mode === 'REVIEW') issues.push(...(demand.reviewIssues || [{ code: 'MODE_UNKNOWN', text: vehicleMatch.ISSUE_TEXT.MODE_UNKNOWN }]));
  else if (!wishes.length) issues.push({ code: 'MODEL_MISSING', text: vehicleMatch.ISSUE_TEXT.MODEL_MISSING });
  else wishes.forEach((wish) => {
    const code = demand.mode === 'CARRO' ? vehicleMatch.carroWishIssue(wish) : vehicleMatch.valorWishIssue(wish, demand.bidCents);
    if (code) issues.push({ code, text: vehicleMatch.ISSUE_TEXT[code], wish: clean([wish.make, wish.model].filter(Boolean).join(' ')) || null });
    else active.push(wish);
  });
  return { ...demand, activeWishes: active, issues, active: demand.mode !== 'REVIEW' && active.length > 0 };
}

// One demand per (Ref, mode) for a Ref without ficha. `item` is one entry of consolidateCalcRuns
// (already split by logical mode), never the grouped person container.
function orderDemand(item) {
  const mode = item && SEARCH_MODES.includes(item.logicalMode) ? item.logicalMode : null;
  if (!mode) return null;
  return finalizeDemand({
    key: `ref:${item.ref}:${mode}`, targetType: 'ORDER', ref: item.ref, journeyId: null, mode,
    wishes: mode === 'CARRO' ? carroWishes(item.wishlists) : valorWishes(item.wishlists),
    bidCents: mode === 'VALOR' && Number(item.budgetCents) > 0 ? Number(item.budgetCents) : null,
    occurredAt: item.occurredAt || null, sids: item.sids || [], source: 'CALCULADORA'
  });
}

// Modes the operator confirmed for a ficha in "Revisar tipo de busca".
function confirmedJourneyModes(journey) {
  const criteria = journey && journey.criteria_json && typeof journey.criteria_json === 'object' && !Array.isArray(journey.criteria_json) ? journey.criteria_json : {};
  const list = Array.isArray(criteria.logical_modes) ? criteria.logical_modes : criteria.logical_mode ? [criteria.logical_mode] : [];
  return [...new Set(list.map((value) => clean(value).toUpperCase()).filter((value) => SEARCH_MODES.includes(value)))];
}

// Manual criteria the operator saved for ONE mode (criteria_json.mode_overrides.CARRO / .VALOR).
// Additive and explicit; older fichas simply do not have it.
function modeOverrides(journey) {
  const criteria = journey && journey.criteria_json && typeof journey.criteria_json === 'object' && !Array.isArray(journey.criteria_json) ? journey.criteria_json : {};
  const source = criteria.mode_overrides && typeof criteria.mode_overrides === 'object' && !Array.isArray(criteria.mode_overrides) ? criteria.mode_overrides : {};
  const result = {};
  SEARCH_MODES.forEach((mode) => {
    const entry = source[mode];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    result[mode] = {
      wishlists: (Array.isArray(entry.wishlists) ? entry.wishlists : []).slice(0, 5).map(normalizeWishlist).filter((wish) => wish.model),
      override: entry.wishlistOverride === true || Array.isArray(entry.wishlists),
      bidCents: mode === 'VALOR' && Number(entry.bidCents) > 0 ? Number(entry.bidCents) : null
    };
  });
  return result;
}

// A generic ficha wish (without mode) that only repeats what the linked calculator Refs already
// say: same model, and every value it has is one of the values those Refs have for that model.
// Old fichas got such copies when a Ref was linked; they carry no manual decision.
function derivedFromRefs(wish, refWishes) {
  const sameModel = (refWishes || []).filter((ref) => vehicleCatalog.modelTokens(ref.model, ref.make).join(' ') === vehicleCatalog.modelTokens(wish.model, wish.make).join(' ')
    && (!ref.make || !wish.make || fold(ref.make) === fold(wish.make)));
  if (!sameModel.length) return false;
  return ['yearMin', 'yearMax', 'minMiles', 'maxMiles', 'trim'].every((field) => {
    const value = wish[field];
    if (value === null || value === undefined || value === '') return true;
    return sameModel.some((ref) => String(ref[field] ?? '') === String(value));
  });
}

// The demands of a ficha. Its modes come from its linked calculator Refs (split by mode), from a
// confirmed choice and from criteria saved for one mode. Each mode only reads its own data:
//  * VALOR: make and model of the VALOR Refs (or of mode_overrides.VALOR) and the bid.
//  * CARRO: make, model, trim, years and mileages of the CARRO Refs (or mode_overrides.CARRO).
//  * With ONE mode the ficha's generic wishes stay the source of truth (R1), as before.
//  * With TWO modes a generic wish is never applied to both: a copy of the Refs is ignored and
//    a real manual criterion without mode goes to REVIEW. The mode is never guessed.
function journeyDemands(journey, linkedItems) {
  if (!journey) return [];
  const items = (Array.isArray(linkedItems) ? linkedItems : []).filter((item) => SEARCH_MODES.includes(item.logicalMode));
  const overrides = modeOverrides(journey);
  const modes = new Set([...items.map((item) => item.logicalMode), ...confirmedJourneyModes(journey), ...Object.keys(overrides)]);
  const ownWishes = wishlistsForJourney(journey);
  const genericOverride = Boolean(journey.criteria_json && journey.criteria_json.wishlistOverride === true);
  const budget = Number(journey.budget_cents) > 0 ? Number(journey.budget_cents) : null;
  const base = { targetType: 'JOURNEY', journeyId: journey.id, ref: clean(journey.reference_code).toUpperCase() || (items[0] && items[0].ref) || null, source: journey.source || null, occurredAt: journey.updated_at || journey.created_at || null };
  if (!modes.size) {
    if (!ownWishes.length && !budget) return [];
    return [finalizeDemand({ ...base, key: `journey:${journey.id}:REVIEW`, mode: 'REVIEW', wishes: ownWishes, bidCents: budget })];
  }
  const twoModes = modes.size > 1;
  const refWishes = items.flatMap((item) => item.wishlists || []).map(normalizeWishlist);
  // A generic wish already assigned to a mode (the same values saved in mode_overrides) is not
  // pending either.
  const assigned = Object.values(overrides).flatMap((entry) => entry.wishlists);
  const manual = twoModes ? ownWishes.filter((wish) => !derivedFromRefs(wish, refWishes) && !derivedFromRefs(wish, assigned)) : [];
  const manualRemoval = twoModes && genericOverride && !ownWishes.length;
  const demands = SEARCH_MODES.filter((mode) => modes.has(mode)).map((mode) => {
    const own = items.filter((item) => item.logicalMode === mode).sort((a, b) => (time(b.occurredAt) || 0) - (time(a.occurredAt) || 0));
    const merged = own.length ? { wishlists: mergeWishlists([], own.flatMap((item) => item.wishlists || [])), budgetCents: mode === 'VALOR' ? own.map((item) => item.budgetCents).find((value) => Number(value) > 0) || null : null } : null;
    // The bid only exists in VALOR, so the ficha's bid never reaches CARRO.
    const bid = mode === 'VALOR' ? (overrides.VALOR && overrides.VALOR.bidCents) || budget : null;
    const ficha = overrides[mode]
      ? { ...journey, criteria_json: { wishlists: overrides[mode].wishlists, wishlistOverride: overrides[mode].override }, budget_cents: bid }
      : twoModes ? { ...journey, criteria_json: {}, budget_cents: bid } : { ...journey, budget_cents: bid };
    const criteria = effectiveCriteria(ficha, merged);
    return finalizeDemand({
      ...base, key: `journey:${journey.id}:${mode}`, mode, linkedRefs: [...new Set(own.map((item) => item.ref))],
      wishes: mode === 'CARRO' ? carroWishes(criteria.wishes) : valorWishes(criteria.wishes),
      // R2: only the bid; the confirmed total ceiling is never a bid. CARRO never has a bid.
      bidCents: mode === 'VALOR' ? criteria.bidCents : null
    });
  });
  if (manual.length || manualRemoval) demands.push(finalizeDemand({
    ...base, key: `journey:${journey.id}:REVIEW_MANUAL`, mode: 'REVIEW', manual: true, wishes: manual, bidCents: null,
    reviewIssues: [{ code: 'MANUAL_MODE_UNKNOWN', text: manualRemoval ? 'remoção manual de carros sem modo definido' : 'critério manual sem modo definido' }]
  }));
  return demands;
}

// Every demand of the environment. `modeItems` is consolidateCalcRuns(...) (one entry per Ref and
// mode). A Ref owned by a ficha (reference_code, journey_refs or a calculator link) is matched
// through the ficha (A4); the other Refs are demands of their own.
function buildSearchDemands({ journeys, refs, modeItems }) {
  const journeyList = Array.isArray(journeys) ? journeys : [];
  const byId = new Map(journeyList.map((journey) => [journey.id, journey]));
  const owner = new Map();
  journeyList.forEach((journey) => { const ref = clean(journey.reference_code).toUpperCase(); if (ref) owner.set(ref, journey.id); });
  (Array.isArray(refs) ? refs : []).forEach((row) => { const ref = clean(row.ref_code).toUpperCase(); if (ref && byId.has(row.journey_id)) owner.set(ref, row.journey_id); });
  const linked = new Map();
  const orders = [];
  (Array.isArray(modeItems) ? modeItems : []).forEach((item) => {
    const journeyId = owner.get(clean(item.ref).toUpperCase()) || (item.link && byId.has(item.link.journeyId) ? item.link.journeyId : null);
    if (journeyId) { if (!linked.has(journeyId)) linked.set(journeyId, []); linked.get(journeyId).push(item); return; }
    const demand = orderDemand(item);
    if (demand) orders.push(demand);
  });
  const byJourney = new Map(journeyList.map((journey) => [journey.id, journeyDemands(journey, linked.get(journey.id) || [])]));
  return { byJourney, orders, owner, linkedItems: linked };
}

module.exports = {
  DAY_MS, REF_RE, buildConversationTimeline, calculatorNews, effectiveCriteria, buildReturns, buildTodayItems, buildTodayOrderItems, calculatorEventStatus, checklistSummary, clean, clientOkPatch,
  compactWishlistText, consolidateCalcRuns, finiteInteger, fold, groupCalculatorByRef, journeyEnabled, toggleEnabled, journeyLogicalMode, logicalMode,
  buildSearchDemands, carroWishes, modeVehicleText, modeWishText, derivedFromRefs, modeOverrides, confirmedJourneyModes, finalizeDemand, journeyDemands, matchManheimDemand, orderDemand, SEARCH_MODES, valorWishes, mergeWishlist, mergeWishlists, modelWithMake, nextStageForUnits, forwardStage, STAGE_RANK, normalizeDeadline, normalizePayment,
  normalizeState, normalizeWishlist, wishlistsFromCalculatorEvents, orderSearchMatches, reactivationEligible, searchMatches, shortDeadline, standardBudget, time, wishlistForJourney, wishlistsForJourney, wishlistText
};

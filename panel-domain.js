'use strict';

const vehicleCatalog = require('./vehicle-catalog');

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
    maxMiles: finiteInteger(value.maxMiles)
  };
}

function wishlistsForJourney(journey) {
  const criteria = journey && journey.criteria_json && typeof journey.criteria_json === 'object' && !Array.isArray(journey.criteria_json) ? journey.criteria_json : {};
  const nested = criteria.wishlist && typeof criteria.wishlist === 'object' && !Array.isArray(criteria.wishlist) && Array.isArray(criteria.wishlist.wishlists) ? criteria.wishlist.wishlists : null;
  const sources = Array.isArray(criteria.wishlists) ? criteria.wishlists : nested || (criteria.wishlist && typeof criteria.wishlist === 'object' && !Array.isArray(criteria.wishlist) ? [criteria.wishlist] : []);
  return sources.slice(0, 5).map(normalizeWishlist).filter((wishlist) => wishlist.model);
}

function wishlistForJourney(journey) {
  return wishlistsForJourney(journey)[0] || normalizeWishlist({});
}

function mergeWishlist(current, incoming) {
  const existing = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const proposed = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
  const result = { ...existing };
  for (const field of ['make', 'model', 'yearMin', 'yearMax', 'maxMiles']) {
    if ((result[field] === null || result[field] === undefined || result[field] === '') && proposed[field] !== null && proposed[field] !== undefined && proposed[field] !== '') result[field] = proposed[field];
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

function normalizedVehicle(value) {
  return fold(value).replace(/[^a-z0-9]+/g, ' ').trim();
}

function matchManheimVehicle(vehicle, wishlist, budgetCents) {
  const wishes = Array.isArray(wishlist) ? wishlist.slice(0, 5) : wishlist && Array.isArray(wishlist.wishlists) ? wishlist.wishlists.slice(0, 5) : [wishlist || {}];
  const year = finiteInteger(vehicle && vehicle.year);
  const miles = finiteInteger(vehicle && vehicle.miles);
  const mmrCents = finiteInteger(vehicle && vehicle.mmrCents);
  if (!year || !clean(vehicle && vehicle.model)) return null;
  const candidates = [];
  wishes.forEach((wish, index) => {
    if (!clean(wish && wish.model)) return;
    if (clean(vehicle.make) && clean(wish.make) && normalizedVehicle(vehicle.make) !== normalizedVehicle(wish.make)) return;
    if (!vehicleCatalog.modelsMatch(vehicle.model, wish.model, vehicle.make, wish.make)) return;
  const yearMin = finiteInteger(wish.yearMin);
  const yearMax = finiteInteger(wish.yearMax);
  const maxMiles = finiteInteger(wish.maxMiles);
  const failures = [];
  if (yearMin && year < yearMin) failures.push({ kind: 'year', delta: yearMin - year, reason: `ano ${yearMin - year} abaixo` });
  if (yearMax && year > yearMax) failures.push({ kind: 'year', delta: year - yearMax, reason: `ano ${year - yearMax} acima` });
  if (maxMiles && miles && miles > maxMiles) failures.push({ kind: 'miles', delta: miles - maxMiles, reason: `milhas ${(miles - maxMiles).toLocaleString('pt-BR')} acima` });
  const kind = failures.length === 0 ? 'BATE' : failures.length === 1 && ((failures[0].kind === 'year' && failures[0].delta <= 1) || (failures[0].kind === 'miles' && failures[0].delta <= maxMiles * 0.1)) ? 'QUASE' : null;
    if (!kind) return;
    candidates.push({
    kind,
    reason: failures[0] ? failures[0].reason : null,
      mmrStatus: mmrCents && Number(budgetCents) > 0 ? (mmrCents > Number(budgetCents) ? 'MMR acima do teto' : 'MMR dentro do teto') : null,
      matchedWishlistIndex: index,
      matchedWishlistLabel: clean([wish.make, wish.model].filter(Boolean).join(' ')),
      makeNotice: clean(vehicle.makeNotice)
    });
  });
  return candidates.sort((left, right) => (left.kind === right.kind ? left.matchedWishlistIndex - right.matchedWishlistIndex : left.kind === 'BATE' ? -1 : 1))[0] || null;
}

function journeyEnabled(journey) {
  if (journey && typeof journey.enabled === 'boolean') return journey.enabled;
  return Boolean(journey && journey.status !== 'ENCERRADO');
}

function reactivationEligible(journey) {
  if (!journey) return false;
  if (journey.status === 'PARADO') return true;
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

function vehicleFor(data) {
  return clean([
    data.ano_de && data.ano_ate && data.ano_de !== data.ano_ate ? `${data.ano_de}–${data.ano_ate}` : data.ano_de || data.ano_ate,
    data.marca, data.modelo, data.trim
  ].filter(Boolean).join(' '));
}

function wishlistsFromCalculatorEvents(events) {
  const collected = [];
  for (const row of events.slice().sort(newer)) {
    const data = dataFor(row);
    const arrays = [data.carros, data.veiculos, data.vehicles].find(Array.isArray);
    const sources = arrays || [data];
    for (const source of sources) {
      const wishlist = normalizeWishlist({
        make: source.marca ?? source.make,
        model: source.modelo ?? source.model,
        yearMin: source.ano_de ?? source.yearMin,
        yearMax: source.ano_ate ?? source.yearMax,
        maxMiles: source.milhas_ate ?? source.maxMiles ?? source.milhas_de
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
      vehicleText: vehicles.join(' · ') || null,
      wishlist: wishlists[0] || normalizeWishlist({}),
      wishlists,
      budgetCents: moneyCents(budget),
      paymentText: clean(payment) || null,
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
    if (!journeyEnabled(journey) || journey.stage === 'QUALIFICADO' || journey.stage_frozen) continue;
    const ownMessages = messages.filter((item) => item.journey_id === journey.id && item.direction !== 'SYSTEM').sort((a, b) => (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0) - (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0));
    const latest = ownMessages.at(-1);
    const latestEvent = Math.max(time(latest && (latest.occurred_at_utc || latest.occurred_at_local || latest.created_at)) || 0, time(journey.last_effective_contact_at) || 0);
    const reasons = [];
    const add = (kind, label, anchor, extra = {}) => {
      if (!reasonSuppressed(suppressions, journey.id, kind, latestEvent, nowMs)) reasons.push({ kind, label, anchor: anchor || nowMs, ...extra });
    };
    if (journey.next_action_at) {
      const due = time(journey.next_action_at);
      if (due <= nowMs) add('NEXT_ACTION', 'RETORNO VENCIDO', due, { dueAt: journey.next_action_at, detail: clean(journey.next_action_text), urgency: 'red' });
      else if (due - nowMs <= 2 * 60 * 60 * 1000) add('NEXT_ACTION', 'RETORNO EM ATÉ 2H', due, { dueAt: journey.next_action_at, detail: clean(journey.next_action_text), urgency: 'yellow' });
    }
    const missingSince = time(journey.next_action_missing_since);
    if (!journey.next_action_at && missingSince && nowMs - missingSince >= 2 * DAY_MS) add('MISSING_NEXT_ACTION', 'SEM PRÓXIMA AÇÃO', missingSince + 2 * DAY_MS);
    for (const item of divergences.filter((value) => value.journey_id === journey.id && value.status === 'OPEN')) add('DIVERGENCE', `DIVERGÊNCIA: ${item.field}`, time(item.created_at));
    for (const item of promises.filter((value) => value.journey_id === journey.id && value.status === 'OPEN')) {
      const due = time(item.due_at) || 0;
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
      checklistLabel: item.logicalMode === 'CARRO' ? 'carro ideal' : 'por valor',
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

function nextStageForUnits(currentStage, units) {
  const reviewing = (Array.isArray(units) ? units : []).some((item) => item.status === 'UNDER_REVIEW');
  if (reviewing) return 'DECIDINDO';
  return currentStage === 'DECIDINDO' ? 'EM_BUSCA' : currentStage;
}

function clientOkPatch(at, messageId) {
  return {
    stage: 'QUALIFICADO', status: 'ENCERRADO', stage_frozen: true,
    qualified_at: at, qualified_message_id: messageId,
    closed_at: at, closed_reason: 'CLIENTE_DEU_OK',
    next_action_at: null, next_action_text: null, next_action_missing_since: null,
    updated_at: at
  };
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
  CLIENT_GAVE_OK: 'Jornada qualificada e encerrada',
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

module.exports = {
  DAY_MS, REF_RE, buildConversationTimeline, buildReturns, buildTodayItems, buildTodayOrderItems, calculatorEventStatus, checklistSummary, clean, clientOkPatch,
  consolidateCalcRuns, finiteInteger, fold, journeyEnabled, journeyLogicalMode, logicalMode, matchManheimVehicle, mergeWishlist, mergeWishlists, nextStageForUnits,
  normalizeState, orderSearchMatches, reactivationEligible, searchMatches, shortDeadline, time, wishlistForJourney, wishlistsForJourney, wishlistText
};

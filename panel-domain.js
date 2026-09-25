'use strict';

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

function vehicleFor(data) {
  return clean([
    data.ano_de && data.ano_ate && data.ano_de !== data.ano_ate ? `${data.ano_de}–${data.ano_ate}` : data.ano_de || data.ano_ate,
    data.marca, data.modelo, data.trim
  ].filter(Boolean).join(' '));
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
    const channel = contactChannel(events);
    const item = {
      key: 'calculator:' + key, sid: sids[0], sids, ref, logicalMode: mode,
      eventCount: events.length,
      event: clean(data.evento),
      occurredAt: data.quando || snapshot.created_at || null,
      vehicles,
      vehicleText: vehicles.join(' · ') || null,
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
    if (journey.status === 'ENCERRADO' || journey.stage === 'QUALIFICADO' || journey.stage_frozen) continue;
    const ownMessages = messages.filter((item) => item.journey_id === journey.id && item.direction !== 'SYSTEM').sort((a, b) => (time(a.occurred_at_utc || a.occurred_at_local || a.created_at) || 0) - (time(b.occurred_at_utc || b.occurred_at_local || b.created_at) || 0));
    const latest = ownMessages.at(-1);
    const latestEvent = Math.max(time(latest && (latest.occurred_at_utc || latest.occurred_at_local || latest.created_at)) || 0, time(journey.last_effective_contact_at) || 0);
    const reasons = [];
    const add = (kind, label, anchor, extra = {}) => {
      if (!reasonSuppressed(suppressions, journey.id, kind, latestEvent, nowMs)) reasons.push({ kind, label, anchor: anchor || nowMs, ...extra });
    };
    if (latest && latest.direction === 'CUSTOMER') {
      add('NO_RESPONSE', 'SEM RESPOSTA', time(latest.occurred_at_utc || latest.occurred_at_local || latest.created_at), { preview: clean(latest.body_text).slice(0, 180), channel: latest.channel });
    }
    if (journey.next_action_at) {
      const due = time(journey.next_action_at);
      add('NEXT_ACTION', due <= nowMs ? 'RETORNO VENCIDO' : 'RETORNO MARCADO', due, { dueAt: journey.next_action_at, detail: clean(journey.next_action_text) });
    }
    const missingSince = time(journey.next_action_missing_since);
    if (!journey.next_action_at && missingSince && nowMs - missingSince >= 2 * DAY_MS) add('MISSING_NEXT_ACTION', 'SEM PRÓXIMA AÇÃO', missingSince + 2 * DAY_MS);
    for (const item of divergences.filter((value) => value.journey_id === journey.id && value.status === 'OPEN')) add('DIVERGENCE', `DIVERGÊNCIA: ${item.field}`, time(item.created_at));
    for (const item of promises.filter((value) => value.journey_id === journey.id && value.status === 'OPEN')) add('PROMISE', (time(item.due_at) || 0) <= nowMs ? 'PROMESSA VENCIDA' : 'PROMESSA ABERTA', time(item.due_at || item.created_at), { dueAt: item.due_at, detail: clean(item.promise_text) });
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
      name: clean(journey.contact && journey.contact.display_name) || 'Contato sem nome',
      vehicleText: clean(journey.vehicle_text) || null,
      stage: journey.stage,
      status: journey.status,
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

module.exports = {
  DAY_MS, REF_RE, buildTodayItems, buildTodayOrderItems, calculatorEventStatus, checklistSummary, clean, clientOkPatch,
  consolidateCalcRuns, fold, journeyLogicalMode, logicalMode, nextStageForUnits,
  normalizeState, orderSearchMatches, searchMatches, shortDeadline, time
};

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

function logicalMode(row) {
  const data = row && row.dados && typeof row.dados === 'object' ? row.dados : {};
  const event = clean(data.evento).toLocaleLowerCase('pt-BR');
  const bid = Number(data.lance);
  if (event !== 'busca' && Number.isFinite(bid) && bid > 0) return 'CARRO';
  if (event === 'busca' || ['ano_de', 'ano_ate', 'milhas_de', 'milhas_ate'].some((key) => data[key] !== undefined && data[key] !== null && data[key] !== '')) return 'VALOR';
  return 'REVIEW';
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

function consolidateCalcRuns(rows, links = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const data = row && row.dados && typeof row.dados === 'object' ? row.dados : {};
    const mode = logicalMode(row);
    const sid = clean(data.sid);
    const ref = clean(data.ref).toUpperCase();
    if (mode === 'REVIEW' || !sid || !REF_RE.test(ref)) continue;
    const key = [sid, ref, mode].join('\u001f');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const linkMap = new Map((Array.isArray(links) ? links : []).map((link) => [[clean(link.calc_sid), clean(link.calc_ref).toUpperCase(), clean(link.logical_mode)].join('\u001f'), link]));
  return [...groups.entries()].map(([key, events]) => {
    const preferred = events.filter((row) => ['whatsapp', 'sms'].includes(clean(row.dados && row.dados.evento).toLocaleLowerCase('pt-BR')));
    const snapshot = (preferred.length ? preferred : events).slice().sort(newer).at(-1);
    const data = snapshot.dados || {};
    const [sid, ref, mode] = key.split('\u001f');
    const link = linkMap.get(key) || null;
    const vehicle = [data.ano_de && data.ano_ate && data.ano_de !== data.ano_ate ? `${data.ano_de}–${data.ano_ate}` : data.ano_de || data.ano_ate, data.marca, data.modelo, data.trim].filter(Boolean).join(' ');
    const bid = Number(data.lance);
    return {
      key, sid, ref, logicalMode: mode,
      eventCount: events.length,
      event: clean(data.evento),
      occurredAt: data.quando || snapshot.created_at || null,
      vehicleText: clean(vehicle) || null,
      budgetCents: Number.isFinite(bid) && bid > 0 ? Math.round(bid * 100) : null,
      paymentText: clean(data.pagamento || snapshot.pagamento) || null,
      deadlineText: clean(data.prazo) || null,
      state: clean(data.estado || snapshot.estado) || null,
      zip: clean(data.zip || snapshot.zip) || null,
      link: link ? { contactId: link.contact_id || null, journeyId: link.journey_id || null } : null
    };
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
  DAY_MS, REF_RE, buildTodayItems, checklistSummary, clean, clientOkPatch,
  consolidateCalcRuns, fold, logicalMode, nextStageForUnits, searchMatches,
  shortDeadline, time
};

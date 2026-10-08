'use strict';
const { dateFormatter } = require('./panel-date-format');

// Contexto do caso, igual em todas as abas: quem é o cliente, como falar com ele, de onde veio, o
// que ele informou (campo por campo, com a origem de cada valor), o que está confirmado, ausente,
// ambíguo ou só lido pela IA, as mensagens de onde os dados saíram, pedidos, pesquisas e carros
// ligados, a etapa, de quem depende, o que falta e a próxima ação.
//
// Só leitura: nada é gravado, nenhum cliente, pedido ou pesquisa é ligado por suposição. Um contato
// só vira um caso quando tem exatamente uma ficha; uma Ref ligada a mais de uma ficha fica sem
// dono e o contexto diz isso.
const { allRows, rows, rpc } = require('./panel-server');
const { clean, consolidateCalcRuns, fold, normalizeDeadline, time, wishlistsForJourney } = require('./panel-domain');
const { loadSearchStageIndex } = require('./panel-search-stage');
const groups = require('./panel-groups');
const { buildIndex, factsOf, UNAVAILABLE } = require('./panel-classification');
const orderSummary = require('./panel-order-summary');
const refProof = require('./panel-ref-proof');
const { loadVitrineOrigins } = require('./panel-vitrine-origin');
const { batchSupported, latestActiveUpload } = require('./panel-manheim-state');
const completing = require('./painel/completar-pedido');

const MAX_IDS = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[A-HJ-NP-Z2-9]{5}$/;

// What each state means on screen. Never an inference shown as something the client confirmed.
const STATUS = Object.freeze({
  CLIENTE: 'Informado pelo cliente',
  CONFIRMADO: 'Confirmado pela equipe',
  EQUIPE: 'Registrado pela equipe',
  IA: 'Lido pela IA · não confirmado',
  AMBIGUO: 'Ambíguo · fontes diferentes',
  AUSENTE: 'Não informado'
});
const SOURCE = Object.freeze({ CALCULADORA: 'Calculadora', FICHA: 'Ficha', CONVERSA_IA: 'Conversa (leitura da IA)' });
const JOURNEY_STAGES = Object.freeze({ NOVO: 'Novo', RESPONDIDO: 'Respondido', EM_BUSCA: 'Em busca', DECIDINDO: 'Decidindo', QUALIFICADO: 'Qualificado', AGUARDANDO_CLIENTE: 'Aguardando cliente', PARADO: 'Parado' });
const SEARCH_STAGES = Object.freeze({ MISSING: 'Busca não salva no Manheim', SAVED: 'Busca salva no Manheim', SENT: 'Opções enviadas', QUALIFY: 'Precisa qualificar' });
const MODES = Object.freeze({ VALOR: 'Por valor (lance máximo)', CARRO: 'Por carro (ano e milhagem)' });
const ORIGINS = Object.freeze({ WHATSAPP_DIRECT: 'Veio por mensagem · Via WhatsApp', SMS_DIRECT: 'Veio por mensagem · Via SMS', WHATSAPP: 'Veio por mensagem · Via WhatsApp', SMS: 'Veio por mensagem · Via SMS', CALCULATOR: 'Veio pela calculadora', CALCULADORA: 'Veio pela calculadora', IMPORT: 'Conversa importada', MANUAL: 'Cadastro manual' });
// Fields that decide whether a search can be made, per mode (the rules of vehicle-match stay the
// same; this only says which of the client's answers are still missing).
const REQUIRED = Object.freeze({ VALOR: ['carro', 'valor'], CARRO: ['carro', 'anos', 'milhas'] });
const REQUIRED_KEYS = new Set(['carro', 'anos', 'milhas', 'valor', 'teto']);
const FIELD_LABELS = Object.freeze({ tipo: 'Tipo de busca', carro: 'Carro', anos: 'Anos', milhas: 'Milhagem', valor: 'Lance máximo', teto: 'Teto total (tudo incluso)', pagamento: 'Pagamento', prazo: 'Prazo', local: 'Localização', placa: 'Placa', uso: 'Uso do carro' });
const EVIDENCE_FIELDS = Object.freeze({ carro: ['make', 'model', 'trim', 'type'], anos: ['year'], milhas: ['miles'], valor: ['budget'], local: ['location'] });

// Deadline codes stored by the calculator and the ficha, shown in words (the stored value is kept
// as it is, in the source's "raw").
const DEADLINE_LABELS = Object.freeze({ now: 'Imediatamente', '30d': 'Até 30 dias', '3m': '30 a 90 dias', none: 'Sem prazo definido', '6m': 'Até 6 meses', '12m': 'Até 12 meses' });
const deadlineLabel = (value) => { const code = normalizeDeadline(value); return code ? DEADLINE_LABELS[code] : clean(value) || null; };
const deadlineSource = (value) => clean(value) ? { raw: clean(value), compare: normalizeDeadline(value) || clean(value) } : {};
const usd = (cents) => Number.isFinite(cents) && cents > 0 ? 'US$ ' + Math.round(cents / 100).toLocaleString('en-US') : null;
const miles = (value) => Number(value).toLocaleString('en-US');
const range = (from, to, unit = '') => {
  const a = Number.isFinite(Number(from)) && from !== null && from !== '' ? Number(from) : null;
  const b = Number.isFinite(Number(to)) && to !== null && to !== '' ? Number(to) : null;
  if (a === null && b === null) return null;
  const fmt = (n) => unit ? miles(n) + unit : String(n);
  if (a !== null && b !== null) return a === b ? fmt(a) : `${fmt(a)} a ${fmt(b)}`;
  return a !== null ? `a partir de ${fmt(a)}` : `até ${fmt(b)}`;
};
const vehicleName = (w) => [w && w.make, w && w.model, w && w.trim].map(clean).filter(Boolean).join(' ') || null;
const inList = (values) => 'in.(' + values.map((value) => '"' + String(value).replaceAll('"', '') + '"').join(',') + ')';
const shortText = (text) => { const value = clean(text).replace(/\s+/g, ' '); return value.length > 160 ? value.slice(0, 157) + '…' : value; };
// Two values are the same answer when they read the same after folding case, accents and spaces.
const same = (a, b) => fold(a).replace(/[^a-z0-9]/g, '') === fold(b).replace(/[^a-z0-9]/g, '');

async function safe(promise, fallback) { try { return await promise; } catch (_) { return fallback; } }
async function inChunks(ctx, table, params, column, values, parallel = 1) {
  const out = [];
  for (let index = 0; index < values.length; index += 80 * parallel) {
    const pages = [];
    for (let part = index; part < Math.min(values.length, index + 80 * parallel); part += 80) {
      pages.push(allRows(ctx, table, { ...params, [column]: inList(values.slice(part, part + 80)) }));
    }
    // Promise.all keeps the original chunk order even if responses arrive out of order.
    out.push(...(await Promise.all(pages)).flat());
  }
  return out;
}

// ------------------------------------------------------------------ campos
// One field: every source that said something, the state and the value shown. R1: once the ficha
// has a value, it is the one the search uses; a different value from another source stays visible
// as a divergence. Without a ficha value, sources that disagree make the field ambiguous (nothing
// is picked for the team). A value only the AI read is never shown as something the client
// confirmed.
function field(key, sources, options = {}) {
  const found = sources.filter((source) => source && source.value);
  const comparable = (source) => source.compare || source.value;
  const agree = (a, b) => a.some((x) => b.some((y) => same(comparable(x), comparable(y))));
  const distinct = (list) => list.reduce((acc, source) => (acc.some((item) => same(comparable(item), comparable(source))) ? acc : acc.concat(source)), []);
  const confirmed = found.filter((source) => source.confirmed);
  const ficha = found.filter((source) => source.kind === 'FICHA' && !source.confirmed);
  const calc = found.filter((source) => source.kind === 'CALCULADORA');
  const ia = found.filter((source) => source.kind === 'CONVERSA_IA');
  const conflicts = !options.noConflict;
  let status = 'AUSENTE', chosen = [];
  if (confirmed.length) { status = 'CONFIRMADO'; chosen = confirmed; }
  else if (ficha.length) { status = calc.length && agree(ficha, calc) ? 'CLIENTE' : 'EQUIPE'; chosen = ficha; }
  else if (calc.length) {
    const iaCheck = ia.filter((source) => !source.noConflict);
    const clash = conflicts && ((!options.multi && distinct(calc).length > 1) || (iaCheck.length && !agree(calc, iaCheck)));
    status = clash ? 'AMBIGUO' : 'CLIENTE'; chosen = calc;
  } else if (ia.length) {
    const clash = conflicts && !options.multi && distinct(ia.filter((source) => !source.noConflict)).length > 1;
    status = clash ? 'AMBIGUO' : 'IA'; chosen = ia;
  }
  const shown = distinct(chosen);
  const value = status === 'AMBIGUO' || !shown.length ? null : options.multi ? shown.map((source) => source.value).join(' · ') : shown[0].value;
  // Sources that say something else than what is shown (a divergence the team should see).
  const divergent = status !== 'AMBIGUO' && conflicts ? found.filter((source) => !source.noConflict && !chosen.includes(source) && !chosen.some((item) => same(comparable(item), comparable(source)))) : [];
  const review = status === 'IA' && found.find((source) => source.needsReview);
  const note = options.note
    || (divergent.length ? 'Outra fonte diz diferente: ' + divergent.map((source) => (SOURCE[source.kind] || source.kind) + ' — ' + source.value).join('; ') + (ficha.length || confirmed.length ? '. A busca usa o valor da ficha.' : '.') : null)
    || (review ? 'A IA marcou para revisão: ' + (review.reviewReason || 'confiança baixa') : null)
    || (status === 'IA' && found.some((source) => source.detail) ? found.find((source) => source.detail).detail : null);
  return {
    key, label: FIELD_LABELS[key] || key, status, statusLabel: STATUS[status], value, divergent: divergent.length > 0, note,
    sources: found.map((source) => ({ kind: source.kind, label: source.confirmed ? 'Ficha (confirmado)' : SOURCE[source.kind] || source.kind, value: source.value, raw: source.raw || null, at: source.at || null, ref: source.ref || null, detail: source.detail || null, messages: source.messages || [] }))
  };
}

function calculatorSources(orders) {
  // One source per Ref and mode: what the client typed in the calculator.
  const of = (order, value, extra = {}) => value ? { kind: 'CALCULADORA', value, at: order.occurredAt, ref: order.ref, detail: MODES[order.logicalMode] || null, ...extra } : null;
  const out = { tipo: [], carro: [], anos: [], milhas: [], valor: [], pagamento: [], prazo: [], local: [], placa: [] };
  orders.forEach((order) => {
    const wishes = (order.wishlists || []).length ? order.wishlists : [order.wishlist || {}];
    const wish = wishes[0] || {};
    out.tipo.push(of(order, MODES[order.logicalMode] || null));
    wishes.forEach((item) => out.carro.push(of(order, vehicleName(item), { compare: [item.make, item.model].filter(Boolean).join(' ') || null })));
    if (!wishes.some(vehicleName) && (order.vehicles || [])[0]) out.carro.push(of(order, order.vehicles[0]));
    if (order.logicalMode === 'CARRO') {
      out.anos.push(of(order, range(wish.yearMin, wish.yearMax)));
      out.milhas.push(of(order, range(wish.minMiles, wish.maxMiles, ' mi')));
    }
    if (order.logicalMode === 'VALOR') out.valor.push(of(order, usd(order.budgetCents)));
    out.pagamento.push(of(order, order.paymentText));
    out.prazo.push(of(order, deadlineLabel(order.deadlineText), deadlineSource(order.deadlineText)));
    out.local.push(of(order, [order.state, order.zip && 'ZIP ' + order.zip].filter(Boolean).join(' · ') || null, { compare: order.state || null }));
    out.placa.push(of(order, order.plate ? ({ nova: 'Placa nova', transferir: 'Transferir placa' })[fold(order.plate)] || order.plate : null));
  });
  return out;
}

function fichaSources(journey, contact, modes) {
  const of = (value, extra = {}) => value ? { kind: 'FICHA', value, at: journey.updated_at || null, ...extra } : null;
  const wishes = wishlistsForJourney(journey);
  const wish = wishes[0] || {};
  return {
    tipo: modes.map((mode) => of(MODES[mode])),
    carro: wishes.length ? wishes.map((item) => of(vehicleName(item), { compare: [item.make, item.model].filter(Boolean).join(' ') || null })) : [of(clean(journey.vehicle_text) || null)],
    anos: [of(range(wish.yearMin, wish.yearMax))],
    milhas: [of(range(wish.minMiles, wish.maxMiles, ' mi'))],
    valor: [of(usd(Number(journey.budget_cents)))],
    teto: [of(usd(Number(journey.confirmed_total_ceiling_cents)), { confirmed: true })],
    pagamento: [of(clean(journey.payment_text) || null)],
    prazo: [of(deadlineLabel(journey.customer_deadline_text), deadlineSource(journey.customer_deadline_text))],
    local: [of(clean(contact && contact.location_text) || null)]
  };
}

function conversationSources(requests, messagesById) {
  const out = { carro: [], anos: [], milhas: [], valor: [], local: [] };
  requests.forEach((request) => {
    const c = request.criteria || {};
    const evidence = request.evidence || {};
    const messagesFor = (key) => [...new Set((EVIDENCE_FIELDS[key] || []).flatMap((name) => Array.isArray(evidence[name]) ? evidence[name] : []))]
      .map((id) => messagesById.get(String(id))).filter(Boolean).map((message) => ({ id: message.id, at: message.occurred_at_utc || message.created_at || null, text: shortText(message.body_text) }));
    const of = (key, value, extra = {}) => value ? { kind: 'CONVERSA_IA', value, at: request.at, needsReview: request.needsReview, reviewReason: request.reviewReason, messages: messagesFor(key), ...extra } : null;
    out.carro.push(of('carro', vehicleName(c), { compare: [c.make, c.model].filter(Boolean).join(' ') || null }));
    out.anos.push(of('anos', range(c.yearMin, c.yearMax)));
    out.milhas.push(of('milhas', range(c.minMiles, c.maxMiles, ' mi')));
    out.valor.push(of('valor', c.budgetUsd ? 'US$ ' + Number(c.budgetUsd).toLocaleString('en-US') : null, { detail: 'Valor citado na conversa: pode ser o total ou o lance', noConflict: true }));
    out.local.push(of('local', clean(c.location) || null));
  });
  return out;
}

// "Campo a campo", one block per car: every car the client gave (calculator, ficha, conversation), each with its own
// years and mileage, judged by the same rule as the fields. Only cars, never the client's own fields.
function carEntries({ orders = [], journey = null, requests = [] }) {
  const out = [];
  const push = (kind, item, extra) => { const car = vehicleName(item); if (!car) return; out.push({ kind, car, compare: [item.make, item.model].filter(Boolean).join(' ') || car, anos: range(item.yearMin, item.yearMax), milhas: range(item.minMiles, item.maxMiles, ' mi'), ...extra }); };
  orders.forEach((order) => {
    const wishes = (order.wishlists || []).length ? order.wishlists : [order.wishlist || {}];
    const carMode = order.logicalMode === 'CARRO';
    wishes.forEach((item) => push('CALCULADORA', carMode ? item : { make: item.make, model: item.model, trim: item.trim }, { at: order.occurredAt, ref: order.ref }));
  });
  if (journey) wishlistsForJourney(journey).forEach((item) => push('FICHA', item, { at: journey.updated_at || null }));
  requests.forEach((request) => push('CONVERSA_IA', request.criteria || {}, { at: request.at, needsReview: request.needsReview, reviewReason: request.reviewReason }));
  return out;
}
function carBlocks(entries) {
  const groups = [];
  entries.forEach((entry) => { const group = groups.find((item) => same(item.key, entry.compare)); if (group) group.entries.push(entry); else groups.push({ key: entry.compare, entries: [entry] }); });
  if (groups.length < 2) return [];
  return groups.map((group) => {
    const of = (value, entry) => value ? { ...entry, value } : null;
    return {
      carro: field('carro', group.entries.map((entry) => of(entry.car, entry))),
      anos: field('anos', group.entries.map((entry) => of(entry.anos, { ...entry, compare: null }))),
      milhas: field('milhas', group.entries.map((entry) => of(entry.milhas, { ...entry, compare: null })))
    };
  });
}

const FIELD_OPTIONS = { tipo: { multi: true, noConflict: true }, carro: { multi: true }, local: { noConflict: true } };
function buildFields(parts) {
  const merged = (key) => parts.flatMap((part) => part[key] || []);
  const fields = ['tipo', 'carro', 'anos', 'milhas', 'valor', 'teto', 'pagamento', 'prazo', 'local', 'placa'].map((key) => field(key, merged(key), FIELD_OPTIONS[key]));
  // No screen, form or reading collects how the car will be used: said as it is.
  fields.push({ key: 'uso', label: FIELD_LABELS.uso, status: 'AUSENTE', statusLabel: 'Não coletado', value: null, divergent: false, note: 'O painel não tem campo para o uso do carro: fica só na conversa, se o cliente contou.', sources: [] });
  return fields;
}

// ------------------------------------------------------------------ situação
function conversationState(messages) {
  const real = messages.filter((message) => !message.is_automatic && ['CUSTOMER', 'MCS'].includes(message.direction))
    .sort((a, b) => (time(a.occurred_at_utc || a.created_at) || 0) - (time(b.occurred_at_utc || b.created_at) || 0));
  const last = real.at(-1) || null;
  const lastCustomer = real.filter((message) => message.direction === 'CUSTOMER').at(-1) || null;
  return {
    messageCount: real.length,
    lastAt: last ? last.occurred_at_utc || last.created_at : null,
    lastFrom: last ? last.direction : null,
    lastCustomerAt: lastCustomer ? lastCustomer.occurred_at_utc || lastCustomer.created_at : null,
    firstAt: real[0] ? real[0].occurred_at_utc || real[0].created_at : null
  };
}

function waitingOn({ closed, conversation, hasCalculator }) {
  if (closed) return { who: 'NINGUEM', label: 'Ninguém', text: 'Caso encerrado.' };
  if (conversation.lastFrom === 'CUSTOMER') return { who: 'MCS', label: 'MCS', text: 'O cliente escreveu por último. A resposta da MCS está pendente.', since: conversation.lastAt };
  if (conversation.lastFrom === 'MCS') return { who: 'CLIENTE', label: 'Cliente', text: 'A MCS escreveu por último. Aguardando o cliente.', since: conversation.lastAt };
  if (hasCalculator) return { who: 'MCS', label: 'MCS', text: 'Só há o pedido da calculadora, sem conversa ligada.' };
  return { who: 'MCS', label: 'MCS', text: 'Nenhuma mensagem ligada a este caso.' };
}

// What blocks the case and the next step. A step the team defined always comes first; otherwise
// the panel suggests one, marked as a suggestion. Something already answered in any source is
// never asked again: a value only read by the AI is to be checked in the conversation, not asked;
// and while the conversation was never read by the AI, a missing answer may still be in it.
// An order without a ficha is never "free to search": its criteria may be complete, but the case
// waits for the link to a ficha (the client asked for contact) or for the client (only simulated).
const UNLINKED = Object.freeze({
  // Simulated or only clicked WhatsApp/SMS: no message from the client is linked to the order.
  AWAITING: { label: 'Aguardando contato do cliente', detail: 'Simulou ou só clicou em WhatsApp/SMS: nenhuma mensagem do cliente ligada a este pedido.', blocker: 'O cliente ainda não entrou em contato: nenhuma mensagem ligada ao pedido e a calculadora não guarda telefone.', action: 'Se a conversa do cliente chegou sem a Ref, ligar o pedido à ficha (ENTRADA › Ligar a um lead); se não, aguardar o contato', owner: { who: 'CLIENTE', label: 'Cliente', text: 'Aguardando o cliente mandar mensagem.' } },
  // A conversation exists and its link to this order is not confirmed yet (a pending link suggestion).
  PENDING_LINK: { label: 'Vínculo pendente', detail: 'Há uma conversa que pode ser deste pedido; o vínculo ainda não foi confirmado.', blocker: 'Vínculo pendente: a conversa ainda não foi confirmada como deste pedido.', action: 'Conferir a sugestão de vínculo e ligar o pedido à ficha certa', owner: { who: 'MCS', label: 'MCS', text: 'A MCS precisa confirmar a qual conversa este pedido pertence.' } },
  AMBIGUOUS: { label: 'Ref ligada a mais de uma ficha', detail: 'A mesma Ref está em mais de uma ficha.', blocker: 'A Ref está ligada a mais de uma ficha: o painel não escolhe uma.', action: 'Conferir a qual ficha esta Ref pertence', owner: { who: 'MCS', label: 'MCS', text: 'A MCS precisa decidir a qual ficha a Ref pertence.' } }
});
// The search criteria alone (complete or what is missing), apart from where the case stands.
function criteriaSummary(step) {
  if (step.missing.length) return { complete: false, text: 'Faltam: ' + step.missing.join(', ') };
  if (step.ambiguous.length) return { complete: false, text: 'Fontes diferentes: ' + step.ambiguous.join(', ') };
  if (step.aiOnly.length) return { complete: false, text: 'Conferir o que a IA leu: ' + step.aiOnly.join(', ') };
  return { complete: true, text: 'Completos' };
}
// The day a V1 went out, as the team reads it (Florida).
const sentDay = (iso) => { const stamp = time(iso); return stamp ? dateFormatter('pt-BR', { timeZone: 'America/New_York', day: '2-digit', month: '2-digit' }).format(new Date(stamp)) : null; };
function nextStep({ journey = null, closed = false, off = false, owner, fields, modes = [], searches = [], unlinkedRef = null, conversationCount = 0, conversationRead = false, sharedRefs = [], v1 = null }) {
  const byKey = new Map(fields.map((item) => [item.key, item]));
  const needed = [...new Set(modes.flatMap((mode) => REQUIRED[mode] || []))];
  const absent = (key) => (byKey.get(key) || {}).status === 'AUSENTE';
  const missing = modes.length ? needed.filter(absent).map((key) => FIELD_LABELS[key]) : ['Tipo de busca (por valor ou por carro)', ...(absent('carro') ? [FIELD_LABELS.carro] : [])];
  const aiOnly = needed.filter((key) => (byKey.get(key) || {}).status === 'IA').map((key) => FIELD_LABELS[key]);
  // Sources disagreeing on a field the search type does not use (years in POR VALOR, bid in POR CARRO) block nothing.
  const ambiguous = fields.filter((item) => item.status === 'AMBIGUO' && (!modes.length || needed.includes(item.key) || !REQUIRED_KEYS.has(item.key))).map((item) => item.label);
  const defined = journey && clean(journey.next_action_text) ? { kind: 'EQUIPE', label: 'Definida pela equipe', text: clean(journey.next_action_text), at: journey.next_action_at || null, overdue: Boolean(journey.next_action_at && time(journey.next_action_at) < Date.now()) } : null;
  const byStage = (stage) => searches.filter((item) => item.stage === stage);
  const modeNames = (list) => list.map((item) => item.mode === 'VALOR' ? 'por valor' : 'por carro').join(' e ');
  let blocker = null, suggestion;
  if (unlinkedRef) { const situation = UNLINKED[unlinkedRef] || UNLINKED.AWAITING; blocker = situation.blocker; suggestion = situation.action; }
  else if (closed) suggestion = 'Nada a fazer: caso encerrado';
  else if (off) { blocker = 'O caso está desligado.'; suggestion = 'Religar o caso na ficha, se o cliente voltar'; }
  // A Ref shared with another ficha: the identity comes first, before answering with this context.
  else if (sharedRefs.length) { blocker = `A Ref ${sharedRefs.join(', ')} também está em outra ficha: o painel não sabe de quem é este pedido.`; suggestion = `Resolver a identidade: conferir a qual ficha a Ref ${sharedRefs.join(', ')} pertence antes de responder`; }
  else if (owner.who === 'MCS' && owner.since) { blocker = 'O cliente escreveu e ainda não teve resposta.'; suggestion = 'Responder o cliente'; }
  else if (missing.length) {
    blocker = 'Falta informação para buscar: ' + missing.join(', ') + '.';
    // MESA: the type is the team's reading of the conversation, never a choice handed to the client;
    // with two types, what is missing is said per type (never year, mileage and bid as one question).
    const ask = !modes.length
      ? 'Descobrir pela conversa se a busca é por valor (lance máximo) ou por carro (ano e milhagem)' + (absent('carro') ? ' e qual é o carro' : '')
      : modes.length > 1 ? modes.map((mode) => ({ mode, list: (REQUIRED[mode] || []).filter(absent).map((key) => FIELD_LABELS[key]) })).filter((item) => item.list.length).map((item) => (item.mode === 'CARRO' ? 'por carro: ' : 'por valor: ') + item.list.join(', ')).join(' · ')
      : missing.join(', ');
    suggestion = !modes.length ? ask : conversationCount && !conversationRead ? 'Ver na conversa se o cliente já respondeu; se não, perguntar: ' + ask : 'Perguntar ao cliente: ' + ask;
  }
  else if (ambiguous.length) { blocker = 'As fontes dizem coisas diferentes: ' + ambiguous.join(', ') + '.'; suggestion = 'Conferir no histórico qual valor vale e registrar na ficha: ' + ambiguous.join(', '); }
  else if (aiOnly.length) { blocker = 'Dados lidos só pela IA, sem conferência: ' + aiOnly.join(', ') + '.'; suggestion = 'Conferir na conversa e registrar na ficha: ' + aiOnly.join(', '); }
  else if (byStage('QUALIFY').length) { blocker = 'O pedido ainda não tem o que a busca precisa.'; suggestion = 'Revisar o pedido na ficha (tipo de busca e carro)'; }
  else if (byStage('MISSING').length) { blocker = 'A busca ainda não foi salva no Manheim.'; suggestion = 'Salvar a busca ' + modeNames(byStage('MISSING')) + ' no Manheim'; }
  else if (byStage('SAVED').some((item) => item.cars > 0)) { const total = byStage('SAVED').reduce((sum, item) => sum + (item.cars || 0), 0); suggestion = `Escolher carros do lote ativo (${total}) e gerar o link V1`; }
  else if (byStage('SAVED').length) { blocker = 'Nenhum carro do lote ativo atende ao pedido.'; suggestion = 'Aguardar o próximo CSV do Manheim'; }
  // A V1 already sent is never generated again: the next step is the client's answer to it.
  else if (v1 && v1.at) { const day = sentDay(v1.at); const sent = (v1.status === 'UNCONFIRMED' ? 'V1 enviada (sem confirmação do WhatsApp)' : 'V1 enviada') + (day ? ' em ' + day : ''); suggestion = sent + ': ' + (owner.who === 'CLIENTE' ? 'acompanhar a resposta do cliente aos carros da V1' : 'seguir a conversa sobre os carros da V1'); }
  else if (byStage('SENT').length) suggestion = owner.who === 'CLIENTE' ? 'Acompanhar a resposta do cliente às opções enviadas' : 'Seguir a conversa sobre as opções enviadas';
  else suggestion = 'Definir o próximo passo na ficha';
  return { missing, aiOnly, ambiguous, blocker, action: defined || { kind: 'SUGESTAO', label: 'Sugestão do painel', text: suggestion, at: null, overdue: false } };
}

// ------------------------------------------------------------------ leitura
function normalizedInput(input) {
  const uuids = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((id) => UUID.test(id)))].slice(0, MAX_IDS);
  return {
    journeyIds: uuids(input.journeyIds),
    contactIds: uuids(input.contactIds),
    refs: [...new Set((Array.isArray(input.refs) ? input.refs : []).map((ref) => clean(ref).toUpperCase()).filter((ref) => REF.test(ref)))].slice(0, MAX_IDS)
  };
}

const JOURNEY_COLUMNS = 'id,contact_id,reference_code,source,status,stage,vehicle_text,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,criteria_json,next_action_text,next_action_at,next_action_set_at,last_effective_contact_at,created_at,updated_at,closed_at,closed_reason';
function prepareListContexts(ctx) {
  const environment='eq.'+ctx.environment;
  // These exact sources are needed by the complete queue's identities. Start their
  // projections with the opening reads, without changing any identity calculation.
  const sources=[
    ['journeys',JOURNEY_COLUMNS],
    ['contacts','id,display_name,location_text,source,created_at'],
    ['contact_phones','contact_id,phone_e164,is_primary,is_current,retired_at'],
    ['journey_refs','journey_id,ref_code'],
    ['message_journeys','journey_id,message_id',{undone_at:'is.null'}],
    ['journey_toggle_states','journey_id,enabled,switched_at'],
    ['panel_identity_state','journey_id,status,calc_origin,refs,conflict'],
    ['panel_conversation_class','journey_id,subject,manual_subject,classified_at,reason,request_summaries'],
    ['messages','id,direction,body_text,is_automatic,is_edit_marker,is_delete_marker,original_order,occurred_at_utc,created_at,channel,source_kind,undone_at']
  ];
  // A failed optional projection retains the existing per-source fallback later.
  return Promise.allSettled(sources.map(([table,select,filters])=>allRows(ctx,table,{select,environment,...filters})));
}

async function loadJourneys(ctx, input) {
  const env = 'eq.' + ctx.environment;
  const read = (column, values) => values.length ? inChunks(ctx, 'journeys', { select: JOURNEY_COLUMNS, environment: env }, column, values) : [];
  const [byId, byContact, byRefCode, refRows] = await Promise.all([
    read('id', input.journeyIds), read('contact_id', input.contactIds), read('reference_code', input.refs),
    input.refs.length ? inChunks(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env }, 'ref_code', input.refs) : []
  ]);
  const known = new Set([...byId, ...byContact, ...byRefCode].map((journey) => journey.id));
  const byRefLink = await read('id', [...new Set(refRows.map((row) => row.journey_id))].filter((id) => !known.has(id)));
  return [...new Map([...byId, ...byContact, ...byRefCode, ...byRefLink].map((journey) => [journey.id, journey])).values()];
}

// Cars of the active batch per person, counted by the database (never the cars themselves).
async function batchCars(ctx) {
  const out = { byJourney: new Map(), byJourneyMode: new Map(), byRef: new Map(), upload: null };
  if (!(await batchSupported(ctx, { rows }).catch(() => false))) return out;
  const upload = await latestActiveUpload(ctx, 'id,uploaded_at,activated_at');
  if (!upload) return out;
  out.upload = upload;
  (await rpc(ctx, 'panel_manheim_batch_people', { p_environment: ctx.environment, p_upload_id: upload.id }) || []).forEach((row) => {
    const count = Number(row.vehicle_count) || 0;
    if (row.journey_id && !row.logical_mode) out.byJourney.set(row.journey_id, count);
    else if (row.journey_id) out.byJourneyMode.set(row.journey_id + ':' + row.logical_mode, count);
    else if (row.calc_ref && !row.logical_mode) out.byRef.set(clean(row.calc_ref).toUpperCase(), count);
  });
  return out;
}

// The search stage reads the whole environment; the cards of one screen come in a few requests in
// a row, so one reading serves them for a few seconds (the stage itself is never changed here).
const STAGE_MEMO_MS = 15 * 1000;
const stageMemo = new Map();
async function stageIndexFor(ctx, loader, journeyIds = []) {
  const key = ctx.environment + '|' + String(ctx.config && ctx.config.url || '') + '|' + journeyIds.slice().sort().join(',');
  const hit = stageMemo.get(key);
  if (hit && Date.now() - hit.at < STAGE_MEMO_MS) return hit.value;
  const value = await loader(ctx, { journeyIds });
  stageMemo.set(key, { at: Date.now(), value });
  return value;
}

const messageAt = (message) => message.occurred_at_utc || message.created_at || null;

async function buildContexts(ctx, rawInput = {}, services = {}) {
  const input = normalizedInput(rawInput);
  const listOnly = services.listOnly === true;
  const env = 'eq.' + ctx.environment;
  const journeys = await loadJourneys(ctx, input);
  const ids = journeys.map((journey) => journey.id);
  const contactIds = [...new Set(journeys.map((journey) => journey.contact_id).concat(input.contactIds).filter(Boolean))];
  const [contacts, phones, userIds, journeyRefs, links, promises, toggles, insights, identityRows, classRows] = await Promise.all([
    contactIds.length ? inChunks(ctx, 'contacts', { select: 'id,display_name,location_text,source,created_at', environment: env }, 'id', contactIds) : [],
    contactIds.length ? inChunks(ctx, 'contact_phones', { select: 'contact_id,phone_e164,is_primary,is_current,retired_at', environment: env }, 'contact_id', contactIds) : [],
    !listOnly && contactIds.length ? inChunks(ctx, 'whatsapp_user_ids', { select: 'contact_id,username', environment: env }, 'contact_id', contactIds) : [],
    ids.length ? inChunks(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env }, 'journey_id', ids) : [],
    ids.length ? inChunks(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null' }, 'journey_id', ids) : [],
    !listOnly && ids.length ? inChunks(ctx, 'promises', { select: 'journey_id,promise_text,due_at,status', environment: env, status: 'eq.OPEN' }, 'journey_id', ids) : [],
    ids.length ? inChunks(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,switched_at', environment: env }, 'journey_id', ids) : [],
    !listOnly && ids.length ? safe(inChunks(ctx, 'conversation_pending_insights', { select: 'journey_id,summary_text,next_step_text,last_ai_message_id,updated_at', environment: env }, 'journey_id', ids), []) : [],
    ids.length ? safe(inChunks(ctx, 'panel_identity_state', { select: 'journey_id,status,calc_origin,refs,conflict', environment: env }, 'journey_id', ids), null) : [],
    ids.length ? safe(inChunks(ctx, 'panel_conversation_class', { select: 'journey_id,subject,manual_subject,classified_at,reason,request_summaries', environment: env }, 'journey_id', ids), null) : []
  ]);
  // The same identity and subject the lists use; a source that cannot be read is unavailable, never "not identified".
  const classification = identityRows && classRows ? buildIndex(identityRows, classRows) : UNAVAILABLE;
  const refsOf = (journey) => [...new Set([journey.reference_code, ...journeyRefs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code)].map((ref) => clean(ref).toUpperCase()).filter((ref) => REF.test(ref)))];
  const allRefs = [...new Set(journeys.flatMap(refsOf).concat(input.refs))];
  const messageIds = [...new Set(links.map((row) => row.message_id))];
  // Independent sources start together. Their failures retain the same per-source behavior.
  const [calcRuns, calcLinks, ownerCodes, ownerLinks, messages, vitrineOrigins] = await Promise.all([
    allRefs.length ? inChunks(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test' }, 'dados->>ref', allRefs) : [],
    allRefs.length ? inChunks(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: env }, 'calc_ref', allRefs) : [],
    allRefs.length ? inChunks(ctx, 'journeys', { select: 'id,reference_code', environment: env }, 'reference_code', allRefs) : [],
    allRefs.length ? inChunks(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env }, 'ref_code', allRefs) : [],
    messageIds.length ? inChunks(ctx, 'messages', { select: 'id,direction,body_text,is_automatic,is_edit_marker,is_delete_marker,original_order,occurred_at_utc,created_at,channel,source_kind,undone_at', environment: env }, 'id', messageIds, listOnly ? 4 : 1) : [],
    loadVitrineOrigins(ctx).catch(() => null)
  ]);
  const orders = consolidateCalcRuns(calcRuns, calcLinks);
  // Ref ownership is checked throughout the environment, including fichas outside this request.
  const ownersByRef = new Map();
  [...ownerCodes.map((row) => [row.reference_code, row.id]), ...ownerLinks.map((row) => [row.ref_code, row.journey_id])].forEach(([ref, owner]) => {
    const key = clean(ref).toUpperCase();
    if (!ownersByRef.has(key)) ownersByRef.set(key, new Set());
    ownersByRef.get(key).add(owner);
  });
  const messageById = new Map(messages.filter((message) => !message.undone_at).map((message) => [message.id, message]));
  // Requests read from the conversation belong to the contact: the ficha link is never stored, so
  // they only count for a contact with exactly one ficha.
  const requests = !listOnly && contactIds.length ? await inChunks(ctx, 'vehicle_requests', { select: 'id,contact_id,chat_id,updated_at', environment: env }, 'contact_id', contactIds) : [];
  const versions = requests.length ? await inChunks(ctx, 'vehicle_request_versions', { select: 'request_id,criteria_json,evidence_json,missing_fields,confidence,needs_review,review_reason,created_at', environment: env, order: 'created_at.asc' }, 'request_id', requests.map((row) => row.id)) : [];
  const latestVersion = new Map();
  versions.forEach((version) => latestVersion.set(version.request_id, version));
  const evidenceIds = [...new Set([...latestVersion.values()].flatMap((version) => Object.values(version.evidence_json || {}).flat()).map(String).filter((id) => UUID.test(id)))];
  const evidenceMessages = evidenceIds.length ? await inChunks(ctx, 'messages', { select: 'id,body_text,occurred_at_utc,created_at,direction', environment: env }, 'id', evidenceIds) : [];
  const evidenceById = new Map(evidenceMessages.map((message) => [String(message.id), message]));
  // The V1 sent by the panel (confirmed or not confirmed by the WhatsApp): the latest per ficha.
  const v1Sends = !listOnly && ids.length ? await safe(inChunks(ctx, 'v1_sends', { select: 'journey_id,origin,status,simulated,created_at,updated_at', environment: env, status: 'in.(SENT,UNCONFIRMED)', order: 'created_at.desc' }, 'journey_id', ids), []) : [];
  const stageIndex = !listOnly && ids.length ? await safe(stageIndexFor(ctx, services.loadSearchStageIndex || loadSearchStageIndex, ids), new Map()) : new Map();
  const emptyCars = { byJourney: new Map(), byJourneyMode: new Map(), byRef: new Map(), upload: null };
  const cars = listOnly ? emptyCars : await safe(batchCars(ctx), emptyCars);
  const uploadAt = cars.upload ? cars.upload.activated_at || cars.upload.uploaded_at : null;

  const contactById = new Map(contacts.map((contact) => [contact.id, contact]));
  const journeysOfContact = (contactId) => journeys.filter((journey) => journey.contact_id === contactId);
  const ownerIds = (ref) => [...(ownersByRef.get(ref) || new Set())];
  const journeysForRef = (ref) => ownerIds(ref).map((owner) => journeys.find((journey) => journey.id === owner) || { id: owner });
  const orderLink = (order) => ({ ref: order.ref, mode: order.logicalMode, modeLabel: MODES[order.logicalMode] || order.logicalMode, at: order.occurredAt, vehicle: order.vehicleText || null, name: order.contactName || null });
  const out = { journeys: {}, refs: {}, contacts: {}, generatedAt: new Date().toISOString(), batch: cars.upload ? { id: cars.upload.id, at: uploadAt } : null };

  journeys.forEach((journey) => {
    const contact = contactById.get(journey.contact_id) || null;
    const own = refsOf(journey);
    // A Ref shared with another ficha is not this ficha's order: said, never guessed.
    const ownOrders = orders.filter((order) => own.includes(order.ref) && journeysForRef(order.ref).length === 1);
    const sharedRefs = own.filter((ref) => journeysForRef(ref).length > 1);
    const stage = stageIndex.get(journey.id) || null;
    const criteriaModes = Array.isArray(journey.criteria_json && journey.criteria_json.logical_modes) ? journey.criteria_json.logical_modes : [];
    const modes = [...new Set([...Object.keys((stage && stage.modes) || {}), ...criteriaModes, ...ownOrders.map((order) => order.logicalMode)].filter((mode) => REQUIRED[mode]))];
    const single = journeysOfContact(journey.contact_id).length === 1;
    const ownRequests = single ? requests.filter((row) => row.contact_id === journey.contact_id).map((row) => {
      const version = latestVersion.get(row.id) || {};
      return { id: row.id, chatId: row.chat_id, criteria: version.criteria_json || {}, evidence: version.evidence_json || {}, needsReview: Boolean(version.needs_review), reviewReason: version.review_reason || null, missing: version.missing_fields || [], at: version.created_at || row.updated_at || null };
    }).filter((row) => Object.keys(row.criteria).length) : [];
    const journeyMessages = links.filter((row) => row.journey_id === journey.id).map((row) => messageById.get(row.message_id)).filter(Boolean);
    // Identity: a Ref the client wrote in the calculator message is a Ref even without calc_runs.
    const proof = refProof.proofFor({ journey, linkedRefs: own, runRefs: refProof.runRefsOf(calcRuns),
      explicit: journeyMessages.filter((message) => message.direction === 'CUSTOMER').flatMap((message) => refProof.explicitRefs(message.body_text).map((ref) => ({ ref, mode: refProof.messageMode(message.body_text), at: message.occurred_at_utc || message.created_at || null }))) });
    proof.messageModes.forEach((mode) => { if (REQUIRED[mode] && !modes.includes(mode)) modes.push(mode); });
    const fields = listOnly ? [] : buildFields([calculatorSources(ownOrders), fichaSources(journey, contact, modes), conversationSources(ownRequests, evidenceById)]);
    const conversation = conversationState(journeyMessages);
    const groupFacts = groups.factsFor({ calcProof: proof, messages: journeyMessages, orders: ownOrders, journey: { ...journey, enabled: toggles.find((row) => row.journey_id === journey.id)?.enabled, switchedAt: toggles.find((row) => row.journey_id === journey.id)?.switched_at || null },
      vitrine: vitrineOrigins ? vitrineOrigins.forPerson({ journeyId: journey.id, contactId: journey.contact_id }) : null, template: journeyMessages.some((message) => message.direction === 'CUSTOMER' && refProof.isCalculatorTemplate(message.body_text)), ...factsOf(classification, journey.id) });
    const grouped = groups.classify(groupFacts);
    // The list reads this exact identity from the full context too. Keep proof, global Ref
    // ownership, message selection and classification shared; only ficha details are deferred.
    const phoneList = phones.filter((row) => row.contact_id === journey.contact_id && row.is_current !== false && !row.retired_at).sort((a, b) => Number(b.is_primary) - Number(a.is_primary)).map((row) => row.phone_e164).filter(Boolean);
    const identity = {
      calcRef: proof.calcRef, hasCalcRef: proof.hasCalcRef, refState: grouped.refState, internalCode: proof.internalCode,
      name: clean(contact && contact.display_name) || null,
      listMessage: completing.lastMessage(journeyMessages),
      refAt: (() => { const at = Math.min(...ownOrders.flatMap((order) => order.simulations || [order]).map((simulation) => time(simulation.occurredAt) || Infinity)); return Number.isFinite(at) ? new Date(at).toISOString() : null; })(),
      contact: { phones: phoneList, location: clean(contact && contact.location_text) || null },
      origin: { code: grouped.origin.key, label: grouped.origin.label, financing: grouped.origin.financing },
      conversation: { lastAt: conversation.lastAt }
    };
    if (listOnly) { out.journeys[journey.id] = identity; return; }

    const closed = journey.status === 'ENCERRADO';
    const toggle = toggles.find((row) => row.journey_id === journey.id);
    const off = !closed && Boolean(toggle && toggle.enabled === false);
    const owner = waitingOn({ closed, conversation, hasCalculator: ownOrders.length > 0 || proof.hasCalcRef });
    const searches = stage && stage.modes && Object.keys(stage.modes).length
      ? Object.values(stage.modes).map((item) => ({ mode: item.mode, modeLabel: MODES[item.mode], stage: item.stage, label: SEARCH_STAGES[item.stage], at: item.at || null, cars: cars.byJourneyMode.get(journey.id + ':' + item.mode) || 0 }))
      : [];
    // A V1 sent marks its mode as "options sent" even when the stage was read before the send (the
    // stage reading is kept for a few seconds) or the send came before this rule existed.
    const ownSends = v1Sends.filter((row) => row.journey_id === journey.id).sort((a, b) => (time(b.updated_at || b.created_at) || 0) - (time(a.updated_at || a.created_at) || 0));
    searches.forEach((item) => {
      const sent = ownSends.find((row) => !row.origin || row.origin === item.mode);
      if (sent && item.stage !== 'SENT') Object.assign(item, { stage: 'SENT', label: SEARCH_STAGES.SENT, at: sent.updated_at || sent.created_at });
    });
    const v1 = ownSends[0] ? { at: ownSends[0].updated_at || ownSends[0].created_at, status: ownSends[0].status, mode: ownSends[0].origin || null, simulated: ownSends[0].simulated === true } : null;
    if (stage && stage.review && stage.review.length) searches.push({ mode: null, modeLabel: null, stage: 'QUALIFY', label: SEARCH_STAGES.QUALIFY, at: stage.at || null, cars: 0, issues: stage.review.flatMap((item) => item.issues || []) });
    if (!searches.length && stage && stage.basis === 'QUALIFY') searches.push({ mode: null, modeLabel: null, stage: 'QUALIFY', label: SEARCH_STAGES.QUALIFY, at: stage.at || null, cars: 0, issues: (stage.review || []).flatMap((item) => item.issues || []) });
    const carCount = cars.byJourney.get(journey.id) || 0;
    // The AI reading of the conversation counts only while it read the latest message.
    const latestMessage = journeyMessages.slice().sort((a, b) => (time(messageAt(b)) || 0) - (time(messageAt(a)) || 0))[0];
    const insight = insights.find((row) => row.journey_id === journey.id && latestMessage && row.last_ai_message_id === latestMessage.id) || null;
    const step = nextStep({ journey, closed, off, owner, fields, modes, searches, conversationCount: conversation.messageCount, conversationRead: ownRequests.length > 0 || Boolean(insight), sharedRefs, v1 });
    out.journeys[journey.id] = {
      key: 'journey:' + journey.id, journeyId: journey.id, contactId: journey.contact_id,
      ref: clean(journey.reference_code).toUpperCase() || own[0] || null, refs: own, sharedRefs,
      calcRef: proof.calcRef, calcRefs: proof.calcRefs, hasCalcRef: proof.hasCalcRef, refState: grouped.refState, calcRefsWithoutRun: proof.calcRefsWithoutRun, internalCode: proof.internalCode,
      name: identity.name,
      // Used only by the incomplete rows in TODOS; the existing context and group rules stay intact.
      listMessage: identity.listMessage,
      refAt: identity.refAt,
      contact: { phones: phoneList, whatsappUsername: (userIds.find((row) => row.contact_id === journey.contact_id) || {}).username || null, location: clean(contact && contact.location_text) || null, note: phoneList.length ? null : 'Nenhum telefone salvo neste contato.' },
      origin: { code: grouped.origin.key, label: grouped.origin.label, financing: grouped.origin.financing, since: journey.created_at || null, calculator: ownOrders.length > 0 || proof.hasCalcRef || grouped.refState === 'A_RECUPERAR' },
      unattended: grouped.unattended,
      // Etapa, falta and próxima ação come from the same facts: a ficha marked "Respondido" whose customer
      // wrote again is waiting for the MCS, never shown as answered.
      stage: { code: journey.stage || null, label: !closed && !off && owner.who === 'MCS' && ['RESPONDIDO', 'NOVO'].includes(journey.stage) ? 'Aguardando sua resposta' : JOURNEY_STAGES[journey.stage] || journey.stage || 'Sem etapa', status: journey.status || null, closed, off, closedReason: closed ? journey.closed_reason || null : null },
      searches, owner, conversation, v1,
      // One summary per order (never per conversation); several orders the reading cannot tell apart are declared ambiguous.
      aiOrders: orderSummary.orderSummaries({ orders: [...new Set([...ownOrders.map((order) => order.ref), ...(proof.calcRefs || [])])], summaries: classification.subjectOf(journey.id).summaries || [] }),
      aiReading: insight ? { summary: clean(insight.summary_text) || null, nextStep: clean(insight.next_step_text) || null, at: insight.updated_at || null, note: 'Leitura da IA da última mensagem · não confirmada' } : null,
      modes, fields, carBlocks: carBlocks(carEntries({ orders: ownOrders, journey, requests: ownRequests })), criteria: criteriaSummary(step), situation: null, missing: step.missing, aiOnly: step.aiOnly, ambiguous: step.ambiguous, blocker: step.blocker, nextAction: step.action,
      promises: promises.filter((row) => row.journey_id === journey.id).map((row) => ({ text: row.promise_text, dueAt: row.due_at })),
      links: {
        orders: ownOrders.map(orderLink),
        requests: ownRequests.map((row) => ({ id: row.id, at: row.at, needsReview: row.needsReview, vehicle: vehicleName(row.criteria) })),
        requestsNote: single ? null : 'O contato tem mais de uma ficha: os pedidos lidos da conversa não são ligados a nenhuma delas.',
        cars: { total: carCount, byMode: Object.fromEntries(searches.filter((item) => item.mode).map((item) => [item.mode, item.cars])), uploadAt }
      }
    };
  });
  input.contactIds.forEach((contactId) => {
    const own = journeysOfContact(contactId);
    out.contacts[contactId] = own.length === 1 ? { journeyId: own[0].id } : { journeyId: null, reason: own.length ? 'O contato tem mais de uma ficha: abra a certa pela lista de CLIENTES.' : 'O contato ainda não tem ficha.' };
  });
  const unlinkedRefs = input.refs.filter((ref) => journeysForRef(ref).length !== 1);
  // A conversation already suggested for an unlinked Ref: the link is pending, the client did write.
  const pendingLinks = unlinkedRefs.length ? await safe(inChunks(ctx, 'whatsapp_link_suggestions', { select: 'target_ref,source_journey_id', environment: env, status: 'eq.PENDING' }, 'target_ref', unlinkedRefs), []) : [];
  const pendingLinkRefs = new Set(pendingLinks.map((row) => clean(row.target_ref).toUpperCase()));
  // A Ref with no ficha has no message (a calculator click is never contact, panel-contact.js).
  input.refs.forEach((ref) => {
    const owners = journeysForRef(ref);
    if (owners.length === 1) { out.refs[ref] = { journeyId: owners[0].id }; return; }
    const refOrders = orders.filter((order) => order.ref === ref);
    const fields = buildFields([calculatorSources(refOrders)]);
    const modes = [...new Set(refOrders.map((order) => order.logicalMode).filter((mode) => REQUIRED[mode]))];
    // Same definition of "asked for contact" as ENTRADA (panel-contact); never a guessed ficha.
    const code = owners.length ? 'AMBIGUOUS' : pendingLinkRefs.has(ref) ? 'PENDING_LINK' : 'AWAITING';
    const situation = UNLINKED[code];
    const owner = situation.owner;
    const step = nextStep({ owner, fields, modes, unlinkedRef: code });
    out.refs[ref] = {
      key: 'ref:' + ref, journeyId: null, contactId: null, ref, refs: [ref], sharedRefs: owners.length > 1 ? [ref] : [],
      name: clean((refOrders[0] || {}).contactName) || null,
      contact: { phones: [], whatsappUsername: null, location: null, note: 'A calculadora não guarda telefone.' },
      origin: { code: 'CALCULADORA', label: 'Veio pela calculadora', since: (refOrders.at(-1) || {}).occurredAt || null, calculator: refOrders.length > 0 },
      stage: { code: null, label: situation.label, status: null, closed: false, off: false },
      searches: [], owner, conversation: { messageCount: 0, lastAt: null, lastFrom: null }, aiReading: null,
      situation: { code, label: situation.label, detail: situation.detail }, criteria: criteriaSummary(step),
      fields, carBlocks: carBlocks(carEntries({ orders: refOrders })), missing: step.missing, aiOnly: step.aiOnly, ambiguous: step.ambiguous, blocker: step.blocker, nextAction: step.action,
      ambiguousOwners: owners.length > 1 ? owners.map((journey) => journey.id) : [],
      promises: [], links: { orders: refOrders.map(orderLink), requests: [], requestsNote: null, cars: { total: cars.byRef.get(ref) || 0, byMode: {}, uploadAt } }
    };
  });
  return out;
}

module.exports = { DEADLINE_LABELS, UNLINKED, carBlocks, carEntries, criteriaSummary, deadlineLabel, FIELD_LABELS, JOURNEY_STAGES, MAX_IDS, MODES, REQUIRED, SEARCH_STAGES, STATUS, buildContexts, prepareListContexts, buildFields, calculatorSources, conversationSources, conversationState, field, fichaSources, nextStep, normalizedInput, waitingOn };

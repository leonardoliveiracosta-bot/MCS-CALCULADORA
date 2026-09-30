'use strict';

// Pedidos de veículo (PESQUISAS): regras puras, sem banco e sem rede.
//  * Toda conversa em que a pessoa pediu um veículo vira um pedido rastreável, com as mensagens que
//    sustentam cada critério. Nada é deduzido: marca, modelo, ano, milhagem e orçamento só existem
//    quando a pessoa escreveu; o resto fica como campo faltante.
//  * Estágio, previsão de compra, prazo ou qualquer classificação comercial nunca tiram um pedido.
//  * A comparação usa as regras atuais do matcher (CARRO: marca, modelo, anos e milhagens; VALOR:
//    marca, modelo e lance), sem tolerância nova. Sem esses dados o pedido fica em critérios
//    insuficientes, dizendo o que falta.
const crypto = require('node:crypto');
const vehicleMatch = require('./vehicle-match');
const catalog = require('./vehicle-catalog');

const RULE_VERSION = 'pedidos-v1';
const STATES = Object.freeze(['FALTA_BUSCAR', 'COM_OPCOES', 'SEM_OPCAO', 'CRITERIOS_INSUFICIENTES', 'PRECISA_REVISAO']);
const STATE_LABELS = Object.freeze({
  FALTA_BUSCAR: 'FALTA BUSCAR', COM_OPCOES: 'COM OPÇÕES NO LOTE', SEM_OPCAO: 'SEM OPÇÃO NO LOTE',
  CRITERIOS_INSUFICIENTES: 'CRITÉRIOS INSUFICIENTES', PRECISA_REVISAO: 'PRECISA DE REVISÃO'
});
const FIELDS = Object.freeze(['make', 'model', 'trim', 'year', 'miles', 'budget', 'location', 'notes']);
const FIELD_LABELS = Object.freeze({ make: 'marca', model: 'modelo', trim: 'versão', year: 'ano', yearMax: 'ano máximo', miles: 'milhagem', minMiles: 'milhagem mínima', maxMiles: 'milhagem máxima', budget: 'orçamento', location: 'localização' });
const MAX_MESSAGES = 60;
const MAX_TEXT = 500;

const clean = (value) => value === null || value === undefined ? '' : String(value).normalize('NFC').replace(/[\u0000-\u001f]/g, ' ').trim();
const fold = catalog.fold;
const int = (value) => { const number = Number(String(value === null || value === undefined ? '' : value).replace(/[^0-9.]/g, '')); return Number.isFinite(number) && number > 0 ? Math.round(number) : null; };
const stampOf = (message) => Date.parse(message.occurred_at_utc || message.occurred_at_local || message.created_at || '') || 0;

// ------------------------------------------------------------------ o que a leitura recebe
// Only real messages: never undone ones and never the automatic texts (they are not the customer).
// Both sides go as context; only customer messages can be evidence.
function conversationFor(messages) {
  return (messages || []).filter((message) => message && !message.undone_at && !message.is_automatic && clean(message.body_text))
    .sort((left, right) => stampOf(left) - stampOf(right) || String(left.id).localeCompare(String(right.id)))
    .slice(-MAX_MESSAGES)
    .map((message) => ({ id: String(message.id), from: message.direction === 'CUSTOMER' ? 'CLIENTE' : message.direction === 'MCS' ? 'MCS' : 'SISTEMA', text: clean(message.body_text).slice(0, MAX_TEXT), at: stampOf(message) }));
}
// The reading key: the newest customer message and the rule. An MCS reply alone never triggers a
// new (paid) reading.
function inputHash(conversation) {
  const customer = conversation.filter((item) => item.from === 'CLIENTE');
  const newest = customer.at(-1) || { id: 'none' };
  return crypto.createHash('sha256').update(RULE_VERSION + ':' + newest.id + ':' + customer.length).digest('hex');
}

// ------------------------------------------------------------------ simulador local
// Stands in for the AI in Preview and in tests: reads only what is literally written by the
// customer (catalog makes and models, years, mileage, dollar amounts). It never calls anything.
const MAKES = Object.keys(catalog.MODELS_BY_MAKE);
const words = (text) => ' ' + fold(text) + ' ';
const hasWords = (text, phrase) => { const target = fold(phrase); return target.length > 0 && words(text).includes(' ' + target + ' '); };
const YEAR_RANGE = /\b((?:19[89]|20[0-3])\d)\s*(?:-|to|a|até|ate|through|thru)\s*((?:19[89]|20[0-3])\d)\b/i;
const YEAR = /\b((?:19[89]|20[0-3])\d)\b/g;
const MILES = /\b(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*k)\s*(?:miles|mile|mi|milhas|millas)\b/i;
const MILES_RANGE = /\b(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*k)\s*(?:miles|mi|milhas)?\s*(?:-|to|a|and|e|até|ate)\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*k)\s*(?:miles|mile|mi|milhas|millas)\b/i;
const MONEY = /\$\s*(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?\s*k?)|\b(\d+(?:[.,]\d+)?)\s*k\b(?!\s*(?:miles|mi|milhas))/i;
const GENERIC = /\b(looking for|i want|i need|interested in|quero|procuro|busco|preciso de|estou procurando|buscando)\b.{0,40}\b(car|truck|suv|van|vehicle|carro|caminhonete|veículo|veiculo|auto|carro)\b/i;
const amount = (raw) => { const text = String(raw || '').toLowerCase().replace(/\s/g, ''); const k = text.endsWith('k'); const number = Number(text.replace(/k$/, '').replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.')); return Number.isFinite(number) && number > 0 ? Math.round(k ? number * 1000 : number) : null; };

function vehiclesIn(text) {
  const found = [];
  for (const make of MAKES) {
    const makeSaid = hasWords(text, make);
    for (const model of catalog.MODELS_BY_MAKE[make]) {
      // A model that is only a number (300, 200) needs its make in the same message.
      if (/^\d+$/.test(model) && !makeSaid) continue;
      if (hasWords(text, model)) found.push({ make: makeSaid ? make : null, model });
    }
    if (makeSaid && !found.some((item) => item.make === make)) found.push({ make, model: null });
  }
  // The longest model wins inside one make ("Silverado 1500" over "Silverado").
  return found.filter((item, index, all) => !all.some((other) => other !== item && other.model && item.model && fold(other.model).includes(fold(item.model)) && other.model.length > item.model.length));
}

function simulateExtraction(conversation) {
  const customer = conversation.filter((item) => item.from === 'CLIENTE');
  const requests = new Map();
  const loose = [];
  let generic = null;
  for (const message of customer) {
    const vehicles = vehiclesIn(message.text);
    const facts = {};
    const range = YEAR_RANGE.exec(message.text);
    const years = range ? [Number(range[1]), Number(range[2])] : [...message.text.matchAll(YEAR)].map((match) => Number(match[1]));
    if (years.length) facts.year = { yearMin: Math.min(...years), yearMax: Math.max(...years) };
    const milesRange = MILES_RANGE.exec(message.text);
    const miles = MILES.exec(message.text);
    if (milesRange) facts.miles = { minMiles: Math.min(amount(milesRange[1]), amount(milesRange[2])), maxMiles: Math.max(amount(milesRange[1]), amount(milesRange[2])) };
    else if (miles) facts.miles = { maxMiles: amount(miles[1]) };
    const money = MONEY.exec(message.text);
    if (money) facts.budget = { budgetUsd: amount(money[1] || money[2]) };
    if (vehicles.length) {
      vehicles.forEach((vehicle) => {
        const key = requestKey(vehicle);
        const request = requests.get(key) || { make: null, model: null, evidence: {} };
        if (vehicle.make) { request.make = vehicle.make; (request.evidence.make = request.evidence.make || []).push(message.id); }
        if (vehicle.model) { request.model = vehicle.model; (request.evidence.model = request.evidence.model || []).push(message.id); }
        if (vehicles.length === 1) applyFacts(request, facts, message.id);
        requests.set(key, request);
      });
      if (vehicles.length > 1 && Object.keys(facts).length) loose.push({ facts, id: message.id });
    } else if (Object.keys(facts).length) loose.push({ facts, id: message.id });
    else if (!generic && GENERIC.test(message.text)) generic = message.id;
  }
  const list = [...requests.values()];
  // A number without a vehicle in the same message belongs to the only request there is; with
  // several requests it is not attributed (review, nothing guessed).
  loose.forEach(({ facts, id }) => {
    if (list.length === 1) applyFacts(list[0], facts, id);
    else if (list.length > 1) list.forEach((request) => { request.reviewReason = 'Ano, milhagem ou orçamento sem veículo claro na mesma mensagem'; });
  });
  if (!list.length && generic) list.push({ make: null, model: null, evidence: { notes: [generic] }, notes: 'Pediu um veículo sem dizer qual' });
  return { hasRequest: list.length > 0, requests: list.map((request) => ({ ...request, confidence: request.reviewReason ? 'media' : request.model ? 'alta' : 'baixa' })) };
}
function applyFacts(request, facts, id) {
  if (facts.year) { Object.assign(request, facts.year); (request.evidence.year = request.evidence.year || []).push(id); }
  if (facts.miles && facts.miles.maxMiles) { Object.assign(request, facts.miles); (request.evidence.miles = request.evidence.miles || []).push(id); }
  if (facts.budget && facts.budget.budgetUsd) { Object.assign(request, facts.budget); (request.evidence.budget = request.evidence.budget || []).push(id); }
}

// ------------------------------------------------------------------ conferência da resposta
// The answer (AI or simulator) only counts where the conversation supports it: each field needs
// customer messages as evidence and its value must be written in them. A field that fails is
// dropped and the request goes to review. Nothing is filled in.
function digitsSaid(value, text) {
  const number = int(value);
  if (!number) return false;
  const plain = text.replace(/[.,\s]/g, '');
  return plain.includes(String(number)) || (number % 1000 === 0 && new RegExp('\\b' + number / 1000 + '\\s*k\\b', 'i').test(text));
}
function validateExtraction(raw, conversation) {
  const customer = new Map(conversation.filter((item) => item.from === 'CLIENTE').map((item) => [item.id, item.text]));
  if (!raw || typeof raw !== 'object') return { hasRequest: false, requests: [], errorCode: 'EXTRACTION_RESPONSE_INVALID' };
  const requests = (Array.isArray(raw.requests) ? raw.requests : []).slice(0, 10).map((item) => {
    const evidence = {};
    const problems = [];
    const cited = (field) => {
      const ids = [...new Set((item.evidence && Array.isArray(item.evidence[field]) ? item.evidence[field] : []).map(String))].filter((value) => customer.has(value));
      return { ids, text: ids.map((value) => customer.get(value)).join('\n') };
    };
    const keep = (field, ok) => { const source = cited(field); if (source.ids.length && ok(source.text)) { evidence[field] = source.ids; return true; } problems.push(FIELD_LABELS[field] || field); return false; };
    const criteria = {};
    if (clean(item.make)) { const make = clean(item.make).slice(0, 60); if (keep('make', (text) => hasWords(text, make))) criteria.make = make; }
    if (clean(item.model)) { const model = clean(item.model).slice(0, 80); if (keep('model', (text) => hasWords(text, model))) criteria.model = model; }
    if (clean(item.trim)) { const trim = clean(item.trim).slice(0, 80); if (keep('trim', (text) => hasWords(text, trim))) criteria.trim = trim; }
    if (int(item.yearMin) || int(item.yearMax)) {
      if (keep('year', (text) => [item.yearMin, item.yearMax].filter((value) => int(value)).every((value) => text.includes(String(int(value)))))) {
        if (int(item.yearMin)) criteria.yearMin = int(item.yearMin);
        if (int(item.yearMax)) criteria.yearMax = int(item.yearMax);
      }
    }
    if (int(item.minMiles) || int(item.maxMiles)) {
      if (keep('miles', (text) => [item.minMiles, item.maxMiles].filter((value) => int(value)).every((value) => digitsSaid(value, text)))) {
        if (int(item.minMiles)) criteria.minMiles = int(item.minMiles);
        if (int(item.maxMiles)) criteria.maxMiles = int(item.maxMiles);
      }
    }
    if (int(item.budgetUsd)) { if (keep('budget', (text) => digitsSaid(item.budgetUsd, text))) criteria.budgetUsd = int(item.budgetUsd); }
    if (clean(item.location)) { const location = clean(item.location).slice(0, 120); if (keep('location', (text) => hasWords(text, location))) criteria.location = location; }
    if (clean(item.notes)) { const notes = clean(item.notes).slice(0, 300); const source = cited('notes'); if (source.ids.length) { evidence.notes = source.ids; criteria.notes = notes; } }
    const confidence = ['alta', 'media', 'baixa'].includes(item.confidence) ? item.confidence : 'baixa';
    const reasons = [];
    if (problems.length) reasons.push('Sem evidência verificável para: ' + [...new Set(problems)].join(', '));
    if (clean(item.reviewReason)) reasons.push(clean(item.reviewReason).slice(0, 200));
    if (confidence === 'baixa' && (criteria.model || criteria.make)) reasons.push('Leitura com confiança baixa');
    return describe({ criteria, evidence, confidence, needsReview: reasons.length > 0, reviewReason: reasons.join(' · ').replace(/[.\s]+$/, '') || null });
  }).filter((request) => Object.keys(request.evidence).length > 0);
  // The reading said there is a request but nothing in it could be verified: a person looks at it.
  const unverified = Boolean(raw.hasRequest) && !requests.length;
  return { hasRequest: requests.length > 0, requests, errorCode: unverified ? 'EXTRACTION_UNVERIFIED' : null };
}

// ------------------------------------------------------------------ critérios e comparação
function requestKey(criteria) {
  const make = fold(criteria && criteria.make), model = fold(criteria && criteria.model);
  return make || model ? [make || '-', model || '-'].join('|') : 'sem-veiculo';
}
function criteriaHash(criteria) {
  const c = criteria || {};
  const body = JSON.stringify([fold(c.make), fold(c.model), fold(c.trim), c.yearMin || null, c.yearMax || null, c.minMiles || null, c.maxMiles || null, c.budgetUsd || null]);
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}
// What the current matcher can compare, and what is missing for it (never filled in).
function targetsOf(criteria) {
  const c = criteria || {};
  const wish = { make: c.make || '', model: c.model || '', trim: c.trim || '', yearMin: c.yearMin || null, yearMax: c.yearMax || null, minMiles: c.minMiles || null, maxMiles: c.maxMiles || null };
  const targets = [];
  if (!vehicleMatch.carroWishIssue(wish)) targets.push({ mode: 'CARRO', wishes: [wish], bidCents: null });
  const bidCents = c.budgetUsd ? c.budgetUsd * 100 : null;
  if (!vehicleMatch.valorWishIssue(wish, bidCents)) targets.push({ mode: 'VALOR', wishes: [wish], bidCents });
  return targets;
}
function missingFor(criteria) {
  const c = criteria || {};
  const missing = [];
  if (!clean(c.make)) missing.push('marca');
  if (!clean(c.model)) missing.push('modelo');
  if (targetsOf(c).length) return missing;
  // Neither CARRO (years and mileages) nor VALOR (budget) can be compared yet.
  const carro = [];
  if (!c.yearMin || !c.yearMax) carro.push('ano');
  if (!c.minMiles || !c.maxMiles) carro.push('milhagem mínima e máxima');
  if (!c.budgetUsd) missing.push('orçamento, ou ' + carro.join(' e '));
  else if (carro.length) missing.push(carro.join(' e '));
  return missing;
}
function describe(request) {
  const criteria = request.criteria || {};
  return { ...request, requestKey: requestKey(criteria), criteriaHash: criteriaHash(criteria), missing: missingFor(criteria), comparable: targetsOf(criteria).length > 0 };
}
function criteriaText(criteria) {
  const c = criteria || {};
  const parts = [[c.make, c.model, c.trim].filter(Boolean).join(' ') || 'Veículo não informado'];
  if (c.yearMin || c.yearMax) parts.push(c.yearMin === c.yearMax ? String(c.yearMin) : `${c.yearMin || '?'} a ${c.yearMax || '?'}`);
  if (c.minMiles || c.maxMiles) parts.push(`${c.minMiles ? c.minMiles.toLocaleString('en-US') : '?'} a ${c.maxMiles ? c.maxMiles.toLocaleString('en-US') : '?'} milhas`);
  if (c.budgetUsd) parts.push('até US$ ' + c.budgetUsd.toLocaleString('en-US'));
  if (c.location) parts.push(c.location);
  return parts.join(' · ');
}
// One stored car against the targets of a request, by the current matcher. Only real
// opportunities count (BATE and POR VALOR), never "QUASE", and never a car without a valid MMR.
function optionFor(parsed, targets) {
  if (!parsed || !vehicleMatch.hasValidMmr(parsed)) return null;
  for (const target of targets) {
    const result = vehicleMatch.matchDemand(parsed, target);
    if (result && vehicleMatch.countsAsServed(result.kind)) return result;
  }
  return null;
}
// State of a request against the active batch.
function stateOf(request, check, activeUploadId) {
  if (request.needsReview) return 'PRECISA_REVISAO';
  if (!request.comparable) return 'CRITERIOS_INSUFICIENTES';
  if (!activeUploadId || !check || check.upload_id !== activeUploadId || check.criteria_hash !== request.criteriaHash) return 'FALTA_BUSCAR';
  if (check.result === 'HAS_OPTIONS') return 'COM_OPCOES';
  if (check.result === 'NO_OPTIONS') return 'SEM_OPCAO';
  return check.result === 'INSUFFICIENT' ? 'CRITERIOS_INSUFICIENTES' : 'PRECISA_REVISAO';
}

module.exports = { FIELDS, MAX_MESSAGES, RULE_VERSION, STATES, STATE_LABELS, conversationFor, criteriaHash, criteriaText, describe, inputHash, missingFor, optionFor, requestKey, simulateExtraction, stateOf, targetsOf, validateExtraction, vehiclesIn };

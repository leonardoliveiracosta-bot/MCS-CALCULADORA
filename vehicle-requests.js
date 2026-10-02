'use strict';

// Pedidos de veículo (PESQUISAS): regras puras, sem banco e sem rede.
//  * Toda conversa em que a pessoa pediu um veículo vira um pedido rastreável, com as mensagens que
//    sustentam cada critério. Nada é deduzido: marca, modelo, ano, milhagem e orçamento só existem
//    quando a pessoa escreveu; o resto fica como campo faltante.
//  * Estágio, previsão de compra, prazo ou qualquer classificação comercial nunca tiram um pedido.
//  * Dois modos de busca, pelo que a conversa sustenta (nunca inventado):
//    - CARRO (Find One For Me): veículo, ano e milhagem. Valor não é exigido nem filtra o MMR.
//    - VALOR: modelo e valor. Só aqui o valor entra no cálculo financeiro oficial (lance da Ref);
//      sem ele, o que o lote tem são candidatos com valor a conferir.
//    Sem critérios para nenhum dos dois o pedido fica PRECISA DETALHE, visível, com o que falta e
//    as evidências, e nunca é comparado. Informação contraditória ou não verificável: PRECISA REVISÃO.
//  * Na busca, campo não informado é "sem restrição". MMR válido é sempre obrigatório.
//  * Referência da calculadora, etapa comercial ou prazo de compra nunca bloqueiam um pedido.
const crypto = require('node:crypto');
const vehicleMatch = require('./vehicle-match');
const catalog = require('./vehicle-catalog');

const RULE_VERSION = 'pedidos-v2';
// Readiness of the request and result against the active batch are separate. Only PRONTO is
// compared. CARRO gives options (vehicle, year and mileage decide); VALOR without the official bid
// gives candidates whose value still has to be checked.
const COMPLETENESS = Object.freeze(['PRONTO', 'PRECISA_DETALHE', 'PRECISA_REVISAO']);
const COMPLETENESS_LABELS = Object.freeze({ PRONTO: 'PRONTO PARA BUSCAR', PRECISA_DETALHE: 'PRECISA DETALHE', PRECISA_REVISAO: 'PRECISA DE REVISÃO' });
const RESULTS = Object.freeze(['FALTA_BUSCAR', 'COM_OPCOES', 'COM_CANDIDATOS', 'SEM_OPCAO']);
const RESULT_LABELS = Object.freeze({ FALTA_BUSCAR: 'AINDA NÃO COMPARADO COM O LOTE', COM_OPCOES: 'COM OPÇÕES NO LOTE', COM_CANDIDATOS: 'CANDIDATOS NO LOTE · VALOR A CONFERIR', SEM_OPCAO: 'SEM OPÇÃO NO LOTE' });
const FIELDS = Object.freeze(['make', 'model', 'trim', 'type', 'year', 'miles', 'budget', 'location', 'notes']);
const FIELD_LABELS = Object.freeze({ make: 'marca', model: 'modelo', trim: 'versão', type: 'tipo', year: 'ano', miles: 'milhagem', budget: 'orçamento', location: 'localização' });
// Body types as the customer says them. The Manheim files have no body type, so a type is
// recorded and shown but cannot be checked against the batch.
const BODY_TYPES = Object.freeze({ SUV: ['suv', 'suvs', 'crossover'], Truck: ['truck', 'pickup', 'pick up', 'picape', 'caminhonete', 'camioneta'], Sedan: ['sedan', 'sedã'], Minivan: ['minivan'], Van: ['van'], Coupe: ['coupe', 'coupé'], Convertible: ['convertible', 'conversível'], Hatchback: ['hatchback', 'hatch'], Wagon: ['wagon', 'station wagon'] });
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
const MILES_LINE = /(?:mileage range|faixa de milhas|rango de millas)\s*:\s*(\d[\d.,]*\s*k?)\s*-\s*(\d[\d.,]*\s*k?)/i;
const YEAR_NEWER = /\b((?:19[89]|20[0-3])\d)\s*(?:or newer|and newer|and up|or later|\+|ou mais novo|em diante)|\b(?:newer than|after|from|a partir de|depois de)\s*((?:19[89]|20[0-3])\d)\b/i;
const YEAR_OLDER = /\b((?:19[89]|20[0-3])\d)\s*(?:or older|or earlier|ou mais antigo)|\b(?:older than|before|até o ano|antes de)\s*((?:19[89]|20[0-3])\d)\b/i;
const MORE_THAN = /(?:more than|over|above|at least|mais de|acima de|no mínimo)\s*$/i;
function bodyTypeIn(text) {
  for (const [type, names] of Object.entries(BODY_TYPES)) if (names.some((name) => hasWords(text, name))) return type;
  return null;
}
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
    const newer = YEAR_NEWER.exec(message.text), older = YEAR_OLDER.exec(message.text);
    const years = range ? [Number(range[1]), Number(range[2])] : [...message.text.matchAll(YEAR)].map((match) => Number(match[1]));
    // Only the side the customer gave: "2019 or newer" has no upper limit.
    if (newer && !range) facts.year = { yearMin: Number(newer[1] || newer[2]) };
    else if (older && !range) facts.year = { yearMax: Number(older[1] || older[2]) };
    else if (years.length) facts.year = { yearMin: Math.min(...years), yearMax: Math.max(...years) };
    const milesRange = MILES_RANGE.exec(message.text) || MILES_LINE.exec(message.text);
    const miles = MILES.exec(message.text);
    if (milesRange) facts.miles = { minMiles: Math.min(amount(milesRange[1]), amount(milesRange[2])), maxMiles: Math.max(amount(milesRange[1]), amount(milesRange[2])) };
    // "less than 60,000 miles" is a maximum; "more than 20,000 miles" is a minimum.
    else if (miles) facts.miles = MORE_THAN.test(message.text.slice(0, miles.index)) ? { minMiles: amount(miles[1]) } : { maxMiles: amount(miles[1]) };
    const type = bodyTypeIn(message.text);
    if (type) facts.type = { bodyType: type };
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
  // Useful facts without a make or model ("an SUV under $25,000", "less than 60,000 miles") are
  // a request of their own when no vehicle was named.
  if (!list.length && loose.length) list.push({ make: null, model: null, evidence: {} });
  loose.forEach(({ facts, id }) => {
    if (list.length === 1) applyFacts(list[0], facts, id);
    else if (list.length > 1) list.forEach((request) => { request.reviewReason = 'Ano, milhagem ou orçamento sem veículo claro na mesma mensagem'; });
  });
  if (!list.length && generic) list.push({ make: null, model: null, evidence: { notes: [generic] }, notes: 'Pediu um veículo sem dizer qual' });
  return { hasRequest: list.length > 0, requests: list.map((request) => ({ ...request, confidence: request.reviewReason ? 'media' : 'alta' })) };
}
function applyFacts(request, facts, id) {
  if (facts.type) { Object.assign(request, facts.type); (request.evidence.type = request.evidence.type || []).push(id); }
  if (facts.year) { Object.assign(request, facts.year); (request.evidence.year = request.evidence.year || []).push(id); }
  if (facts.miles && (facts.miles.maxMiles || facts.miles.minMiles)) { Object.assign(request, facts.miles); (request.evidence.miles = request.evidence.miles || []).push(id); }
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
    if (clean(item.bodyType)) {
      const type = Object.keys(BODY_TYPES).find((name) => fold(name) === fold(item.bodyType));
      if (type && keep('type', (text) => BODY_TYPES[type].some((name) => hasWords(text, name)))) criteria.bodyType = type;
      else if (!type) problems.push('tipo');
    }
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
  const make = fold(criteria && criteria.make), model = fold(criteria && criteria.model), type = fold(criteria && criteria.bodyType);
  return make || model ? [make || '-', model || '-'].join('|') : type ? 'tipo|' + type : 'sem-veiculo';
}
function criteriaHash(criteria) {
  const c = criteria || {};
  const body = JSON.stringify([fold(c.make), fold(c.model), fold(c.trim), fold(c.bodyType), c.yearMin || null, c.yearMax || null, c.minMiles || null, c.maxMiles || null, c.budgetUsd || null]);
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}
// A criterion the batch can be compared with. Location and notes are shown, never compared.
const useful = (c) => Boolean(c && (clean(c.make) || clean(c.model) || c.bodyType || c.yearMin || c.yearMax || c.minMiles || c.maxMiles || c.budgetUsd));
// What each search mode still needs. A missing Ref never is.
const SEARCH_MODES = Object.freeze(['CARRO', 'VALOR']);
const MODE_LABELS = Object.freeze({ CARRO: 'POR CARRO', VALOR: 'POR VALOR' });
function searchLacks(criteria, modes = SEARCH_MODES) {
  const c = criteria || {};
  const lacks = {};
  if (modes.includes('CARRO')) lacks.CARRO = [!clean(c.model) && 'modelo', !c.yearMin && !c.yearMax && 'ano', !c.minMiles && !c.maxMiles && 'milhagem'].filter(Boolean);
  if (modes.includes('VALOR')) lacks.VALOR = [!clean(c.model) && 'modelo', !c.budgetUsd && 'valor'].filter(Boolean);
  return lacks;
}
// The mode the criteria support: CARRO when vehicle, year and mileage were said, otherwise VALOR
// when model and value were said, otherwise none. `modes` narrows it when the origin has a mode.
function searchModeOf(criteria, modes = SEARCH_MODES) {
  const lacks = searchLacks(criteria, modes);
  return SEARCH_MODES.find((mode) => lacks[mode] && !lacks[mode].length) || null;
}
// "Falta valor" with one mode; with both, what each one would need.
const listText = (items) => items.length > 1 ? items.slice(0, -1).join(', ') + ' e ' + items.at(-1) : items.join('');
function lacksText(lacks) {
  const modes = Object.keys(lacks || {});
  if (modes.length === 1) return 'Falta ' + listText(lacks[modes[0]]);
  return modes.map((mode) => `para buscar ${MODE_LABELS[mode].toLowerCase()} falta ${listText(lacks[mode])}`).join('; ').replace(/^p/, 'P');
}
// A model the catalog does not know, without a make, cannot be verified in the batch.
const unknownModel = (c) => Boolean(clean(c.model) && !clean(c.make) && !catalog.inferMake(c.model).candidates.length);
function completenessOf(criteria, needsReview, modes = SEARCH_MODES) {
  const c = criteria || {};
  if (needsReview) return 'PRECISA_REVISAO';
  if (!searchModeOf(c, modes)) return 'PRECISA_DETALHE';
  return unknownModel(c) ? 'PRECISA_REVISAO' : 'PRONTO';
}
// In a ready request, what the customer did not say is no restriction (never an error of theirs).
// Only what the search type uses: POR CARRO never lists the value, POR VALOR never year or mileage.
function notInformed(criteria, mode = null) {
  const c = criteria || {};
  const missing = [];
  if (!clean(c.make)) missing.push('marca');
  if (!clean(c.model)) missing.push('modelo');
  if (mode !== 'VALOR' && !c.yearMin && !c.yearMax) missing.push('ano');
  if (mode !== 'VALOR' && !c.minMiles && !c.maxMiles) missing.push('milhagem');
  if (mode !== 'CARRO' && !c.budgetUsd) missing.push('valor');
  return missing;
}
// A model that belongs to one make only in the catalog gives that make (deterministic, never a
// guess); it is shown as coming from the model and the customer's own words stay as they were.
function inferredMakeOf(criteria) {
  const c = criteria || {};
  if (clean(c.make) || !clean(c.model)) return null;
  const found = catalog.inferMake(c.model);
  return found && found.make && !found.ambiguous ? found.make : null;
}
function describe(request, modes = SEARCH_MODES) {
  const criteria = request.criteria || {};
  const completeness = completenessOf(criteria, request.needsReview, modes);
  const lacks = completeness === 'PRECISA_DETALHE' ? searchLacks(criteria, modes) : {};
  const inferredMake = inferredMakeOf(criteria);
  const reviewReason = request.reviewReason || (completeness === 'PRECISA_REVISAO' && unknownModel(criteria) ? 'Modelo sem marca e fora do catálogo: não dá para conferir no lote' : null);
  return { ...request, reviewReason, requestKey: requestKey(criteria), criteriaHash: criteriaHash(criteria), completeness, inferredMake,
    searchMode: completeness === 'PRONTO' ? searchModeOf(criteria, modes) : null, lacks, lacksText: completeness === 'PRECISA_DETALHE' ? lacksText(lacks) : null,
    missing: completeness === 'PRONTO' ? notInformed(criteria, searchModeOf(criteria, modes)).filter((field) => !(field === 'marca' && inferredMake)) : [], comparable: completeness === 'PRONTO' };
}
const miles = (value) => Number(value).toLocaleString('en-US');
function criteriaText(criteria) {
  const c = criteria || {};
  const inferred = inferredMakeOf(c);
  const vehicle = [c.make || inferred, c.model, c.trim].filter(Boolean).join(' ') + (inferred ? ' (marca pelo modelo)' : '');
  const parts = [vehicle || (c.bodyType ? c.bodyType : 'Veículo não informado')];
  if (vehicle && c.bodyType) parts.push(c.bodyType);
  if (c.yearMin && c.yearMax) parts.push(c.yearMin === c.yearMax ? String(c.yearMin) : `${c.yearMin} a ${c.yearMax}`);
  else if (c.yearMin) parts.push(`${c.yearMin} ou mais novo`);
  else if (c.yearMax) parts.push(`até ${c.yearMax}`);
  if (c.minMiles && c.maxMiles) parts.push(`${miles(c.minMiles)} a ${miles(c.maxMiles)} milhas`);
  else if (c.maxMiles) parts.push(`até ${miles(c.maxMiles)} milhas`);
  else if (c.minMiles) parts.push(`a partir de ${miles(c.minMiles)} milhas`);
  if (c.budgetUsd) parts.push('até US$ ' + c.budgetUsd.toLocaleString('en-US'));
  if (c.location) parts.push(c.location);
  return parts.join(' · ');
}
// The complete demands of the ficha keep the current matcher (the same as OPÇÕES).
function targetsOf(criteria) {
  const c = criteria || {};
  const wish = { make: c.make || '', model: c.model || '', trim: c.trim || '', yearMin: c.yearMin || null, yearMax: c.yearMax || null, minMiles: c.minMiles || null, maxMiles: c.maxMiles || null };
  const targets = [];
  if (!vehicleMatch.carroWishIssue(wish)) targets.push({ mode: 'CARRO', wishes: [wish], bidCents: null });
  const bidCents = c.budgetUsd ? c.budgetUsd * 100 : null;
  if (!vehicleMatch.valorWishIssue(wish, bidCents)) targets.push({ mode: 'VALOR', wishes: [wish], bidCents });
  return targets;
}
function optionFor(parsed, targets) {
  if (!parsed || !vehicleMatch.hasValidMmr(parsed)) return null;
  for (const target of targets) {
    const result = vehicleMatch.matchDemand(parsed, target);
    if (result && vehicleMatch.countsAsServed(result.kind)) return result;
  }
  return null;
}
// A ready request without the official matcher: model, and only the year and mileage limits the
// customer gave (a field not informed is no restriction). Always a valid MMR; a limit on year or
// mileage needs the car's value to be known. The customer's value is never an MMR filter (in VALOR
// its conversion into a bid is the official calculation). The body type cannot be checked.
function fitsReady(parsed, criteria) {
  const c = criteria || {};
  if (!parsed || !vehicleMatch.hasValidMmr(parsed) || !clean(c.model)) return false;
  const make = clean(c.make) || inferredMakeOf(c);
  if (make && fold(parsed.make) !== fold(make)) return false;
  if (clean(c.model) && !catalog.modelsMatch(parsed.model, c.model, parsed.make, c.make || parsed.make)) return false;
  if (clean(c.trim) && !words(parsed.trim || '').includes(' ' + fold(c.trim) + ' ')) return false;
  const year = int(parsed.year);
  if ((c.yearMin || c.yearMax) && !year) return false;
  if (c.yearMin && year < c.yearMin) return false;
  if (c.yearMax && year > c.yearMax) return false;
  const odometer = parsed.miles === null || parsed.miles === undefined || parsed.miles === '' ? null : Number(parsed.miles);
  if ((c.minMiles || c.maxMiles) && !Number.isFinite(odometer)) return false;
  if (c.minMiles && odometer < c.minMiles) return false;
  if (c.maxMiles && odometer > c.maxMiles) return false;
  return true;
}
// Result of a request against the active batch (only for requests that can be compared).
function resultOf(request, check, activeUploadId) {
  if (!request.comparable) return null;
  if (!activeUploadId || !check || check.upload_id !== activeUploadId || check.criteria_hash !== request.criteriaHash) return 'FALTA_BUSCAR';
  return check.result === 'HAS_OPTIONS' ? 'COM_OPCOES' : check.result === 'HAS_CANDIDATES' ? 'COM_CANDIDATOS' : check.result === 'NO_OPTIONS' ? 'SEM_OPCAO' : 'FALTA_BUSCAR';
}

module.exports = { inferredMakeOf, BODY_TYPES, COMPLETENESS, COMPLETENESS_LABELS, FIELDS, MAX_MESSAGES, RESULTS, RESULT_LABELS, MODE_LABELS, RULE_VERSION, SEARCH_MODES, completenessOf, lacksText, searchLacks, searchModeOf, conversationFor, criteriaHash, criteriaText, describe, fitsReady, inputHash, notInformed, optionFor, requestKey, resultOf, simulateExtraction, targetsOf, useful, validateExtraction, vehiclesIn };

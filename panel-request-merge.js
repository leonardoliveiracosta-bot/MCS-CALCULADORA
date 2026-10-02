'use strict';

// Apresentação de BUSCAR CARROS (antiga PESQUISAS), só leitura: o pedido da ficha (ou da
// calculadora) e a leitura equivalente da mesma conversa pela IA viram um pedido só. A leitura da
// IA fica como evidência do pedido, sempre identificada como não confirmada. Nada é apagado e
// nenhum identificador ou hash muda: a lista completa continua sendo usada para comparar com o
// lote; aqui só se decide o que aparece e como se conta.
//  * Une só quando é certo: a leitura está ligada à mesma ficha, o tipo de busca não diverge e
//    marca, modelo, anos, milhagens e valor são iguais a exatamente um pedido daquela ficha.
//  * Caso ambíguo (mais de um pedido igual, critério diferente, ficha incerta) fica separado.
const catalog = require('./vehicle-catalog');
const requests = require('./vehicle-requests');

const num = (value) => { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; };
const text = (value) => String(value || '').trim();

function modelKey(make, model) {
  if (!text(model)) return '';
  return catalog.modelTokens(model, make).join(' ') || catalog.fold(model);
}
// The criteria of one wish, normalized for an equality check (never for the search itself).
function signature({ make, model, yearMin, yearMax, minMiles, maxMiles, budgetUsd }) {
  const madeBy = text(make) || requests.inferredMakeOf({ model }) || '';
  return JSON.stringify([catalog.fold(madeBy), modelKey(madeBy, model), num(yearMin), num(yearMax), num(minMiles), num(maxMiles), num(budgetUsd)]);
}
// Every wish a ficha/calculator request stands for, with its mode.
function fichaSignatures(item) {
  if (item.official && item.targets && item.targets[0]) {
    const target = item.targets[0];
    const budgetUsd = target.mode === 'VALOR' && target.bidCents ? Math.round(target.bidCents / 100) : null;
    return (target.wishes || []).map((wish) => signature({ ...wish, budgetUsd }));
  }
  return item.criteria ? [signature(item.criteria)] : [];
}
const modeOf = (item) => item.searchMode || (requests.SEARCH_MODES.includes(item.mode) ? item.mode : null);

// list.items (buildList) -> { items, merged }: items to show, conversation items folded into a
// ficha item as `aiEvidence`. Input objects are never changed.
function present(items) {
  const all = Array.isArray(items) ? items : [];
  const fichaByJourney = new Map();
  all.filter((item) => item.source !== 'CONVERSA' && item.person && item.person.journeyId).forEach((item) => {
    if (!fichaByJourney.has(item.person.journeyId)) fichaByJourney.set(item.person.journeyId, []);
    fichaByJourney.get(item.person.journeyId).push(item);
  });
  const into = new Map();
  all.filter((item) => item.source === 'CONVERSA' && item.person && item.person.journeyId && item.criteria).forEach((item) => {
    const own = signature(item.criteria);
    const mode = modeOf(item);
    const same = (fichaByJourney.get(item.person.journeyId) || []).filter((ficha) => {
      const fichaMode = modeOf(ficha);
      if (mode && fichaMode && mode !== fichaMode) return false;
      return fichaSignatures(ficha).includes(own);
    });
    if (same.length === 1) into.set(item.key, same[0].key);
  });
  const evidenceFor = new Map();
  all.filter((item) => into.has(item.key)).forEach((item) => {
    const target = into.get(item.key);
    if (!evidenceFor.has(target)) evidenceFor.set(target, []);
    evidenceFor.get(target).push({ key: item.key, criteriaText: item.criteriaText, confirmed: false, versions: item.versions || 1,
      chatId: item.chatId || null, lastMessageAt: item.lastMessageAt || null, evidence: item.evidence || [] });
  });
  const shown = all.filter((item) => !into.has(item.key)).map((item) => evidenceFor.has(item.key) ? { ...item, aiEvidence: evidenceFor.get(item.key) } : item);
  return { items: shown, merged: into.size };
}

// One person can have one request per search type: people and requests are counted apart.
function counts(items, states) {
  const list = Array.isArray(items) ? items : [];
  const people = new Set(list.map((item) => item.person && (item.person.journeyId || item.person.contactId || item.person.ref) || 'pedido:' + item.key));
  const byMode = { VALOR: 0, CARRO: 0, SEM_TIPO: 0 };
  list.forEach((item) => { const mode = item.searchMode; byMode[mode === 'VALOR' || mode === 'CARRO' ? mode : 'SEM_TIPO'] += 1; });
  return { requests: list.length, people: people.size, byMode, states: Object.fromEntries((states || []).map((state) => [state, list.filter((item) => item.state === state).length])) };
}

module.exports = { present, counts, signature };

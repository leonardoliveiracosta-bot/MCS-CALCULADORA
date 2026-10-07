'use strict';
// Phone link procedure for a print without a proven Ref. The phone alone never decides.
//  1. Fichas that own the phone (through the contact's current phone): exactly one is needed.
//  2. That one ficha joins. A different name or car (or a name the ficha cannot check) does not hold the link: it is
//     returned in `conflicts` only as information for the ficha.
//  3. Zero fichas -> QUARENTENA_SEM_FICHA (no new lead is made behind the operator's back in the automatic run).
//     Two or more fichas -> FILA_VARIAS_FICHAS with the written reason and the candidates.
const REASONS = {
  QUARENTENA_SEM_FICHA: 'O telefone do print não pertence a nenhuma ficha: o print fica em quarentena até haver ficha, Ref ou decisão manual.',
  FILA_VARIAS_FICHAS: 'O telefone pertence a mais de uma ficha: escolha a ficha certa (nenhuma foi escolhida automaticamente).',
  FILA_CONTRADICAO: 'Telefone novo para esta ficha e nome diferente: confirme se é a mesma pessoa antes de juntar.'
};
const MAKES = ['acura', 'audi', 'bmw', 'buick', 'cadillac', 'chevrolet', 'chevy', 'chrysler', 'dodge', 'ford', 'gmc', 'honda', 'hyundai', 'infiniti', 'jeep', 'kia', 'lexus', 'lincoln', 'mazda', 'mercedes', 'mini', 'mitsubishi', 'nissan', 'ram', 'subaru', 'tesla', 'toyota', 'volkswagen', 'volvo'];
const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// A person's name only: a phone number or a Ref code saved as the contact name is no name.
const isPersonName = (text) => { const value = String(text || '').trim(); return Boolean(value) && !/^\+?\d[\d\s().-]*$/.test(value) && !(/^[A-HJ-NP-Z2-9]{5}$/.test(value) && /\d/.test(value)); };
const nameTokens = (text) => isPersonName(text) ? fold(text).split(/[^a-z]+/).filter((token) => token.length >= 3) : [];
const fichaTokens = (ficha) => [ficha && ficha.contactName, ...((ficha && ficha.names) || [])].flatMap(nameTokens);
// The names agree when at least one word (3+ letters) is shared: "Tyreek Thompson" and "Tyreek Eazy Thompson".
const namesAgree = (name, names) => { const a = nameTokens(name), b = (names || []).flatMap(nameTokens); return a.length > 0 && a.some((token) => b.includes(token)); };
const makesIn = (text) => { const words = new Set(fold(text).split(/[^a-z0-9]+/)); return MAKES.filter((make) => words.has(make)); };

// What the name says about the link: null (no name in the message, or the same name), 'nome' (a different name),
// or 'nome-desconhecido' (the ficha has no name to check against and the message came from another chat).
function nameConflict(printName, ficha) {
  const a = nameTokens(printName);
  if (!a.length) return null;
  const b = fichaTokens(ficha);
  if (!b.length) return ficha && ficha.sameChat ? null : 'nome-desconhecido';
  return a.some((token) => b.includes(token)) ? null : 'nome';
}
const nameContradicts = (printName, ficha) => Boolean(nameConflict(printName, ficha));
// A car contradicts only when both sides name a make and no make is shared.
function carContradicts(printText, ficha) {
  const a = makesIn(printText), b = makesIn(ficha && ficha.vehicleText);
  if (!a.length || !b.length) return false;
  return !a.some((make) => b.includes(make));
}

// fichas: [{id, contactName, names, sameChat, vehicleText}] that own the phone. values: {name, message}.
function decide({ fichas = [], values = {} } = {}) {
  if (!fichas.length) return { action: 'QUARANTINE', reason: 'QUARENTENA_SEM_FICHA', text: REASONS.QUARENTENA_SEM_FICHA, candidates: [] };
  if (fichas.length > 1) return { action: 'QUEUE', reason: 'FILA_VARIAS_FICHAS', text: REASONS.FILA_VARIAS_FICHAS, candidates: fichas.map((ficha) => ficha.id) };
  const [ficha] = fichas;
  const conflicts = [nameConflict(values.name, ficha), carContradicts(values.message, ficha) && 'carro'].filter(Boolean);
  return { action: 'LINK', journeyId: ficha.id, candidates: [ficha.id], ...(conflicts.length ? { conflicts } : {}) };
}
// pending_reason keeps the code and the candidate fichas: CODE|id,id
const encode = (decision) => decision.reason + (decision.candidates && decision.candidates.length ? '|' + decision.candidates.join(',') : '');
function parse(value) { const [code, list] = String(value || '').split('|'); return { code: code || null, candidates: list ? list.split(',').filter(Boolean) : [] }; }

module.exports = { REASONS, decide, encode, parse, nameConflict, nameContradicts, namesAgree, isPersonName, carContradicts, makesIn };

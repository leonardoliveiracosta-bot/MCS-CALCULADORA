'use strict';
// Phone link procedure for a print without a proven Ref. The phone alone never decides.
//  1. Fichas that own the phone (through the contact's current phone): exactly one is needed.
//  2. Zero name contradiction and zero car contradiction between the print and that ficha.
//  3. Zero fichas -> QUARENTENA_SEM_FICHA (no new lead is made behind the operator's back in the automatic run).
//     Two or more fichas, or a contradiction -> FILA_* with the written reason and the candidates.
const REASONS = {
  QUARENTENA_SEM_FICHA: 'O telefone do print não pertence a nenhuma ficha: o print fica em quarentena até haver ficha, Ref ou decisão manual.',
  FILA_VARIAS_FICHAS: 'O telefone pertence a mais de uma ficha: escolha a ficha certa (nenhuma foi escolhida automaticamente).',
  FILA_CONTRADICAO: 'O telefone pertence a uma ficha, mas o nome ou o carro do print contradiz a ficha: confirme antes de ligar.'
};
const MAKES = ['acura', 'audi', 'bmw', 'buick', 'cadillac', 'chevrolet', 'chevy', 'chrysler', 'dodge', 'ford', 'gmc', 'honda', 'hyundai', 'infiniti', 'jeep', 'kia', 'lexus', 'lincoln', 'mazda', 'mercedes', 'mini', 'mitsubishi', 'nissan', 'ram', 'subaru', 'tesla', 'toyota', 'volkswagen', 'volvo'];
const fold = (text) => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const nameTokens = (text) => fold(text).split(/[^a-z]+/).filter((token) => token.length >= 3);
const makesIn = (text) => { const words = new Set(fold(text).split(/[^a-z0-9]+/)); return MAKES.filter((make) => words.has(make)); };

// A name contradicts only when both sides have a name and no token is shared.
function nameContradicts(printName, ficha) {
  const a = nameTokens(printName), b = nameTokens(ficha && ficha.contactName);
  if (!a.length || !b.length) return false;
  return !a.some((token) => b.includes(token));
}
// A car contradicts only when both sides name a make and no make is shared.
function carContradicts(printText, ficha) {
  const a = makesIn(printText), b = makesIn(ficha && ficha.vehicleText);
  if (!a.length || !b.length) return false;
  return !a.some((make) => b.includes(make));
}

// fichas: [{id, contactName, vehicleText}] that own the phone. values: {name, message}.
function decide({ fichas = [], values = {} } = {}) {
  if (!fichas.length) return { action: 'QUARANTINE', reason: 'QUARENTENA_SEM_FICHA', text: REASONS.QUARENTENA_SEM_FICHA, candidates: [] };
  if (fichas.length > 1) return { action: 'QUEUE', reason: 'FILA_VARIAS_FICHAS', text: REASONS.FILA_VARIAS_FICHAS, candidates: fichas.map((ficha) => ficha.id) };
  const [ficha] = fichas;
  const conflicts = [nameContradicts(values.name, ficha) && 'nome', carContradicts(values.message, ficha) && 'carro'].filter(Boolean);
  if (conflicts.length) return { action: 'QUEUE', reason: 'FILA_CONTRADICAO', text: REASONS.FILA_CONTRADICAO, conflicts, candidates: [ficha.id] };
  return { action: 'LINK', journeyId: ficha.id, candidates: [ficha.id] };
}
// pending_reason keeps the code and the candidate fichas: CODE|id,id
const encode = (decision) => decision.reason + (decision.candidates && decision.candidates.length ? '|' + decision.candidates.join(',') : '');
function parse(value) { const [code, list] = String(value || '').split('|'); return { code: code || null, candidates: list ? list.split(',').filter(Boolean) : [] }; }

module.exports = { REASONS, decide, encode, parse, nameContradicts, carContradicts, makesIn };

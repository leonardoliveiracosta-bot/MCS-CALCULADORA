'use strict';

// Identidade de um caso: a Ref da calculadora é comprovada por um registro da calculadora
// (calc_runs) OU pela própria mensagem da calculadora que o cliente mandou ("Ref: XXXXX"). O código
// guardado na ficha sem essa prova é só um código interno (nunca é "Ref"). WhatsApp e SMS são
// canais: não mudam a origem. Nome, carro ou horário parecidos nunca substituem uma Ref explícita.
// Só leitura: nada aqui grava.
const REF_RE = /^[A-HJ-NP-Z2-9]{5}$/;
// The calculator message carries "Ref: XXXXX" at the end (one of the calculator templates).
const EXPLICIT_REF = /(?:^|[^A-Za-z0-9])Ref:\s*([A-HJ-NP-Z2-9]{5})(?![A-Za-z0-9])/gi;
const CALCULATOR_MESSAGE = /My Car Scout/i;
const upper = (value) => String(value || '').trim().toUpperCase();

// Refs written by the client in a calculator message.
function explicitRefs(text) {
  const body = String(text || '');
  if (!CALCULATOR_MESSAGE.test(body)) return [];
  const out = new Set();
  for (const match of body.matchAll(EXPLICIT_REF)) out.add(match[1].toUpperCase());
  return [...out];
}
// A message in the calculator's model (with or without a Ref the client kept): proof that the person came from the calculator.
const TEMPLATE_RE = /(vehicle search request|calculate my cost|find one for me|maximum bid|year range|mileage range|·\s*FIND\s*·|lance máximo|faixa de anos|rango de años)/i;
// Same detection as the router (panel-calc-message): every version and language of the model.
function isCalculatorTemplate(text) { const body = String(text || ''); return CALCULATOR_MESSAGE.test(body) && (TEMPLATE_RE.test(body) || require('./panel-calc-message').MARKERS.test(body)); }
// The calculator the message came from: Find One For Me (by car) or Calculate My Cost (by value).
function messageMode(text) {
  const body = String(text || '');
  if (/·\s*FIND\s*·|year range|mileage range|faixa de anos|faixa de milhas|rango de años|solicitação de busca|search request/i.test(body)) return 'CARRO';
  if (/maximum bid|lance máximo|oferta máxima|max(?:imum)? offer/i.test(body)) return 'VALOR';
  return null;
}

// journey: { reference_code }, linkedRefs: refs from journey_refs, runRefs: Set of refs with
// calc_runs, explicit: [{ ref, mode, at }] read from the client's calculator messages of this ficha.
function proofFor({ journey = null, linkedRefs = [], runRefs = new Set(), explicit = [] } = {}) {
  const code = upper(journey && journey.reference_code);
  const owned = [...new Set([code, ...linkedRefs.map(upper)].filter((ref) => REF_RE.test(ref)))];
  const written = new Map();
  (explicit || []).forEach((entry) => { const ref = upper(entry.ref); if (REF_RE.test(ref) && !written.has(ref)) written.set(ref, entry); });
  const proven = owned.filter((ref) => runRefs.has(ref) || written.has(ref));
  // A Ref the client wrote is the client's Ref even before it is linked to this ficha (it is listed apart).
  const writtenNotOwned = [...written.keys()].filter((ref) => !owned.includes(ref));
  const calcRefs = [...proven, ...writtenNotOwned];
  const withoutRun = calcRefs.filter((ref) => !runRefs.has(ref));
  const modes = [...new Set([...written.values()].map((entry) => entry.mode).filter(Boolean))];
  const firstAt = [...written.values()].map((entry) => entry.at).filter(Boolean).sort()[0] || null;
  return {
    calcRefs, hasCalcRef: calcRefs.length > 0, calcRef: calcRefs[0] || null,
    // Known Ref whose simulation is not in calc_runs: still a Ref (detail only, never "Sem Ref").
    calcRefsWithoutRun: withoutRun,
    internalCode: code && !calcRefs.includes(code) ? code : null,
    messageModes: modes, messageAt: firstAt, writtenRefs: [...written.keys()]
  };
}

// The explicit refs of every ficha (database function, one row per ficha and Ref).
async function loadExplicit(ctx, rpc, journeyIds = null) {
  const rows = await rpc(ctx, 'panel_journey_explicit_refs', { p_environment: ctx.environment, p_journey_ids: journeyIds && journeyIds.length ? journeyIds : null }).catch(() => null);
  if (!Array.isArray(rows)) return null;
  const by = new Map();
  rows.forEach((row) => {
    if (!by.has(row.journey_id)) by.set(row.journey_id, []);
    by.get(row.journey_id).push({ ref: upper(row.ref), mode: row.mode || null, at: row.first_at || null });
  });
  return by;
}
const runRefsOf = (calcRuns) => new Set((calcRuns || []).filter((row) => row && row.is_test !== true).map((row) => upper(row.dados && row.dados.ref)).filter((ref) => REF_RE.test(ref)));

// An AI link suggestion that points to another Ref than the one the client wrote is wrong by rule.
function contradicts(suggestion, writtenRefs) {
  const target = upper(suggestion && suggestion.target_ref);
  return Boolean(target && writtenRefs && writtenRefs.length && !writtenRefs.includes(target));
}

// The simulations of these Refs in calc_runs (tests never count), read in small batches.
async function runRefsAmong(ctx, rows, refs) {
  const found = new Set();
  const list = [...new Set((refs || []).map(upper).filter((ref) => REF_RE.test(ref)))];
  for (let index = 0; index < list.length; index += 150) {
    const part = list.slice(index, index + 150);
    runRefsOf(await rows(ctx, 'calc_runs', { select: 'dados,is_test', 'dados->>ref': 'in.(' + part.join(',') + ')' })).forEach((ref) => found.add(ref));
  }
  return found;
}

// The calculator Ref of each ficha with the same proof as the ficha detail (simulation in calc_runs, or the client's
// calculator message): "Ref" on screen only for a proven Ref; a code without proof is only the ficha's internal code.
// linkedByJourney: Map(journeyId -> [ref_code]) from journey_refs.
async function proofIndex(ctx, { rows, rpc }, journeys, linkedByJourney = new Map()) {
  const list = (journeys || []).filter((journey) => journey && journey.id);
  if (!list.length) return new Map();
  const ids = list.map((journey) => journey.id);
  const explicit = (await loadExplicit(ctx, rpc, ids.length <= 200 ? ids : null).catch(() => null)) || new Map();
  const candidates = list.flatMap((journey) => [journey.reference_code, ...(linkedByJourney.get(journey.id) || []), ...(explicit.get(journey.id) || []).map((entry) => entry.ref)]);
  const runRefs = await runRefsAmong(ctx, rows, candidates).catch(() => new Set());
  return new Map(list.map((journey) => [journey.id, proofFor({ journey, linkedRefs: linkedByJourney.get(journey.id) || [], runRefs, explicit: explicit.get(journey.id) || [] })]));
}

module.exports = { REF_RE, isCalculatorTemplate, explicitRefs, messageMode, proofFor, loadExplicit, runRefsOf, runRefsAmong, proofIndex, contradicts };

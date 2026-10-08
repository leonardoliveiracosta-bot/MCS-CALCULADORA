'use strict';

const { readBundle } = require('./panel-boot-reads');

// BUSCAS and Manheim read the same demands: one per person (ficha or Ref without ficha) and
// logical mode. VALOR and CARRO never share criteria and are never merged into one demand.
const { allRows, rpc } = require('./panel-server');
const refProof = require('./panel-ref-proof');
const { buildSearchDemands, consolidateCalcRuns, groupCalculatorByRef, matchManheimDemand, reactivationEligible, toggleEnabled } = require('./panel-domain');
const vehicleMatch = require('./vehicle-match');
const { contactIndex } = require('./panel-contact');
const { dispositionIndex } = require('./panel-disposition');
const { activeRows, outOfFunnelJourneys } = require('./panel-triage');

const upper = (value) => String(value || '').trim().toUpperCase();

// `services.allRows` lets the caller pass its own reader (the handler's module, in tests).
async function loadBuscasBase(ctx, services = {}) {
  await require('./panel-model-aliases').load(ctx, { ...services, rpc: services.rpc || rpc });
  // PESQUISAS and the options counter in the same boot build the identical base.
  // Keep this promise inside that authenticated request only, never across users or requests.
  if (!ctx.buscasBases) return loadBuscasBaseNow(ctx, services);
  const read = services.allRows || allRows;
  if (!ctx.buscasBases.has(read)) ctx.buscasBases.set(read, loadBuscasBaseNow(ctx, services).catch((error) => { ctx.buscasBases.delete(read); throw error; }));
  return ctx.buscasBases.get(read);
}
async function loadBuscasBaseNow(ctx, services = {}) {
  const read = services.allRows || allRows;
  const env = 'eq.' + ctx.environment;
  const [journeys, contacts, phones, refs, toggleStates, calcRuns, calcLinks, dispositions, messageLinks, messages] = await readBundle(ctx, 'buscas', read);
  const triage = await activeRows(ctx, read);
  const explicit = await refProof.loadExplicit(ctx, services.rpc || rpc).catch(() => null);
  const built = Date.now();
  const base = buildBuscasBase({ journeys, contacts, phones, refs, toggleStates, calcRuns, calcLinks, dispositions, messageLinks, messages, triage, explicit });
  base.profile.build = Date.now() - built;
  const attached = Date.now();
  const done = await require('./panel-request-demands').attach(ctx, base, read);
  (done.profile || base.profile).attach = Date.now() - attached;
  return done;
}
// Medição: tempo acumulado e chamadas de uma função da base (lido nos logs de tempo das listas).
function profiled(profile, name, fn) {
  return (...args) => { const at = Date.now(); try { return fn(...args); } finally { const entry = profile[name] || (profile[name] = { ms: 0, calls: 0 }); entry.ms += Date.now() - at; entry.calls += 1; } };
}

function buildBuscasBase(input) {
  const profile = {}, step = (name, at) => { profile[name] = Date.now() - at; };
  let at = Date.now();
  const stateByJourney = new Map((input.toggleStates || []).map((state) => [state.journey_id, state]));
  const contactsById = new Map((input.contacts || []).map((row) => [row.id, row]));
  // Triagem: a ficha cuja conversa ficou fora do funil não entra em BUSCAS; demandas e matches não mudam.
  const triageOut = outOfFunnelJourneys(input.triage || [], input.journeys || [], input.refs || []);
  const journeys = (input.journeys || []).map((journey) => {
    const state = stateByJourney.get(journey.id);
    const item = { ...journey, enabled: toggleEnabled(journey.status, state), toggleManaged: Boolean(state), offReason: state && state.off_reason || null, contact: contactsById.get(journey.contact_id) || null, triageOut: triageOut.has(journey.id) };
    return { ...item, reactivationEligible: reactivationEligible(item) };
  });
  const refs = input.refs || [];
  step('journeys', at); at = Date.now();
  const modeItems = consolidateCalcRuns(input.calcRuns || [], input.calcLinks || []);
  step('modeItems', at); at = Date.now();
  const grouped = groupCalculatorByRef(modeItems, input.dispositions || []);
  step('grouped', at); at = Date.now();
  const demands = buildSearchDemands({ journeys, refs, modeItems });
  step('demands', at); at = Date.now();
  const contact = contactIndex({ calcRuns: input.calcRuns || [], messages: (input.messages || []).filter((message) => !message.undone_at), messageLinks: input.messageLinks || [] });
  step('contactIndex', at); at = Date.now();
  contact.facts = profiled(profile, 'facts', contact.facts);
  const personDisposition = dispositionIndex(input.dispositions || []);
  const refsOf = profiled(profile, 'refsOf', (journey) => refs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code));
  const journeyById = new Map(journeys.map((journey) => [journey.id, journey]));
  const groupedByRef = new Map(grouped.map((order) => [upper(order.ref), order]));
  const phonesFor = profiled(profile, 'phonesFor', (contactId) => (input.phones || []).filter((row) => row.contact_id === contactId));
  const primaryPhone = (contactId) => {
    const values = phonesFor(contactId).filter((row) => row.is_current !== false);
    const phone = values.find((row) => row.is_primary) || values[0];
    return phone ? phone.phone_e164 || phone.phone_raw || null : null;
  };
  const journeyDisposition = profiled(profile, 'journeyDisposition', (journey) => personDisposition(journey.id, [journey.reference_code, ...refsOf(journey)].filter(Boolean)));
  const journeyEntered = profiled(profile, 'journeyEntered', (journey) => contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: refsOf(journey) }).entered);
  const orderEntered = (ref) => contact.facts({ ref }).entered;
  // The calculator Ref shown on screen: the same proof as the ficha detail (a code without it is the ficha's internal code).
  const runRefs = refProof.runRefsOf(input.calcRuns || []);
  step('rest', at);
  const calcRefOf = profiled(profile, 'calcRefOf', (journey) => refProof.proofFor({ journey, linkedRefs: refsOf(journey), runRefs, explicit: input.explicit && input.explicit.get(journey.id) || [] }).calcRef);
  return { ...input, journeys, journeyById, refs, refsOf, modeItems, grouped, groupedByRef, demands, contact, personDisposition, journeyDisposition, journeyEntered, orderEntered, contactsById, phonesFor, primaryPhone, calcRefOf, profile };
}

// The person behind a demand, as BUSCAS shows it.
function demandPerson(base, demand) {
  if (demand.journeyId) {
    const journey = base.journeyById.get(demand.journeyId);
    return { journeyId: demand.journeyId, name: journey && journey.contact && journey.contact.display_name || `Pedido ${journey && journey.reference_code || '—'}`, phone: journey ? base.primaryPhone(journey.contact_id) : null, ref: journey && (journey.reference_code || base.refsOf(journey)[0]) || null , calcRef: journey && base.calcRefOf ? base.calcRefOf(journey) : null };
  }
  const order = base.groupedByRef.get(upper(demand.ref));
  // A Ref without a ficha is a calculator order: its Ref is the simulation itself.
  return { journeyId: null, name: order && order.contactName || `Pedido ${demand.ref}`, phone: null, ref: demand.ref, calcRef: demand.ref || null };
}

// Only what the browser needs to match a car against a demand (never a person's data).
function matchTarget(demand, extra = {}) {
  return { key: demand.key, mode: demand.mode, targetType: demand.targetType, journeyId: demand.journeyId || null, ref: demand.ref || null, wishes: demand.activeWishes, bidCents: demand.bidCents || null, acceptAnyTitleCondition: demand.acceptAnyTitleCondition === true, ...extra };
}

// One stored match against today's demands of its target. A match with a mode is checked
// against that mode only; a historical match without a mode is checked against each mode of
// its target and appears only where it still fits today's rule. A car that no longer fits is
// never shown as compatible.
function liveMatchesFor(match, demandsOfTarget) {
  const parsed = match && match.vehicle_json && match.vehicle_json.parsed || {};
  const mode = vehicleMatch.normalizedMode(match && match.logical_mode);
  return (demandsOfTarget || []).filter((demand) => demand.active && (!mode || demand.mode === mode)).flatMap((demand) => {
    const result = matchManheimDemand(parsed, { ...demand, wishes: demand.activeWishes, allowBudgetFallback: parsed.budgetFallback === true && parsed.criteriaHash === require('./panel-manheim-batch').criteriaHash({ ...demand, wishes: demand.activeWishes }) });
    return result ? [{ ...match, logical_mode: demand.mode, demandKey: demand.key, match_kind: result.kind, match_reason: result.reason || result.notice || null, mmr_status: result.mmrStatus || null, bidCents: demand.mode === 'VALOR' ? demand.bidCents || null : null, historicalMode: !mode }] : [];
  });
}

function reviewItem(base, demand) {
  const identityNeedsResolution = (demand.issues || []).some((issue) => issue.code === 'REF_AMBIGUOUS');
  return { key: demand.key, mode: demand.mode, targetType: demand.targetType, ...demandPerson(base, demand), issues: demand.issues, manual: demand.manual === true, wishes: demand.manual ? demand.wishes : undefined, canDefineMode: demand.mode === 'REVIEW' && Boolean(demand.journeyId) && !identityNeedsResolution,
    // A4: POR VALOR without the maximum bid on a ficha: the operator can type it here.
    canSetBid: demand.mode === 'VALOR' && Boolean(demand.journeyId) && !identityNeedsResolution && (demand.issues || []).some((issue) => issue.code === 'BID_MISSING') };
}

module.exports = { buildBuscasBase, demandPerson, liveMatchesFor, loadBuscasBase, matchTarget, reviewItem, upper };

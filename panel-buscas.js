'use strict';

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
  const read = services.allRows || allRows;
  const env = 'eq.' + ctx.environment;
  const [journeys, contacts, phones, refs, toggleStates, calcRuns, calcLinks, dispositions, messageLinks, messages] = await Promise.all([
    read(ctx, 'journeys', { select: 'id,contact_id,reference_code,source,stage,status,criteria_json,budget_cents,confirmed_total_ceiling_cents,payment_text,customer_deadline_text,qualified_at,closed_at,vehicle_text,created_at,updated_at', environment: env, order: 'updated_at.desc' }),
    read(ctx, 'contacts', { select: 'id,display_name,is_lead,location_text', environment: env }),
    read(ctx, 'contact_phones', { select: 'contact_id,phone_e164,phone_raw,phone_owner,is_primary,is_current', environment: env }),
    read(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: env }),
    read(ctx, 'journey_toggle_states', { select: 'journey_id,enabled,off_reason,switched_at', environment: env }),
    read(ctx, 'calc_runs', { select: 'id,created_at,zip,estado,lance,pagamento,dados,is_test', order: 'created_at.asc' }),
    read(ctx, 'calculator_request_links', { select: 'calc_sid,calc_ref,logical_mode,contact_id,journey_id', environment: env }),
    read(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status,discard_reason,updated_at', environment: env, cleared_at: 'is.null' }),
    read(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: env, undone_at: 'is.null' }),
    read(ctx, 'messages', { select: 'id,direction,occurred_at_utc,occurred_at_local,source_kind,created_at,undone_at', environment: env })
  ]);
  const triage = await activeRows(ctx, read);
  const explicit = await refProof.loadExplicit(ctx, services.rpc || rpc).catch(() => null);
  return buildBuscasBase({ journeys, contacts, phones, refs, toggleStates, calcRuns, calcLinks, dispositions, messageLinks, messages, triage, explicit });
}

function buildBuscasBase(input) {
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
  const modeItems = consolidateCalcRuns(input.calcRuns || [], input.calcLinks || []);
  const grouped = groupCalculatorByRef(modeItems, input.dispositions || []);
  const demands = buildSearchDemands({ journeys, refs, modeItems });
  const contact = contactIndex({ calcRuns: input.calcRuns || [], messages: (input.messages || []).filter((message) => !message.undone_at), messageLinks: input.messageLinks || [] });
  const personDisposition = dispositionIndex(input.dispositions || []);
  const refsOf = (journey) => refs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code);
  const journeyById = new Map(journeys.map((journey) => [journey.id, journey]));
  const groupedByRef = new Map(grouped.map((order) => [upper(order.ref), order]));
  const phonesFor = (contactId) => (input.phones || []).filter((row) => row.contact_id === contactId);
  const primaryPhone = (contactId) => {
    const values = phonesFor(contactId).filter((row) => row.is_current !== false);
    const phone = values.find((row) => row.is_primary) || values[0];
    return phone ? phone.phone_e164 || phone.phone_raw || null : null;
  };
  const journeyDisposition = (journey) => personDisposition(journey.id, [journey.reference_code, ...refsOf(journey)].filter(Boolean));
  const journeyEntered = (journey) => contact.facts({ journeyId: journey.id, ref: journey.reference_code, refs: refsOf(journey) }).entered;
  const orderEntered = (ref) => contact.facts({ ref }).entered;
  // The calculator Ref shown on screen: the same proof as the ficha detail (a code without it is the ficha's internal code).
  const runRefs = refProof.runRefsOf(input.calcRuns || []);
  const calcRefOf = (journey) => refProof.proofFor({ journey, linkedRefs: refsOf(journey), runRefs, explicit: input.explicit && input.explicit.get(journey.id) || [] }).calcRef;
  return { ...input, journeys, journeyById, refs, refsOf, modeItems, grouped, groupedByRef, demands, contact, personDisposition, journeyDisposition, journeyEntered, orderEntered, contactsById, phonesFor, primaryPhone, calcRefOf };
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
  return { key: demand.key, mode: demand.mode, targetType: demand.targetType, journeyId: demand.journeyId || null, ref: demand.ref || null, wishes: demand.activeWishes, bidCents: demand.mode === 'VALOR' ? demand.bidCents : null, ...extra };
}

// One stored match against today's demands of its target. A match with a mode is checked
// against that mode only; a historical match without a mode is checked against each mode of
// its target and appears only where it still fits today's rule. A car that no longer fits is
// never shown as compatible.
function liveMatchesFor(match, demandsOfTarget) {
  const parsed = match && match.vehicle_json && match.vehicle_json.parsed || {};
  const mode = vehicleMatch.normalizedMode(match && match.logical_mode);
  return (demandsOfTarget || []).filter((demand) => demand.active && (!mode || demand.mode === mode)).flatMap((demand) => {
    const result = matchManheimDemand(parsed, { ...demand, wishes: demand.activeWishes });
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

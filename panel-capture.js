'use strict';

const { contactIndex, clickChannel, refOf } = require('./panel-contact');
const { consolidateCalcRuns, groupCalculatorByRef } = require('./panel-domain');

const REF = /^[A-HJ-NP-Z2-9]{5}$/;

function refsFor(journey, refs) {
  return [journey.reference_code, ...refs.filter((row) => row.journey_id === journey.id).map((row) => row.ref_code)]
    .filter(Boolean).map((value) => String(value).trim().toUpperCase());
}

function auditCapture({ calcRuns = [], messages = [], messageLinks = [], dispositions = [], journeys = [], refs = [], contacts = [] } = {}) {
  const index = contactIndex({ calcRuns, messages: messages.filter((message) => !message.undone_at), messageLinks });
  const contactById = new Map(contacts.map((row) => [row.id, row]));
  const journeyByRef = new Map();
  for (const journey of journeys) for (const ref of refsFor(journey, refs)) journeyByRef.set(ref, journey);
  const discarded = new Set(dispositions.filter((row) => row.item_kind === 'REF' && row.status === 'DISCARDED').map((row) => String(row.item_key || '').trim().toUpperCase()));
  const grouped = new Set(groupCalculatorByRef(consolidateCalcRuns(calcRuns, []), dispositions).map((row) => row.ref));
  const clicked = new Set(calcRuns.filter((row) => row.is_test !== true && clickChannel(row)).map(refOf).filter((ref) => REF.test(ref)));
  const missing = [];
  for (const ref of clicked) {
    const journey = journeyByRef.get(ref);
    if (discarded.has(ref) || (journey && contactById.get(journey.contact_id)?.is_lead === false)) continue;
    const facts = index.facts({ journeyId: journey?.id, ref, refs: journey ? refsFor(journey, refs) : [] });
    // A WhatsApp click after the permanent global cutover is intentionally
    // excluded, so it must not produce a false red capture alert.
    if (facts.entered && !grouped.has(ref)) missing.push(ref);
  }
  return { checkedAt: new Date().toISOString(), missingRefs: missing.sort(), candidateCount: clicked.size };
}

async function runCaptureCheck(ctx) {
  const { allRows, supabase } = require('./panel-server');
  const [calcRuns, messages, messageLinks, dispositions, journeys, refs, contacts] = await Promise.all([
    allRows(ctx, 'calc_runs', { select: 'id,created_at,dados,is_test', order: 'created_at.asc' }),
    allRows(ctx, 'messages', { select: 'id,direction,source_kind,occurred_at_utc,occurred_at_local,created_at,undone_at', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'message_journeys', { select: 'journey_id,message_id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_item_dispositions', { select: 'item_kind,item_key,status', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journeys', { select: 'id,contact_id,reference_code', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'journey_refs', { select: 'journey_id,ref_code', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'contacts', { select: 'id,is_lead', environment: 'eq.' + ctx.environment })
  ]);
  const result = auditCapture({ calcRuns, messages, messageLinks, dispositions, journeys, refs, contacts });
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/panel_capture_checks?on_conflict=environment', { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ environment: ctx.environment, checked_at: result.checkedAt, missing_count: result.missingRefs.length, missing_refs: result.missingRefs, error_code: null, failed_at: null }) });
  return result;
}

async function recordCaptureFailure(ctx, code) {
  const { supabase } = require('./panel-server');
  await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/panel_capture_checks?on_conflict=environment', { method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify({ environment: ctx.environment, missing_count: 0, missing_refs: [], error_code: String(code || 'CAPTURE_CHECK_FAILED').slice(0, 80), failed_at: new Date().toISOString() }) });
}

module.exports = { auditCapture, runCaptureCheck, recordCaptureFailure };

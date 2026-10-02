'use strict';
// Toda mensagem da calculadora termina em exatamente um destino (panel_calc_message_route), retomável e idempotente:
//   1. Ref escrita ("Ref: XXXXX") -> a ficha dessa Ref (se a Ref é de outro contato, ou de várias fichas: fila)
//   2. sem Ref legível (ou Ref ainda sem ficha) -> o telefone: uma ficha e zero contradição de nome/carro liga
//   3. telefone sem ficha -> ficha nova
//   4. o resto -> fila dela, com motivo escrito e evidência (candidatas, Ref, telefone)
// Similaridade (carro, valor, horário) nunca liga nada sozinha. "Ref: -----" nunca vira Ref.
const { rows, supabase } = require('./panel-server');
const calcMessage = require('./panel-calc-message');
const phoneLink = require('./panel-phone-link');

const RULE_VERSION = 1;
const REASONS = {
  REF_ENCONTRADA: 'A Ref escrita na mensagem é desta ficha',
  REF_DE_OUTRO_CONTATO: 'A Ref escrita na mensagem é da ficha de outro contato: confirme quem é',
  REF_EM_VARIAS_FICHAS: 'A Ref escrita na mensagem aparece em mais de uma ficha',
  TELEFONE_FICHA_UNICA: 'Sem Ref legível: o telefone tem uma ficha só e nada contradiz',
  FICHA_NOVA_TELEFONE_NOVO: 'Telefone sem ficha: ficha nova criada',
  FILA_VARIAS_FICHAS: 'O telefone tem mais de uma ficha: escolha a ficha (nada foi escolhido sozinho)',
  FILA_CONTRADICAO: 'O nome ou o carro da mensagem contradiz a única ficha do telefone',
  SEM_CONTATO: 'A conversa não tem contato nem telefone para seguir',
  REF_ILEGIVEL: 'Ref ilegível na origem ("Ref: -----"): seguiu pelo telefone'
};

// facts: { parsed, refOwners: [{id, contact_id}], contactId, fichas: [{id, contactName, vehicleText}], linked: [journeyId] }
function decide({ parsed, refOwners = [], contactId = null, fichas = [], linked = [] }) {
  const evidence = { refState: parsed.refState, ref: parsed.ref, refSource: parsed.refState === 'REF' ? parsed.refSource || 'TEXTO' : null, diagnosis: parsed.diagnosis, name: parsed.name || null, vehicle: parsed.vehicle || null,
    candidates: fichas.map((ficha) => ficha.id), linkedBefore: linked };
  const base = { refState: parsed.refState, ref: parsed.refState === 'REF' ? parsed.ref : null, evidence };
  if (parsed.refState === 'REF' && refOwners.length) {
    const owners = [...new Map(refOwners.map((owner) => [owner.id, owner])).values()];
    if (owners.length > 1) return { ...base, destination: 'FILA', reason: 'REF_EM_VARIAS_FICHAS', journeyId: null, unlinkAuto: true, evidence: { ...evidence, candidates: owners.map((owner) => owner.id) } };
    const [owner] = owners;
    if (contactId && owner.contact_id && owner.contact_id !== contactId) return { ...base, destination: 'FILA', reason: 'REF_DE_OUTRO_CONTATO', journeyId: null, unlinkAuto: true, evidence: { ...evidence, candidates: [owner.id, ...fichas.map((ficha) => ficha.id)] } };
    return { ...base, destination: 'LIGADA_REF', reason: 'REF_ENCONTRADA', journeyId: owner.id, link: true };
  }
  // No readable Ref, or a Ref no ficha owns yet: the phone decides (one ficha, zero contradiction).
  if (!contactId) return { ...base, destination: 'FILA', reason: 'SEM_CONTATO', journeyId: null };
  const verdict = phoneLink.decide({ fichas, values: { name: parsed.name, message: parsed.vehicle } });
  const ilegivel = parsed.refState === 'REF_ILEGIVEL' ? { refIlegivel: true } : {};
  if (verdict.action === 'LINK') return { ...base, evidence: { ...evidence, ...ilegivel }, destination: 'LIGADA_TELEFONE', reason: 'TELEFONE_FICHA_UNICA', journeyId: verdict.journeyId, link: true };
  if (verdict.action === 'QUARANTINE') return { ...base, evidence: { ...evidence, ...ilegivel }, destination: 'NOVA_FICHA', reason: 'FICHA_NOVA_TELEFONE_NOVO', journeyId: null, create: true };
  return { ...base, evidence: { ...evidence, ...ilegivel, conflicts: verdict.conflicts || [] }, destination: 'FILA', reason: verdict.reason, journeyId: null, unlinkAuto: true };
}

const rpc = (ctx, name, body) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_environment: ctx.environment, ...body }) });

async function factsFor(ctx, message, read = rows) {
  const parsed = calcMessage.parse(message.body_text);
  const env = 'eq.' + ctx.environment;
  let refOwners = [];
  if (parsed.refState === 'REF') {
    const [byCode, byLink] = await Promise.all([
      read(ctx, 'journeys', { select: 'id,contact_id', environment: env, reference_code: 'eq.' + parsed.ref, limit: '5' }),
      read(ctx, 'journey_refs', { select: 'journey_id', environment: env, ref_code: 'eq.' + parsed.ref, limit: '5' })
    ]);
    const linkedIds = byLink.map((row) => row.journey_id).filter((id) => !byCode.some((row) => row.id === id));
    const extra = linkedIds.length ? await read(ctx, 'journeys', { select: 'id,contact_id', environment: env, id: 'in.(' + linkedIds.join(',') + ')' }) : [];
    refOwners = [...byCode, ...extra];
  }
  let fichas = [];
  if (message.contact_id) {
    const [journeys, contacts] = await Promise.all([
      read(ctx, 'journeys', { select: 'id,vehicle_text', environment: env, contact_id: 'eq.' + message.contact_id, limit: '20' }),
      read(ctx, 'contacts', { select: 'id,display_name', environment: env, id: 'eq.' + message.contact_id, limit: '1' })
    ]);
    fichas = journeys.map((row) => ({ id: row.id, contactName: contacts[0] && contacts[0].display_name || '', vehicleText: row.vehicle_text || '' }));
  }
  return { parsed, refOwners, contactId: message.contact_id || null, fichas, linked: message.linked_journeys || [] };
}

async function routeOne(ctx, message, deps = {}) {
  const facts = await (deps.factsFor || factsFor)(ctx, message);
  // (d) The text lost the Ref line but the print it was read from shows it: that Ref counts, and says where it came from.
  if (facts.parsed.refState !== 'REF' && calcMessage.REF_RE.test(String(message.print_ref || ''))) {
    facts.parsed = { ...facts.parsed, refState: 'REF', ref: String(message.print_ref).toUpperCase(), refSource: 'PRINT' };
    if (!deps.factsFor) Object.assign(facts, await factsFor(ctx, { ...message, body_text: message.body_text + '\nRef: ' + facts.parsed.ref }), { parsed: facts.parsed });
  }
  const verdict = decide(facts);
  const call = deps.rpc || rpc;
  const result = await call(ctx, 'panel_calc_route_apply', {
    p_message_id: message.message_id, p_destination: verdict.destination, p_reason: verdict.reason, p_ref_state: verdict.refState, p_ref: verdict.ref,
    p_journey_id: verdict.journeyId, p_evidence: verdict.evidence, p_rule_version: RULE_VERSION, p_link: Boolean(verdict.link), p_create: Boolean(verdict.create),
    p_unlink_auto: Boolean(verdict.unlinkAuto), p_ref_source: verdict.evidence.refSource || null
  });
  return { ...verdict, result };
}

// Resumable sweep: messages without a destination in this rule first, then queue items to look at again.
async function routeCalculatorMessages(ctx, { max = 60, deadlineAt = Date.now() + 20000, deps = {} } = {}) {
  const call = deps.rpc || rpc;
  const pending = await call(ctx, 'panel_calc_route_pending', { p_rule_version: RULE_VERSION, p_limit: max });
  const summary = { examined: (pending || []).length, LIGADA_REF: 0, LIGADA_TELEFONE: 0, NOVA_FICHA: 0, FILA: 0, skipped: 0, failed: 0 };
  for (const message of pending || []) {
    if (Date.now() > deadlineAt) break;
    try {
      const outcome = await routeOne(ctx, message, deps);
      if (outcome.result && outcome.result.skipped) summary.skipped += 1; else summary[outcome.destination] += 1;
    } catch (error) { summary.failed += 1; console.error('[calc-route]', { message: message.message_id, error: String(error && error.message || 'UNKNOWN') }); }
  }
  return summary;
}

// The queue for the panel: every message the rule did not decide, with the reason and the candidate fichas.
async function loadQueue(ctx, read = rows) {
  const env = 'eq.' + ctx.environment;
  const queued = await read(ctx, 'panel_calc_message_route', { select: 'message_id,reason,ref_state,ref,evidence,updated_at', environment: env, destination: 'eq.FILA', order: 'updated_at.desc', limit: '300' });
  if (!queued.length) return [];
  const ids = queued.map((row) => row.message_id);
  const messages = await read(ctx, 'messages', { select: 'id,body_text,channel,occurred_at_utc,created_at,chat_id', environment: env, id: 'in.(' + ids.join(',') + ')' });
  const candidateIds = [...new Set(queued.flatMap((row) => (row.evidence && row.evidence.candidates) || []))];
  const journeys = candidateIds.length ? await read(ctx, 'journeys', { select: 'id,contact_id,reference_code,vehicle_text', environment: env, id: 'in.(' + candidateIds.join(',') + ')' }) : [];
  const contactIds = [...new Set(journeys.map((row) => row.contact_id))];
  const contacts = contactIds.length ? await read(ctx, 'contacts', { select: 'id,display_name', environment: env, id: 'in.(' + contactIds.join(',') + ')' }) : [];
  const byMessage = new Map(messages.map((row) => [row.id, row]));
  return queued.map((row) => {
    const message = byMessage.get(row.message_id) || {};
    const candidates = ((row.evidence && row.evidence.candidates) || []).map((id) => { const journey = journeys.find((item) => item.id === id) || { id }; const contact = contacts.find((item) => item.id === journey.contact_id); return { journeyId: id, name: contact ? contact.display_name : null, ref: journey.reference_code || null, vehicle: journey.vehicle_text || null }; });
    return { messageId: row.message_id, reason: row.reason, reasonText: REASONS[row.reason] || row.reason, refState: row.ref_state, ref: row.ref, evidence: row.evidence || {}, at: message.occurred_at_utc || message.created_at || row.updated_at,
      channel: message.channel || null, text: String(message.body_text || '').slice(0, 600), candidates };
  });
}

module.exports = { RULE_VERSION, REASONS, decide, factsFor, routeOne, routeCalculatorMessages, loadQueue };

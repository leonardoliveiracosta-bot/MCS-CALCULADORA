'use strict';

// Identidade por Ref, em andamento no sistema (não uma análise única). Para cada ficha o cron reúne as provas
// (migração 20261016020000), decide com regras determinísticas e grava o resultado:
//  - REF_COMPROVADA: a Ref está numa simulação, na mensagem da calculadora que o cliente escreveu ("Ref: XXXXX")
//    ou num print confirmado; a Ref é ligada à ficha (uma vez, nunca a de outra ficha)
//  - CALCULADORA_REF_A_RECUPERAR: há mensagem do modelo da calculadora, mas nenhuma Ref recuperável
//  - SEM_ORIGEM_CALCULADORA: nada indica a calculadora
//  - CONFLITO: a Ref escrita já pertence a outra ficha (nada é ligado; fica para revisão com a evidência)
// Nome ou carro parecidos nunca ligam nada. A Ref de uma mensagem sem Ref só é recuperada pelo desempate escrito: 1) a que o
// cliente escreveu, 2) a simulação da mesma janela de tempo, 3) a de critérios idênticos; empate vai para a fila com as candidatas. Reavalia só quando as provas mudam, retoma de
// onde parou e repetir não duplica (ver panel_identity_apply).
const crypto = require('node:crypto');
const refProof = require('./panel-ref-proof');
const { allRows, patchRows, supabase } = require('./panel-server');

const RULE_VERSION = 1;
const REF_RE = /^[A-HJ-NP-Z2-9]{5}$/;
const up = (value) => String(value || '').trim().toUpperCase();
const STATUS = ['REF_COMPROVADA', 'CALCULADORA_REF_A_RECUPERAR', 'SEM_ORIGEM_CALCULADORA', 'CONFLITO'];

function decide(evidence) {
  const here = evidence.journey_id;
  const code = up(evidence.reference_code);
  const linked = (evidence.linked_refs || []).map(up);
  const written = (evidence.explicit || []).filter((entry) => REF_RE.test(up(entry.ref)));
  const prints = (evidence.print_refs || []).map(up).filter((ref) => REF_RE.test(ref));
  const runs = new Set((evidence.run_refs || []).map(up));
  const owners = evidence.owners || {};
  const own = new Set([code, ...linked].filter((ref) => REF_RE.test(ref)));
  const others = (ref) => (owners[ref] || []).filter((id) => id !== here);
  const candidates = new Map();
  const add = (ref, source, messageId) => {
    const key = up(ref);
    if (!candidates.has(key)) candidates.set(key, { sources: new Set(), messageId: null });
    const entry = candidates.get(key);
    entry.sources.add(source);
    if (messageId && !entry.messageId) entry.messageId = messageId;
  };
  // A Ref written in a message binds only when it was typed in capitals (the calculator writes it that way) or a simulation of that
  // Ref exists: a common word after "ref:" ("ref: Camry") is never a Ref. Without that proof it stays a plain candidate.
  written.forEach((entry) => { if (runs.has(up(entry.ref)) || String(entry.raw || entry.ref) === up(entry.ref)) add(entry.ref, 'MENSAGEM', entry.messageId); });
  prints.forEach((ref) => add(ref, 'PRINT', null));
  // Ref recovered by the written tie-break (same time window, then identical criteria): the simulation exists by construction.
  (evidence.recovered || []).filter((entry) => REF_RE.test(up(entry.ref))).forEach((entry) => { runs.add(up(entry.ref)); add(entry.ref, 'RECUPERADA_' + String(entry.by || 'JANELA').toUpperCase(), entry.messageId || null); });
  // Refs the Claude found: only those whose quotation was checked word for word against the message (panel-subject).
  const claudeRefs = (evidence.claude_refs || []).filter((entry) => entry && entry.verified === true && REF_RE.test(up(entry.ref)));
  // A Ref the Claude found is stronger-checked: it must also exist as a simulation of the calculator.
  claudeRefs.filter((entry) => runs.has(up(entry.ref))).forEach((entry) => add(entry.ref, 'CLAUDE', entry.messageId));
  const linkRefs = [], messageIds = [], conflicts = [], proven = new Set();
  for (const [ref, entry] of candidates) {
    if (own.has(ref)) { proven.add(ref); continue; }
    if (others(ref).length) { conflicts.push({ ref, sources: [...entry.sources], owners: others(ref) }); continue; }
    linkRefs.push(ref); messageIds.push(entry.messageId); proven.add(ref);
  }
  [...own].filter((ref) => runs.has(ref)).forEach((ref) => proven.add(ref));
  const refs = [...proven].sort();
  const status = refs.length ? 'REF_COMPROVADA' : conflicts.length ? 'CONFLITO' : evidence.template ? 'CALCULADORA_REF_A_RECUPERAR' : 'SEM_ORIGEM_CALCULADORA';
  return {
    status, calcOrigin: status !== 'SEM_ORIGEM_CALCULADORA' || Boolean(evidence.template), refs, linkRefs, messageIds,
    conflict: conflicts.length ? { conflicts } : (!refs.length && evidence.tie && evidence.tie.length > 1 ? { tie: evidence.tie } : null),
    evidence: { claude: claudeRefs.map((entry) => ({ ref: up(entry.ref), messageId: entry.messageId || null, quote: entry.quote || null })), written: written.map((entry) => ({ ref: up(entry.ref), mode: entry.mode || null, messageId: entry.messageId || null })), prints, runs: [...runs].sort(), template: Boolean(evidence.template), recovered: (evidence.recovered || []).map((entry) => ({ ref: up(entry.ref), by: entry.by || null })) }
  };
}

// The same proofs, the same rule version: nothing to redo.
function hashOf(evidence) {
  const stable = [RULE_VERSION, up(evidence.reference_code), [...(evidence.linked_refs || [])].map(up).sort(),
    (evidence.explicit || []).map((entry) => [up(entry.ref), entry.raw || null, entry.messageId || null]).sort(), [...(evidence.print_refs || [])].map(up).sort(),
    Boolean(evidence.template), Number(evidence.message_count || 0), (evidence.recovered || []).map((entry) => up(entry.ref)).sort(), (evidence.tie || []).map((entry) => up(entry.ref)).sort(), [...(evidence.run_refs || [])].map(up).sort(), evidence.owners || {},
    (evidence.claude_refs || []).filter((entry) => entry && entry.verified === true).map((entry) => [up(entry.ref), entry.messageId || null]).sort()];
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

// ---- Ref recovery for a calculator-model message without a Ref (written tie-break, never a guess) -------------------
// 1. the Ref the client wrote is handled by decide() and never reaches here;
// 2. the simulations made in the same time window (panel_calc_run_candidates);
// 3. among those, the ones with criteria identical to the message (maximum bid, make, ZIP);
// a persistent tie goes to a queue with every candidate side by side. A candidate that already belongs to another ficha never counts.
const digits = (value) => String(value == null ? '' : value).replace(/[^0-9]/g, '');
function messageCriteria(text) {
  const body = String(text || '');
  const bid = (body.match(/(?:maximum bid|lance m[aá]ximo|puja m[aá]xima)[^0-9\n]{0,20}([0-9][0-9.,]*)/i) || [])[1];
  const zip = (body.match(/\b(\d{5})\b/) || [])[1];
  return { bid: bid ? Number(digits(String(bid).replace(/[.,]\d{1,2}$/, ''))) || null : null, zip: zip || null, text: body.toLowerCase() };
}
// IDENTICO: every comparable field equals; CONTRADIZ: one comparable field differs; INCOMPLETO: nothing comparable.
function criteriaMatch(dados, criteria) {
  const row = dados || {}, checks = [];
  const bid = Number(digits(row.lance)) || null;
  if (criteria.bid && bid) checks.push(criteria.bid === bid);
  const make = String(row.marca || '').trim().toLowerCase(), model = String(row.modelo || '').trim().toLowerCase();
  if (make) checks.push(criteria.text.includes(make));
  if (model) checks.push(criteria.text.includes(model));
  const zip = String(row.zip || '').trim();
  if (criteria.zip && /^\d{5}$/.test(zip)) checks.push(criteria.zip === zip);
  if (!checks.length) return 'INCOMPLETO';
  return checks.every(Boolean) ? 'IDENTICO' : 'CONTRADIZ';
}
function recoverRef({ text, candidates = [], owners = {}, here = null } = {}) {
  const taken = (ref) => (owners[up(ref)] || []).some((id) => id !== here);
  const free = [...new Map(candidates.filter((entry) => REF_RE.test(up(entry.ref)) && !taken(entry.ref)).map((entry) => [up(entry.ref), entry])).values()];
  if (!free.length) return { outcome: 'NONE' };
  const criteria = messageCriteria(text);
  const graded = free.map((entry) => ({ ref: up(entry.ref), match: criteriaMatch(entry.dados, criteria), firstAt: entry.first_at || null, dados: entry.dados || null }));
  const usable = graded.filter((entry) => entry.match !== 'CONTRADIZ');
  // A lone candidate in the window binds only when its criteria also match: a time coincidence alone never invents a Ref.
  if (usable.length === 1) return usable[0].match === 'IDENTICO' ? { outcome: 'RECOVERED', ref: usable[0].ref, by: 'janela', candidates: graded } : { outcome: 'NONE', suggested: usable[0].ref, candidates: graded };
  const identical = usable.filter((entry) => entry.match === 'IDENTICO');
  if (usable.length > 1 && identical.length === 1) return { outcome: 'RECOVERED', ref: identical[0].ref, by: 'criterios', candidates: graded };
  if (usable.length > 1) return { outcome: 'TIE', candidates: usable };
  return { outcome: 'NONE', candidates: graded };
}
const rpc = (ctx, name, body) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// The earliest calculator-model message of the ficha and the simulations of its time window. Read only; null when nothing to decide.
async function recover(ctx, item, call, deps) {
  const load = deps.loadTemplateMessage || loadTemplateMessage;
  const message = await load(ctx, item.journey_id);
  if (!message || !message.at) return null;
  const candidates = await call(ctx, 'panel_calc_run_candidates', { p_at: message.at, p_before_minutes: 30, p_after_minutes: 2 });
  const result = recoverRef({ text: message.text, candidates: candidates || [], owners: item.owners || {}, here: item.journey_id });
  if (result.outcome === 'RECOVERED') return { recovered: [{ ref: result.ref, by: result.by, messageId: message.id || null }], tie: null };
  if (result.outcome === 'TIE') return { recovered: [], tie: result.candidates.map((entry) => ({ ref: entry.ref, lance: entry.dados && entry.dados.lance || null, marca: entry.dados && entry.dados.marca || null, modelo: entry.dados && entry.dados.modelo || null, at: entry.firstAt })) };
  return null;
}
async function loadTemplateMessage(ctx, journeyId) {
  const links = await allRows(ctx, 'message_journeys', { select: 'message_id', environment: 'eq.' + ctx.environment, journey_id: 'eq.' + journeyId, undone_at: 'is.null' });
  const ids = links.map((row) => row.message_id).filter(Boolean);
  if (!ids.length) return null;
  const messages = await allRows(ctx, 'messages', { select: 'id,body_text,direction,occurred_at_utc,created_at', environment: 'eq.' + ctx.environment, id: 'in.(' + ids.join(',') + ')', direction: 'eq.CUSTOMER', undone_at: 'is.null' });
  const found = messages.filter((message) => refProof.isCalculatorTemplate(message.body_text)).sort((a, b) => Date.parse(a.occurred_at_utc || a.created_at) - Date.parse(b.occurred_at_utc || b.created_at))[0];
  return found ? { id: found.id, text: found.body_text, at: found.occurred_at_utc || found.created_at } : null;
}

// Evaluate one batch of fichas. Returns counters; safe to run again at any time.
async function evaluateJourneys(ctx, journeyIds, states, deps = {}) {
  const call = deps.rpc || rpc;
  const touch = deps.patchRows || patchRows;
  const evidence = await call(ctx, 'panel_identity_evidence', { p_environment: ctx.environment, p_journey_ids: journeyIds });
  const summary = { evaluated: 0, unchanged: 0, linked: 0, conflicts: 0, toRecover: 0, failed: 0 };
  for (const item of evidence || []) {
    try {
      const hash = hashOf(item), previous = states.get(item.journey_id);
      if (previous && previous.input_hash === hash && previous.rule_version === RULE_VERSION) {
        await touch(ctx, 'panel_identity_state', { environment: 'eq.' + ctx.environment, journey_id: 'eq.' + item.journey_id }, { updated_at: new Date().toISOString() });
        summary.unchanged += 1; continue;
      }
      let verdict = decide(item);
      if (verdict.status === 'CALCULADORA_REF_A_RECUPERAR') {
        const recovery = await recover(ctx, item, call, deps);
        if (recovery) { item.recovered = recovery.recovered; item.tie = recovery.tie; verdict = decide(item); }
      }
      const result = await call(ctx, 'panel_identity_apply', {
        p_environment: ctx.environment, p_journey_id: item.journey_id, p_rule_version: RULE_VERSION, p_hash: hash, p_status: verdict.status,
        p_calc_origin: verdict.calcOrigin, p_refs: verdict.refs, p_conflict: verdict.conflict, p_evidence: verdict.evidence,
        p_link_refs: verdict.linkRefs, p_message_ids: verdict.messageIds
      });
      summary.evaluated += 1;
      summary.linked += Array.isArray(result && result.linked) ? result.linked.length : 0;
      if (verdict.status === 'CONFLITO' || verdict.conflict) summary.conflicts += 1;
      if (verdict.status === 'CALCULADORA_REF_A_RECUPERAR') summary.toRecover += 1;
    } catch (error) { summary.failed += 1; console.error('[identity]', { journey: item.journey_id, message: String(error && error.message || 'UNKNOWN') }); }
  }
  return summary;
}

// Resumable sweep: fichas without a result first, then the least recently checked. max per cycle.
async function reconcileIdentity(ctx, { max = 120, deadlineAt = Date.now() + 25000, deps = {} } = {}) {
  const [journeys, stateRows] = await Promise.all([
    allRows(ctx, 'journeys', { select: 'id', environment: 'eq.' + ctx.environment }),
    allRows(ctx, 'panel_identity_state', { select: 'journey_id,input_hash,rule_version,updated_at', environment: 'eq.' + ctx.environment })
  ]);
  const states = new Map(stateRows.map((row) => [row.journey_id, row]));
  const order = journeys.map((row) => row.id).sort((left, right) => {
    const a = states.get(left), b = states.get(right);
    if (!a && !b) return 0; if (!a) return -1; if (!b) return 1;
    return Date.parse(a.updated_at) - Date.parse(b.updated_at);
  }).slice(0, max);
  const total = { journeys: journeys.length, withResult: stateRows.length, evaluated: 0, unchanged: 0, linked: 0, conflicts: 0, toRecover: 0, failed: 0 };
  for (let start = 0; start < order.length; start += 40) {
    if (Date.now() > deadlineAt) break;
    const part = await evaluateJourneys(ctx, order.slice(start, start + 40), states, deps);
    Object.keys(part).forEach((key) => { total[key] += part[key]; });
  }
  return total;
}

module.exports = { RULE_VERSION, STATUS, messageCriteria, criteriaMatch, recoverRef, decide, hashOf, evaluateJourneys, reconcileIdentity };

'use strict';

// Identidade por Ref, em andamento no sistema (não uma análise única). Para cada ficha o cron reúne as provas
// (migração 20261016020000), decide com regras determinísticas e grava o resultado:
//  - REF_COMPROVADA: a Ref está numa simulação, na mensagem da calculadora que o cliente escreveu ("Ref: XXXXX")
//    ou num print confirmado; a Ref é ligada à ficha (uma vez, nunca a de outra ficha)
//  - CALCULADORA_REF_A_RECUPERAR: há mensagem do modelo da calculadora, mas nenhuma Ref recuperável
//  - SEM_ORIGEM_CALCULADORA: nada indica a calculadora
//  - CONFLITO: a Ref escrita já pertence a outra ficha (nada é ligado; fica para revisão com a evidência)
// Nome, carro, horário ou critérios parecidos nunca ligam nada. Reavalia só quando as provas mudam, retoma de
// onde parou e repetir não duplica (ver panel_identity_apply).
const crypto = require('node:crypto');
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
  written.forEach((entry) => add(entry.ref, 'MENSAGEM', entry.messageId));
  prints.forEach((ref) => add(ref, 'PRINT', null));
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
    conflict: conflicts.length ? { conflicts } : null,
    evidence: { written: written.map((entry) => ({ ref: up(entry.ref), mode: entry.mode || null, messageId: entry.messageId || null })), prints, runs: [...runs].sort(), template: Boolean(evidence.template) }
  };
}

// The same proofs, the same rule version: nothing to redo.
function hashOf(evidence) {
  const stable = [RULE_VERSION, up(evidence.reference_code), [...(evidence.linked_refs || [])].map(up).sort(),
    (evidence.explicit || []).map((entry) => [up(entry.ref), entry.messageId || null]).sort(), [...(evidence.print_refs || [])].map(up).sort(),
    Boolean(evidence.template), Number(evidence.message_count || 0), [...(evidence.run_refs || [])].map(up).sort(), evidence.owners || {}];
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32);
}

const rpc = (ctx, name, body) => supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/' + name, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

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
      const verdict = decide(item);
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

module.exports = { RULE_VERSION, STATUS, decide, hashOf, evaluateJourneys, reconcileIdentity };

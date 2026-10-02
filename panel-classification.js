'use strict';

// O que o Claude e as regras já concluíram sobre cada ficha, para todas as abas lerem a mesma identificação:
//  identity: origem Calculadora comprovada / Ref a recuperar / conflito (panel_identity_state)
//  subject:  assunto atual da conversa (panel_conversation_class); a correção manual vale mais que a leitura
// Só leitura. Se as tabelas não puderem ser lidas, available=false e cada ficha sai com state INDISPONIVEL:
// nunca "Ainda não identificado" nem "Sem Ref" por causa de uma falha de carregamento.
const { allRows } = require('./panel-server');

const SUBJECT_KEYS = ['FINANCIAMENTO', 'PEDIDO_CARRO', 'SO_CUMPRIMENTO', 'OUTROS', 'NAO_IDENTIFICADO'];

const summariesOf = (row) => Array.isArray(row && row.request_summaries) ? row.request_summaries : [];
function subjectFromRow(row) {
  if (row && row.manual_subject && SUBJECT_KEYS.includes(row.manual_subject)) return { key: row.manual_subject, source: 'MANUAL', state: 'OK', reason: null, readAt: null, summaries: summariesOf(row) };
  if (row && row.classified_at && SUBJECT_KEYS.includes(row.subject)) return { key: row.subject, source: 'CLAUDE', state: 'OK', reason: row.reason || null, readAt: row.classified_at, summaries: summariesOf(row) };
  return { key: 'NAO_IDENTIFICADO', source: null, state: 'PENDENTE', reason: null, readAt: null };
}

function buildIndex(identityRows, classRows) {
  const identity = new Map((identityRows || []).map((row) => [row.journey_id, row]));
  const classes = new Map((classRows || []).map((row) => [row.journey_id, row]));
  return {
    available: true,
    identityOf: (journeyId) => { const row = journeyId && identity.get(journeyId); return row ? { status: row.status, calcOrigin: row.calc_origin === true, refs: row.refs || [], conflict: row.conflict || null, state: 'OK' } : { status: null, calcOrigin: false, refs: [], conflict: null, state: 'PENDENTE' }; },
    subjectOf: (journeyId) => subjectFromRow(journeyId ? classes.get(journeyId) : null)
  };
}

const UNAVAILABLE = Object.freeze({
  available: false,
  identityOf: () => ({ status: null, calcOrigin: false, refs: [], conflict: null, state: 'INDISPONIVEL' }),
  subjectOf: () => ({ key: null, source: null, state: 'INDISPONIVEL', reason: null, readAt: null })
});

async function loadClassification(ctx) {
  try {
    const [identityRows, classRows] = await Promise.all([
      allRows(ctx, 'panel_identity_state', { select: 'journey_id,status,calc_origin,refs,conflict', environment: 'eq.' + ctx.environment }),
      allRows(ctx, 'panel_conversation_class', { select: 'journey_id,subject,manual_subject,classified_at,reason,request_summaries', environment: 'eq.' + ctx.environment })
    ]);
    return buildIndex(identityRows, classRows);
  } catch (_) { return UNAVAILABLE; }
}

// What factsFor needs from the index for one ficha.
function factsOf(index, journeyId) {
  const source = index || UNAVAILABLE;
  return { identity: source.identityOf(journeyId), subject: source.subjectOf(journeyId) };
}

module.exports = { SUBJECT_KEYS, buildIndex, loadClassification, factsOf, subjectFromRow, UNAVAILABLE };

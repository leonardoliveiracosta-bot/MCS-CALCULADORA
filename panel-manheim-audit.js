'use strict';

// MANHEIM_MATCH_AUDIT: conferência dos matches do Manheim pela OpenAI, depois do upload do CSV e da
// distribuição determinística. Não substitui o matching determinístico, a desambiguação de linhas
// do CSV, a triagem da ENTRADA nem as funções da Anthropic.
//
// Regras fixas deste módulo:
//  * Uma conferência por demanda (pessoa + modo) do lote ativo. Primeiro o servidor checa os fatos
//    (ficha encerrada, contato não-lead, registro de teste, lote desfeito, match sem modo, VIN ou
//    linha repetida, demanda incompleta e a própria regra VALOR ou CARRO). Com divergência local a
//    demanda vai para REVISAR sem gastar chamada. Só as demais vão para a OpenAI.
//  * À OpenAI vão só: identificador interno ou Ref, modo, critérios, lance (VALOR) e marca, modelo,
//    ano, milhagem, MMR, VIN e lote dos matches da própria demanda. Nunca nome, telefone,
//    conversa, endereço ou documento, e nunca o CSV inteiro.
//  * Desligada por padrão: só com MANHEIM_MATCH_AUDIT_ENABLED=1 e OPENAI_API_KEY. Modelo fixo da
//    allowlist (gpt-6-luna); MANHEIM_MATCH_AUDIT_MODEL fora da allowlist desliga tudo.
//  * Até US$ 2 por importação. Acima disso nada é chamado: a estimativa aparece e espera
//    autorização. O mesmo lote, demanda, critérios, matches e versão da regra nunca são cobrados
//    duas vezes (hash único no banco, com a linha reservada antes da chamada).
//  * Falha, tempo esgotado ou resposta inválida: "Conferência pendente". Nada é aprovado em
//    silêncio; dá para tentar de novo ou aprovar à mão com motivo registrado.
//  * Com a função desligada nada muda: V1 e V2 seguem como antes.

const crypto = require('node:crypto');
const { insert, patchRows, rows, supabase } = require('./panel-server');
const { matchManheimDemand } = require('./panel-domain');
const { PRICES } = require('./panel-triage');

const RULE_VERSION = 'conferencia-v1';
const DEFAULT_MODEL = 'gpt-6-luna';
const APPROVED_MODELS = Object.freeze(['gpt-6-luna']);
const LIMIT_USD = 2;
const MAX_ATTEMPTS = 3;
const MAX_OPTIONS = 150;
const TIMEOUT_MS = 25000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const OK = Object.freeze(['CONFERIDO', 'APROVADO_MANUAL']);
const FINAL_ERRORS = new Set(['OPENAI_RESPONSE_INVALID']);

const CODES = Object.freeze({
  DEMAND_MISSING: 'demanda não encontrada',
  DEMAND_INCOMPLETE: 'demanda incompleta',
  MODE_MISSING: 'match sem modo',
  OTHER_MODE_MATCH: 'match de outro modo na demanda',
  PERSON_MISMATCH: 'match ligado a outra pessoa ou Ref',
  JOURNEY_CLOSED: 'ficha encerrada',
  NOT_LEAD: 'contato marcado como não-lead',
  TEST_RECORD: 'registro de teste',
  BATCH_UNDONE: 'lote desfeito',
  VIN_DUPLICATE: 'VIN repetido na mesma demanda',
  SPLIT_DUPLICATE: 'carro repetido entre as divisões do CSV',
  CRITERIA_MISMATCH: 'carro fora dos critérios da demanda',
  MAKE_MODEL: 'marca ou modelo diferente do pedido',
  BID_WRONG: 'lance diferente do lance da demanda',
  BID_IS_CEILING: 'teto total usado como lance',
  MMR_MISSING: 'MMR ausente ou não numérico',
  MMR_OUT_OF_RANGE: 'MMR fora da faixa do lance',
  YEAR_OUT_OF_RANGE: 'ano fora da faixa',
  MILES_OUT_OF_RANGE: 'milhagem fora da faixa',
  ODOMETER_UNKNOWN: 'odômetro não verificável',
  CROSS_MODE_CRITERIA: 'critério do outro modo misturado',
  TOO_MANY_OPTIONS: 'opções demais para conferir de uma vez',
  OTHER: 'outra divergência'
});
// Codes the model may return (the facts are checked here, not by the model).
const MODEL_CODES = Object.freeze(['PERSON_MISMATCH', 'OTHER_MODE_MATCH', 'MAKE_MODEL', 'BID_WRONG', 'BID_IS_CEILING', 'MMR_MISSING', 'MMR_OUT_OF_RANGE', 'YEAR_OUT_OF_RANGE', 'MILES_OUT_OF_RANGE', 'ODOMETER_UNKNOWN', 'CROSS_MODE_CRITERIA', 'VIN_DUPLICATE', 'SPLIT_DUPLICATE', 'DEMAND_INCOMPLETE', 'OTHER']);
const LABELS = Object.freeze({ CONFERINDO: 'Conferindo', CONFERIDO: 'Conferido', REVISAR: 'Revisar', PENDENTE: 'Conferência pendente', APROVADO_MANUAL: 'Aprovado à mão', AGUARDANDO_AUTORIZACAO: 'Aguardando autorização' });

// ------------------------------------------------------------------ configuração
function model(env = process.env) {
  const configured = String(env.MANHEIM_MATCH_AUDIT_MODEL || '').trim();
  if (!configured) return DEFAULT_MODEL;
  return APPROVED_MODELS.includes(configured) ? configured : null;
}
function status(env = process.env) {
  if (env.MANHEIM_MATCH_AUDIT_ENABLED !== '1') return 'DESLIGADA';
  if (!env.OPENAI_API_KEY) return 'SEM_CHAVE';
  if (!model(env)) return 'MODELO_INVALIDO';
  return 'LIGADA';
}
function costUsd(modelId, inputTokens, outputTokens) {
  const price = PRICES[modelId];
  if (!price) return 0;
  return Math.round(((Number(inputTokens) || 0) * price.input + (Number(outputTokens) || 0) * price.output) / 1e6 * 1e6) / 1e6;
}

// ------------------------------------------------------------------ grupos e checagem local
const upper = (value) => String(value || '').trim().toUpperCase();
const cents = (value) => { const number = Number(value); return Number.isFinite(number) ? Math.round(number) : null; };
const dollars = (value) => value === null || value === undefined ? null : Math.round(Number(value) / 100);
function testRefs(calcRuns) {
  return new Set((calcRuns || []).filter((row) => row && row.is_test === true).map((row) => upper(row.dados && typeof row.dados === 'object' ? row.dados.ref : '')).filter(Boolean));
}
function criteriaOf(demand) {
  if (!demand) return null;
  const wishes = (demand.activeWishes || demand.wishes || []).map((wish) => demand.mode === 'CARRO'
    ? { marca: wish.make || '', modelo: wish.model || '', ano_min: wish.yearMin ?? null, ano_max: wish.yearMax ?? null, milhagem_min: wish.minMiles ?? null, milhagem_max: wish.maxMiles ?? null }
    : { marca: wish.make || '', modelo: wish.model || '' });
  return demand.mode === 'VALOR' ? { desejos: wishes, lance_usd: dollars(demand.bidCents) } : { desejos: wishes };
}
function lotOf(match) {
  const raw = match && match.vehicle_json && match.vehicle_json.raw || {};
  const header = Object.keys(raw).find((name) => /^lot\b|lot ?#|lot number|n[uú]mero do lote/i.test(name));
  return header ? String(raw[header]).slice(0, 40) : '';
}
function optionOf(match, index) {
  const parsed = match && match.vehicle_json && match.vehicle_json.parsed || {};
  return { id: 'm' + (index + 1), tipo: match.match_kind || '', marca: parsed.make || '', modelo: parsed.model || '', ano: parsed.year ?? null, milhagem: parsed.miles ?? null, mmr_usd: dollars(parsed.mmrCents), vin: parsed.vin || '', lote: lotOf(match) };
}
function contentHash(group) {
  const body = [RULE_VERSION, group.uploadId, group.key, group.mode || '', JSON.stringify(group.criteria), JSON.stringify(group.options.map((option, index) => [group.matches[index].id, group.matches[index].row_fingerprint || '', option]))].join('\u001f');
  return crypto.createHash('sha256').update(body).digest('hex');
}

// Groups the live matches of the active batch by demand and checks every fact that does not need
// judgement. input: { upload, demands, matches, base } as built by the BUSCAS view.
function buildGroups(input) {
  const upload = input.upload || {};
  const base = input.base || {};
  const demandsByKey = new Map((input.demands || []).map((demand) => [demand.key, demand]));
  const tests = testRefs(base.calcRuns);
  const byKey = new Map();
  (input.matches || []).forEach((match) => {
    const key = match.demandKey || (match.journey_id ? `journey:${match.journey_id}:${match.logical_mode || ''}` : `ref:${upper(match.calc_ref)}:${match.logical_mode || ''}`);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(match);
  });
  return [...byKey.entries()].map(([key, matches]) => {
    const demand = demandsByKey.get(key) || null;
    const mode = demand ? demand.mode : matches[0] && matches[0].logical_mode || null;
    const journey = demand && demand.journeyId && base.journeyById ? base.journeyById.get(demand.journeyId) : null;
    const divergences = [];
    const matchIdOf = (option) => option ? (matches[Number(option.slice(1)) - 1] || {}).id || null : null;
    const add = (code, option = '') => { if (!divergences.some((item) => item.code === code && item.option === option)) divergences.push({ code, option, matchId: matchIdOf(option), text: CODES[code], source: 'LOCAL' }); };
    const options = matches.slice(0, MAX_OPTIONS).map(optionOf);
    if (matches.length > MAX_OPTIONS) add('TOO_MANY_OPTIONS');
    if (!demand) add('DEMAND_MISSING');
    else if (!demand.active || (demand.issues || []).length) add('DEMAND_INCOMPLETE');
    if (upload.undone_at) add('BATCH_UNDONE');
    if (demand && demand.journeyId) {
      if (!journey) add('PERSON_MISMATCH');
      else {
        if (journey.status === 'ENCERRADO' || journey.closed_at) add('JOURNEY_CLOSED');
        if (journey.contact && journey.contact.is_lead === false) add('NOT_LEAD');
        const refs = [journey.reference_code, ...(base.refsOf ? base.refsOf(journey) : [])].map(upper).filter(Boolean);
        if (refs.some((ref) => tests.has(ref))) add('TEST_RECORD');
        const ceiling = cents(journey.confirmed_total_ceiling_cents), budget = cents(journey.budget_cents);
        if (demand.mode === 'VALOR' && ceiling && cents(demand.bidCents) === ceiling && ceiling !== budget) add('BID_IS_CEILING');
      }
    }
    if (demand && demand.ref && tests.has(upper(demand.ref))) add('TEST_RECORD');
    const vins = new Map(), rowsSeen = new Map();
    matches.slice(0, MAX_OPTIONS).forEach((match, index) => {
      const option = 'm' + (index + 1);
      const parsed = match.vehicle_json && match.vehicle_json.parsed || {};
      if (!match.logical_mode) add('MODE_MISSING', option);
      else if (demand && match.logical_mode !== demand.mode) add('OTHER_MODE_MATCH', option);
      if (match.undone_at) add('BATCH_UNDONE', option);
      if (demand && demand.journeyId && match.journey_id !== demand.journeyId) add('PERSON_MISMATCH', option);
      if (demand && !demand.journeyId && demand.ref && upper(match.calc_ref) !== upper(demand.ref)) add('PERSON_MISMATCH', option);
      const vin = upper(parsed.vin);
      if (vin) { if (vins.has(vin)) add('VIN_DUPLICATE', option); vins.set(vin, option); }
      const signature = [parsed.year, upper(parsed.make), upper(parsed.model), parsed.miles, parsed.mmrCents, upper(parsed.location)].join('|');
      if (!vin) { if (rowsSeen.has(signature)) add('SPLIT_DUPLICATE', option); rowsSeen.set(signature, option); }
      if (!demand || !demand.active) return;
      // The same deterministic rule the import used, applied again to the stored car.
      const result = matchManheimDemand(parsed, { ...demand, wishes: demand.activeWishes });
      if (!result) {
        if (demand.mode === 'VALOR' && !(Number(parsed.mmrCents) > 0)) add('MMR_MISSING', option);
        else add('CRITERIA_MISMATCH', option);
        return;
      }
      if (demand.mode === 'CARRO' && (parsed.miles === null || parsed.miles === undefined || parsed.miles === '')) add('ODOMETER_UNKNOWN', option);
      if (match.match_kind && result.kind !== match.match_kind) add('CRITERIA_MISMATCH', option);
    });
    const group = { key, mode, uploadId: upload.id || null, demand, journeyId: demand && demand.journeyId || (matches[0] && matches[0].journey_id) || null, matches, options, criteria: criteriaOf(demand), divergences };
    group.hash = contentHash(group);
    return group;
  });
}

// ------------------------------------------------------------------ OpenAI
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['aprovado', 'divergencias'],
  properties: {
    aprovado: { type: 'boolean' },
    divergencias: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['opcao', 'codigo', 'motivo'], properties: { opcao: { type: 'string' }, codigo: { type: 'string', enum: MODEL_CODES }, motivo: { type: 'string' } } } }
  }
};
const INSTRUCTIONS = [
  'Você confere as opções de carros de leilão (Manheim) que o sistema da My Car Scout separou para uma demanda de cliente. Responda só com o JSON pedido.',
  'Modo VALOR: vale marca e modelo pedidos e o lance da própria demanda. O MMR precisa ser numérico. Lance até US$ 60.000: MMR entre 70% e 115% do lance; acima de US$ 60.000: entre 75% e 110%. O teto total nunca é lance. Ano e milhagem não contam em VALOR. Uma opção tipo QUASE sem MMR é só informativa e não é divergência.',
  'Modo CARRO: vale marca e modelo, ano dentro da faixa e milhagem dentro da faixa, com odômetro informado. Não existe tolerância. MMR e lance não contam em CARRO.',
  'Aponte critério de um modo usado no outro, opção de outra pessoa, VIN repetido, carro repetido e demanda incompleta.',
  'aprovado: true só quando todas as opções cumprem a regra do modo. Cada divergência traz a opção (id, ou vazio para a demanda inteira), o código e um motivo curto em português, sem ponto final.'
].join('\n');

function payloadOf(group) {
  return { versao_regra: RULE_VERSION, demanda: group.demand && group.demand.ref ? 'Ref ' + group.demand.ref : 'ficha ' + String(group.journeyId || '').slice(0, 8), modo: group.mode, criterios: group.criteria, opcoes: group.options };
}
function estimateGroup(group, modelId = DEFAULT_MODEL) {
  const input = Math.ceil(INSTRUCTIONS.length / 4) + 150 + Math.ceil(JSON.stringify(payloadOf(group)).length / 3);
  const output = 60 + group.options.length * 12;
  return { inputTokens: input, outputTokens: output, costUsd: costUsd(modelId, input, output) };
}

function validated(parsed, group) {
  const known = new Set(group.options.map((option) => option.id));
  if (!parsed || typeof parsed.aprovado !== 'boolean' || !Array.isArray(parsed.divergencias)) return { errorCode: 'OPENAI_RESPONSE_INVALID' };
  const divergences = [];
  for (const item of parsed.divergencias.slice(0, 50)) {
    const option = typeof item?.opcao === 'string' ? item.opcao.trim() : '';
    if (!MODEL_CODES.includes(item?.codigo) || (option && !known.has(option))) return { errorCode: 'OPENAI_RESPONSE_INVALID' };
    const text = String(item.motivo || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s*[—–]\s*/g, ', ').trim().slice(0, 200).replace(/[.\s]+$/, '') || CODES[item.codigo];
    divergences.push({ code: item.codigo, option, matchId: option ? (group.matches[Number(option.slice(1)) - 1] || {}).id || null : null, text, source: 'OPENAI' });
  }
  if (!parsed.aprovado && !divergences.length) divergences.push({ code: 'OTHER', option: '', matchId: null, text: 'A IA não aprovou e não detalhou', source: 'OPENAI' });
  // Never approved in silence: any divergence keeps the demand in REVISAR.
  return { status: parsed.aprovado && !divergences.length ? 'CONFERIDO' : 'REVISAR', divergences };
}

async function callOpenAI(group, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const modelId = model(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: JSON.stringify(payloadOf(group)) }],
        response_format: { type: 'json_schema', json_schema: { name: 'conferencia_manheim', strict: true, schema: SCHEMA } } })
    });
    if (!response.ok) { const failure = new Error('OPENAI_FAILED'); failure.code = response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_FAILED'; throw failure; }
    const payload = await response.json();
    const inputTokens = Number(payload?.usage?.prompt_tokens) || 0, outputTokens = Number(payload?.usage?.completion_tokens) || 0;
    let parsed = null;
    try { parsed = JSON.parse(payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
    return { ...validated(parsed, group), model: modelId, inputTokens, outputTokens, costUsd: costUsd(modelId, inputTokens, outputTokens) };
  } catch (failure) {
    if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
    throw failure;
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------ banco
const env = (ctx) => 'eq.' + ctx.environment;
async function auditRows(ctx, uploadId, read = rows) {
  if (!uploadId) return [];
  return read(ctx, 'manheim_match_audits', { select: 'id,upload_id,journey_id,logical_mode,demand_key,content_hash,status,divergences,reason,error_code,attempts,approved_reason,approved_at,provider,model,cost_usd,updated_at,created_at', environment: env(ctx), upload_id: 'eq.' + uploadId, order: 'created_at.asc' });
}
async function runRow(ctx, uploadId) {
  const found = await rows(ctx, 'manheim_audit_runs', { select: 'id,upload_id,status,estimate_usd,limit_usd,spent_usd,authorized_by,authorized_at', environment: env(ctx), upload_id: 'eq.' + uploadId, limit: '1' });
  return found[0] || null;
}
async function ensureRun(ctx, uploadId, estimateUsd) {
  const existing = await runRow(ctx, uploadId);
  if (existing) {
    if (Number(existing.estimate_usd) !== estimateUsd && existing.status !== 'AUTORIZADO') await patchRows(ctx, 'manheim_audit_runs', { environment: env(ctx), id: 'eq.' + existing.id }, { estimate_usd: estimateUsd, updated_at: new Date().toISOString() });
    return { ...existing, estimate_usd: existing.status === 'AUTORIZADO' ? existing.estimate_usd : estimateUsd };
  }
  const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/manheim_audit_runs?on_conflict=environment,upload_id', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ environment: ctx.environment, upload_id: uploadId, status: 'ABERTO', estimate_usd: estimateUsd, limit_usd: LIMIT_USD, spent_usd: 0 })
  });
  return (created && created[0]) || runRow(ctx, uploadId);
}

// Reserves the reading of one group before paying for it. Only one caller wins the reservation.
async function claim(ctx, group, existing, manual) {
  const now = new Date().toISOString();
  if (!existing) {
    const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/manheim_match_audits?on_conflict=environment,content_hash', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify({ environment: ctx.environment, upload_id: group.uploadId, journey_id: group.journeyId, logical_mode: group.mode, demand_key: group.key, content_hash: group.hash, rule_version: RULE_VERSION, status: 'CONFERINDO', match_count: group.matches.length, attempts: 1 })
    });
    return created && created[0] || null;
  }
  const stale = existing.status === 'CONFERINDO' && Date.parse(existing.updated_at || 0) < Date.now() - STALE_CLAIM_MS;
  const retryable = existing.status === 'PENDENTE' && (manual || (!FINAL_ERRORS.has(existing.error_code) && existing.attempts < MAX_ATTEMPTS));
  if (!stale && !retryable) return null;
  const attempts = Math.min(Number(existing.attempts || 0) + 1, 20);
  // Conditional update: only the caller that still sees the same status and attempt wins.
  const claimed = await patchRows(ctx, 'manheim_match_audits', { environment: env(ctx), id: 'eq.' + existing.id, status: 'eq.' + existing.status, attempts: 'eq.' + existing.attempts }, { status: 'CONFERINDO', attempts, updated_at: now }, true);
  return Array.isArray(claimed) && claimed[0] || null;
}

// ------------------------------------------------------------------ estado para a tela
// Status of each demand of the active batch. With the function off nothing is returned and
// nothing is blocked.
async function viewState(ctx, input, options = {}) {
  const state = status(options.env || process.env);
  if (state !== 'LIGADA' || !input.upload) return { state, byDemand: {} };
  const groups = buildGroups(input);
  const [stored, run] = await Promise.all([auditRows(ctx, input.upload.id).catch(() => []), runRow(ctx, input.upload.id).catch(() => null)]);
  const byHash = new Map(stored.map((row) => [row.content_hash, row]));
  const byDemand = {};
  let estimate = 0;
  groups.forEach((group) => {
    const row = byHash.get(group.hash);
    if (!row && !group.divergences.length) estimate += estimateGroup(group).costUsd;
    const statusCode = row ? row.status : group.divergences.length ? 'REVISAR' : run && run.status === 'AGUARDANDO_AUTORIZACAO' ? 'AGUARDANDO_AUTORIZACAO' : 'CONFERINDO';
    const divergences = row ? row.divergences || [] : group.divergences;
    byDemand[group.key] = { status: statusCode, label: LABELS[statusCode], divergences, errorCode: row && row.error_code || null, approvedReason: row && row.approved_reason || null, auditId: row && row.id || null,
      canApprove: ['PENDENTE', 'REVISAR', 'AGUARDANDO_AUTORIZACAO'].includes(statusCode) && !divergences.some((item) => item.source === 'LOCAL'), canRetry: statusCode === 'PENDENTE' };
  });
  return { state, uploadId: input.upload.id, limitUsd: LIMIT_USD, estimateUsd: Math.round(estimate * 1e6) / 1e6, run: run ? { status: run.status, estimateUsd: Number(run.estimate_usd), spentUsd: Number(run.spent_usd) } : null, byDemand };
}
const usable = (entry) => !entry || OK.includes(entry.status);

// ------------------------------------------------------------------ execução
// Runs the pending readings of the active batch. Never above the limit without authorization,
// never twice for the same hash, never past the deadline.
async function runAudit(ctx, input, options = {}) {
  const envValues = options.env || process.env;
  const state = status(envValues);
  if (state !== 'LIGADA') return { skipped: state, processed: 0 };
  if (!input.upload || input.upload.undone_at) return { skipped: 'SEM_LOTE_ATIVO', processed: 0 };
  const groups = buildGroups(input).filter((group) => !options.onlyKey || group.key === options.onlyKey);
  const stored = await auditRows(ctx, input.upload.id);
  const byHash = new Map(stored.map((row) => [row.content_hash, row]));
  const result = { processed: 0, approved: 0, review: 0, pending: 0, costUsd: 0, deferred: 0 };
  // Facts found here: REVISAR at once, no call.
  for (const group of groups.filter((item) => item.divergences.length && !byHash.has(item.hash))) {
    await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/manheim_match_audits?on_conflict=environment,content_hash', {
      method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ environment: ctx.environment, upload_id: group.uploadId, journey_id: group.journeyId, logical_mode: group.mode, demand_key: group.key, content_hash: group.hash, rule_version: RULE_VERSION, status: 'REVISAR', divergences: group.divergences, reason: 'Divergência encontrada na checagem do servidor', match_count: group.matches.length, attempts: 1 })
    });
    result.review += 1;
  }
  const pending = groups.filter((group) => !group.divergences.length).filter((group) => {
    const row = byHash.get(group.hash);
    if (!row) return true;
    if (row.status === 'CONFERINDO') return Date.parse(row.updated_at || 0) < Date.now() - STALE_CLAIM_MS;
    return row.status === 'PENDENTE' && (options.manual ? group.key === options.onlyKey : !FINAL_ERRORS.has(row.error_code) && row.attempts < MAX_ATTEMPTS);
  });
  if (!pending.length) return result;
  const modelId = model(envValues);
  const estimate = Math.round(pending.reduce((sum, group) => sum + estimateGroup(group, modelId).costUsd, 0) * 1e6) / 1e6;
  const run = await ensureRun(ctx, input.upload.id, estimate);
  // options.limitUsd exists only so the tests can prove the block without millions of tokens.
  const baseLimit = Number.isFinite(options.limitUsd) ? options.limitUsd : LIMIT_USD;
  const limit = run.status === 'AUTORIZADO' ? Number(run.limit_usd) : baseLimit;
  let spent = Number(run.spent_usd) || 0;
  if (run.status !== 'AUTORIZADO' && spent + estimate > baseLimit) {
    await patchRows(ctx, 'manheim_audit_runs', { environment: env(ctx), id: 'eq.' + run.id }, { status: 'AGUARDANDO_AUTORIZACAO', estimate_usd: estimate, updated_at: new Date().toISOString() });
    return { ...result, awaitingAuthorization: true, estimateUsd: estimate, limitUsd: LIMIT_USD };
  }
  for (const group of pending) {
    if (options.deadlineAt && Date.now() + TIMEOUT_MS + 5000 > options.deadlineAt) { result.deferred += 1; continue; }
    const next = estimateGroup(group, modelId).costUsd;
    if (spent + next > limit) { result.deferred += 1; continue; }
    const row = await claim(ctx, group, byHash.get(group.hash), options.manual);
    if (!row) continue;
    let patch;
    try {
      const answer = await callOpenAI(group, { env: envValues, fetchImpl: options.fetchImpl });
      spent += answer.costUsd;
      result.costUsd += answer.costUsd;
      const tokens = { provider: 'openai', model: answer.model, input_tokens: (Number(row.input_tokens) || 0) + answer.inputTokens, output_tokens: (Number(row.output_tokens) || 0) + answer.outputTokens, cost_usd: (Number(row.cost_usd) || 0) + answer.costUsd };
      patch = answer.errorCode
        ? { ...tokens, status: 'PENDENTE', error_code: answer.errorCode, reason: 'Resposta da IA inválida' }
        : { ...tokens, status: answer.status, divergences: answer.divergences, error_code: null, reason: answer.status === 'CONFERIDO' ? 'Conferido pela IA' : 'Divergência apontada pela IA' };
    } catch (failure) {
      patch = { provider: 'openai', model: modelId, status: 'PENDENTE', error_code: failure && failure.code || 'OPENAI_FAILED', reason: 'IA indisponível' };
    }
    await patchRows(ctx, 'manheim_match_audits', { environment: env(ctx), id: 'eq.' + row.id }, { ...patch, updated_at: new Date().toISOString() });
    result.processed += 1;
    if (patch.status === 'CONFERIDO') result.approved += 1; else if (patch.status === 'REVISAR') result.review += 1; else result.pending += 1;
  }
  await patchRows(ctx, 'manheim_audit_runs', { environment: env(ctx), id: 'eq.' + run.id }, { spent_usd: Math.round(spent * 1e6) / 1e6, status: run.status === 'AUTORIZADO' ? 'AUTORIZADO' : 'ABERTO', updated_at: new Date().toISOString() });
  result.costUsd = Math.round(result.costUsd * 1e6) / 1e6;
  return result;
}

// Operator authorizes a batch above the US$ 2 limit (up to the shown estimate plus 25%).
async function authorize(ctx, uploadId, actorId) {
  const run = await runRow(ctx, uploadId);
  if (!run || run.status !== 'AGUARDANDO_AUTORIZACAO') { const failure = new Error('AUDIT_NOTHING_TO_AUTHORIZE'); failure.code = 'AUDIT_NOTHING_TO_AUTHORIZE'; throw failure; }
  const limit = Math.round((Number(run.spent_usd) + Number(run.estimate_usd) * 1.25) * 1e6) / 1e6;
  await patchRows(ctx, 'manheim_audit_runs', { environment: env(ctx), id: 'eq.' + run.id }, { status: 'AUTORIZADO', limit_usd: limit, authorized_by: actorId, authorized_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return { authorized: true, limitUsd: limit };
}

// Manual approval with a reason, so the operation never stops. Never over a fact found by the
// server (closed ficha, non-lead, test, undone batch, rule broken).
async function approve(ctx, input, key, reason, actorId) {
  const text = String(reason || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  if (text.length < 5) { const failure = new Error('AUDIT_REASON_REQUIRED'); failure.code = 'AUDIT_REASON_REQUIRED'; throw failure; }
  const group = buildGroups(input).find((item) => item.key === key);
  if (!group) { const failure = new Error('AUDIT_DEMAND_NOT_FOUND'); failure.code = 'AUDIT_DEMAND_NOT_FOUND'; throw failure; }
  if (group.divergences.length) { const failure = new Error('AUDIT_LOCAL_DIVERGENCE'); failure.code = 'AUDIT_LOCAL_DIVERGENCE'; throw failure; }
  const existing = (await auditRows(ctx, group.uploadId)).find((row) => row.content_hash === group.hash);
  const at = new Date().toISOString();
  const patch = { status: 'APROVADO_MANUAL', approved_by: actorId, approved_reason: text, approved_at: at, updated_at: at };
  if (existing) await patchRows(ctx, 'manheim_match_audits', { environment: env(ctx), id: 'eq.' + existing.id }, patch);
  else await insert(ctx, 'manheim_match_audits', { environment: ctx.environment, upload_id: group.uploadId, journey_id: group.journeyId, logical_mode: group.mode, demand_key: group.key, content_hash: group.hash, rule_version: RULE_VERSION, match_count: group.matches.length, attempts: 1, reason: 'Aprovado à mão sem leitura da IA', ...patch });
  return { approved: true, key };
}

module.exports = {
  RULE_VERSION, APPROVED_MODELS, DEFAULT_MODEL, LIMIT_USD, CODES, LABELS, INSTRUCTIONS, MAX_ATTEMPTS,
  model, status, buildGroups, payloadOf, estimateGroup, validated, callOpenAI, viewState, usable, runAudit, authorize, approve, auditRows
};

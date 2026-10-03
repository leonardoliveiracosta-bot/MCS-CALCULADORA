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
//  * Até o saldo pré-pago da OpenAI (todas as funções juntas), reservado no banco
//    antes de cada chamada (panel_manheim_audit_budget_hold). Acima dele nada é chamado. O mesmo
//    lote, demanda, critérios, matches e versão da regra nunca são cobrados duas vezes (hash único no banco, com a linha reservada antes da chamada).
//  * Falha, tempo esgotado ou resposta inválida: "Conferência pendente". Nada é aprovado em
//    silêncio; dá para tentar de novo ou aprovar à mão com motivo registrado.
//  * Com a função desligada nada muda: V1 e V2 seguem como antes.

const crypto = require('node:crypto');
const openAiBudget = require('./panel-openai-budget');
const modelCheck = require('./panel-openai-model-check');
const { allRows, insert, patchRows, rows, supabase } = require('./panel-server');
const { matchManheimDemand } = require('./panel-domain');
const { undash } = require('./text-dash');
const { hasValidMmr } = require('./vehicle-match');
const { modelsMatch } = require('./vehicle-catalog');
const { PRICES } = require('./panel-triage');
const aiClaim = require('./panel-ai-claim');

const RULE_VERSION = 'conferencia-v2';
const DEFAULT_MODEL = 'gpt-6-luna';
const APPROVED_MODELS = Object.freeze(['gpt-6-luna']);
// No limit per import and no "waiting for authorization": the only limit is the OpenAI prepaid
// balance, checked per call by panel-openai-budget (reservation of the worst case).
const MAX_ATTEMPTS = 3;
// Options per call; a broad demand (hundreds of cars) is checked in several calls.
const CHUNK_OPTIONS = 100;
const MAX_OPTIONS = 1000;
const TIMEOUT_MS = 25000;
const STALE_CLAIM_MS = 5 * 60 * 1000;
const OK = Object.freeze(['CONFERIDO', 'APROVADO_MANUAL']);
const FINAL_ERRORS = new Set(['OPENAI_RESPONSE_INVALID']);
// No room in the OpenAI prepaid balance: nothing was called, so it never uses up an attempt.
const BUDGET_ERRORS = new Set(['OPENAI_BUDGET_LIMIT', 'OPENAI_BUDGET_UNAVAILABLE']);
// At most one attempt beyond the 3 automatic ones, and then never again (manual retry included):
// automatic for a reading cut by the function's deadline, by the button for the other failures. The
// demand stays blocked with the reason shown; only a manual approval with a reason releases it.
const DEADLINE_ATTEMPTS = MAX_ATTEMPTS + 1;
function retryAllowed(row, manual = false) {
  if (!row || row.status !== 'PENDENTE') return false;
  if (BUDGET_ERRORS.has(row.error_code)) return true;
  if (row.attempts >= DEADLINE_ATTEMPTS) return false;
  if (row.error_code === 'AUDIT_DEADLINE') return true;
  return manual || (!FINAL_ERRORS.has(row.error_code) && row.attempts < MAX_ATTEMPTS);
}
// Facts found by the server that no manual approval can override. The others (a repeated VIN or row
// from overlapping CSV splits, too many options) can be approved by hand with a reason.
const HARD_CODES = new Set(['MAKE_MODEL', 'DEMAND_MISSING', 'DEMAND_INCOMPLETE', 'MODE_MISSING', 'OTHER_MODE_MATCH', 'PERSON_MISMATCH', 'JOURNEY_CLOSED', 'NOT_LEAD', 'TEST_RECORD', 'BATCH_UNDONE', 'CRITERIA_MISMATCH', 'BID_IS_CEILING', 'MMR_MISSING', 'ODOMETER_UNKNOWN']);
const hardDivergence = (divergences) => (divergences || []).some((item) => item.source === 'LOCAL' && HARD_CODES.has(item.code));

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
// MAKE_MODEL is not here: make/model is checked only by the server, with the same modelsMatch of the search (one rule).
const MODEL_CODES = Object.freeze(['PERSON_MISMATCH', 'OTHER_MODE_MATCH', 'BID_WRONG', 'BID_IS_CEILING', 'MMR_MISSING', 'MMR_OUT_OF_RANGE', 'YEAR_OUT_OF_RANGE', 'MILES_OUT_OF_RANGE', 'ODOMETER_UNKNOWN', 'CROSS_MODE_CRITERIA', 'VIN_DUPLICATE', 'SPLIT_DUPLICATE', 'DEMAND_INCOMPLETE', 'OTHER']);
const LABELS = Object.freeze({ CONFERINDO: 'Conferindo', CONFERIDO: 'Conferido', REVISAR: 'Revisar', PENDENTE: 'Conferência pendente', APROVADO_MANUAL: 'Aprovado à mão', AGUARDANDO_AUTORIZACAO: 'Aguardando autorização', SEM_SELECAO: 'Conferência começa ao selecionar carros' });

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
  // Batches in blocks keep the lot inside the parsed car; older rows keep the raw CSV cells.
  const parsedLot = match && match.vehicle_json && match.vehicle_json.parsed && match.vehicle_json.parsed.lot;
  if (parsedLot) return String(parsedLot).slice(0, 40);
  const raw = match && match.vehicle_json && match.vehicle_json.raw || {};
  const header = Object.keys(raw).find((name) => /^lot\b|lot ?#|lot number|n[uú]mero do lote/i.test(name));
  return header ? String(raw[header]).slice(0, 40) : '';
}
function optionOf(match, index) {
  const parsed = match && match.vehicle_json && match.vehicle_json.parsed || {};
  return { id: 'm' + (index + 1), tipo: match.match_kind || '', marca: parsed.make || '', modelo: parsed.model || '', ano: parsed.year ?? null, milhagem: parsed.miles ?? null, mmr_usd: dollars(parsed.mmrCents), vin: parsed.vin || '', lote: lotOf(match) };
}
function contentHash(group) {
  // The server's own findings are part of the content: when a fact changes, the demand is read again.
  const facts = group.divergences.map((item) => item.code + ':' + item.option).sort();
  const body = [RULE_VERSION, group.uploadId, group.key, group.mode || '', JSON.stringify(group.criteria), JSON.stringify(group.options.map((option, index) => [group.matches[index].id, group.matches[index].row_fingerprint || '', option])), JSON.stringify(facts)].join('\u001f');
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
      // A stored match without its own mode (historical) is shown under a mode but never approved.
      if (!match.logical_mode || match.historicalMode) add('MODE_MISSING', option);
      else if (demand && match.logical_mode !== demand.mode) add('OTHER_MODE_MATCH', option);
      if (match.undone_at) add('BATCH_UNDONE', option);
      if (demand && demand.journeyId && match.journey_id !== demand.journeyId) add('PERSON_MISMATCH', option);
      if (demand && !demand.journeyId && demand.ref && upper(match.calc_ref) !== upper(demand.ref)) add('PERSON_MISMATCH', option);
      const vin = upper(parsed.vin);
      if (vin) { if (vins.has(vin)) add('VIN_DUPLICATE', option); vins.set(vin, option); }
      const signature = [parsed.year, upper(parsed.make), upper(parsed.model), parsed.miles, parsed.mmrCents, upper(parsed.location)].join('|');
      if (!vin) { if (rowsSeen.has(signature)) add('SPLIT_DUPLICATE', option); rowsSeen.set(signature, option); }
      // MMR is mandatory in both modes (in CARRO its amount decides nothing).
      if (!hasValidMmr(parsed)) { add('MMR_MISSING', option); return; }
      if (!demand || !demand.active) return;
      // Make/model: the catalog rule of the search (Escalade ESV = Escalade, Yukon XL = Yukon, ...), never the AI.
      const wishes = demand.activeWishes || demand.wishes || [];
      if (wishes.length && !wishes.some((wish) => modelsMatch(parsed.model, wish.model, parsed.make, wish.make))) { add('MAKE_MODEL', option); return; }
      // The same deterministic rule the import used, applied again to the stored car.
      const result = matchManheimDemand(parsed, { ...demand, wishes: demand.activeWishes });
      if (!result) { add('CRITERIA_MISMATCH', option); return; }
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
  'Marca e modelo já foram conferidos pelo servidor com o catálogo (o cliente não informa versão: o modelo pedido vale para a família inteira, como Escalade ESV para Escalade). Nunca aponte divergência de marca ou modelo.',
  'Modo VALOR: vale o lance da própria demanda. O MMR é obrigatório e numérico. Lance até US$ 60.000: MMR entre 70% e 115% do lance; acima de US$ 60.000: entre 75% e 110%. O teto total nunca é lance. Ano e milhagem não contam em VALOR.',
  'Modo CARRO: vale ano dentro da faixa e milhagem dentro da faixa, com odômetro informado. Não existe tolerância. O MMR precisa existir e ser numérico, mas o valor dele não decide; o lance não conta em CARRO.',
  'Aponte critério de um modo usado no outro, opção de outra pessoa, VIN repetido, carro repetido e demanda incompleta.',
  'aprovado: true só quando todas as opções cumprem a regra do modo. Cada divergência traz a opção (id, ou vazio para a demanda inteira), o código e um motivo curto em português, sem ponto final.'
].join('\n');

const chunksOf = (group) => {
  const chunks = [];
  for (let index = 0; index < group.options.length; index += CHUNK_OPTIONS) chunks.push(group.options.slice(index, index + CHUNK_OPTIONS));
  return chunks.length ? chunks : [[]];
};
function payloadOf(group, options = group.options) {
  return { versao_regra: RULE_VERSION, demanda: group.demand && group.demand.ref ? 'Ref ' + group.demand.ref : 'ficha ' + String(group.journeyId || '').slice(0, 8), modo: group.mode, criterios: group.criteria, opcoes: options };
}
function estimateGroup(group, modelId = DEFAULT_MODEL) {
  let input = 0, output = 0;
  chunksOf(group).forEach((chunk) => {
    input += Math.ceil(INSTRUCTIONS.length / 4) + 150 + Math.ceil(JSON.stringify(payloadOf(group, chunk)).length / 3);
    output += 60 + chunk.length * 12;
  });
  return { inputTokens: input, outputTokens: output, costUsd: costUsd(modelId, input, output) };
}

// chunk: the options sent in this call; ids outside it are invalid answers.
function validated(parsed, group, chunk = group.options) {
  const known = new Set(chunk.map((option) => option.id));
  if (!parsed || typeof parsed.aprovado !== 'boolean' || !Array.isArray(parsed.divergencias)) return { errorCode: 'OPENAI_RESPONSE_INVALID' };
  const divergences = [];
  for (const item of parsed.divergencias.slice(0, 50)) {
    const option = typeof item?.opcao === 'string' ? item.opcao.trim() : '';
    if (!MODEL_CODES.includes(item?.codigo) || (option && !known.has(option))) return { errorCode: 'OPENAI_RESPONSE_INVALID' };
    const text = undash(String(item.motivo || '').replace(/[\u0000-\u001f]/g, ' ')).trim().slice(0, 200).replace(/[.\s]+$/, '') || CODES[item.codigo];
    divergences.push({ code: item.codigo, option, matchId: option ? (group.matches[Number(option.slice(1)) - 1] || {}).id || null : null, text, source: 'OPENAI' });
  }
  if (!parsed.aprovado && !divergences.length) divergences.push({ code: 'OTHER', option: '', matchId: null, text: 'A IA não aprovou e não detalhou', source: 'OPENAI' });
  // Never approved in silence: any divergence keeps the demand in REVISAR.
  return { status: parsed.aprovado && !divergences.length ? 'CONFERIDO' : 'REVISAR', divergences };
}

async function callChunk(group, chunk, options) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const modelId = model(env);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  if (timer.unref) timer.unref();
  const body = { model: modelId, messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: JSON.stringify(payloadOf(group, chunk)) }],
    response_format: { type: 'json_schema', json_schema: { name: 'conferencia_manheim', strict: true, schema: SCHEMA } } };
  // The OpenAI prepaid-balance reservation around each call (options.guard, panel-openai-budget).
  return require('./panel-openai-budget').paidCall(options.guard, { modelId, body, send: async (capped) => {
  try {
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify(capped)
    });
    if (!response.ok) throw await require('./panel-openai-budget').openAiFailure(response);
    const payload = await response.json();
    const inputTokens = Number(payload?.usage?.prompt_tokens) || 0, outputTokens = Number(payload?.usage?.completion_tokens) || 0;
    let parsed = null;
    try { parsed = JSON.parse(payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
    return { ...validated(parsed, group, chunk), inputTokens, outputTokens, costUsd: costUsd(modelId, inputTokens, outputTokens) };
  } catch (failure) {
    if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
    throw failure;
  } finally { clearTimeout(timer); }
  } });
}

// One demand, in calls of up to 100 options. Approved only when every call approves. A failure
// keeps what was already paid on the record (failure.spent).
async function callOpenAI(group, options = {}) {
  const modelId = model(options.env || process.env);
  const total = { model: modelId, inputTokens: 0, outputTokens: 0, costUsd: 0, divergences: [], status: 'CONFERIDO', errorCode: null };
  for (const chunk of chunksOf(group)) {
    if (options.deadlineAt && Date.now() + TIMEOUT_MS + 5000 > options.deadlineAt) {
      const failure = new Error('AUDIT_DEADLINE'); failure.code = 'AUDIT_DEADLINE'; failure.spent = total; throw failure;
    }
    let answer;
    try { answer = await callChunk(group, chunk, options); } catch (failure) { failure.spent = total; throw failure; }
    total.inputTokens += answer.inputTokens; total.outputTokens += answer.outputTokens; total.costUsd += answer.costUsd;
    if (answer.errorCode) { total.errorCode = answer.errorCode; total.status = null; break; }
    total.divergences.push(...answer.divergences);
    if (answer.status !== 'CONFERIDO') total.status = 'REVISAR';
  }
  total.costUsd = Math.round(total.costUsd * 1e6) / 1e6;
  return total;
}

// ------------------------------------------------------------------ banco
const env = (ctx) => 'eq.' + ctx.environment;
async function auditRows(ctx, uploadId, read = rows) {
  if (!uploadId) return [];
  return read(ctx, 'manheim_match_audits', { select: 'id,upload_id,journey_id,logical_mode,demand_key,content_hash,status,divergences,reason,error_code,attempts,approved_reason,approved_at,provider,model,cost_usd,updated_at,created_at', environment: env(ctx), upload_id: 'eq.' + uploadId, order: 'created_at.asc' });
}
// Real spending of the batch: the sum of what every reading of it cost (never a counter that
// concurrent runs could overwrite). Read again before each paid call.
async function spentOf(ctx, uploadId) {
  const list = await allRows(ctx, 'manheim_match_audits', { select: 'cost_usd', environment: env(ctx), upload_id: 'eq.' + uploadId, cost_usd: 'not.is.null' });
  return Math.round(list.reduce((sum, row) => sum + (Number(row.cost_usd) || 0), 0) * 1e6) / 1e6;
}
async function holdBudget(ctx, uploadId, demandKey, amountUsd, baseLimit) {
  const result = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/rpc/panel_manheim_audit_budget_hold', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ p_environment: ctx.environment, p_upload_id: uploadId, p_demand_key: demandKey, p_amount: Math.round(amountUsd * 1e6) / 1e6, p_base_limit: baseLimit })
  });
  return result && result.held === true ? { held: true, id: result.id } : { held: false, reason: result && result.reason || null, remaining: result && result.remaining };
}
async function runRow(ctx, uploadId) {
  const found = await rows(ctx, 'manheim_audit_runs', { select: 'id,upload_id,status,estimate_usd,limit_usd,spent_usd,authorized_by,authorized_at', environment: env(ctx), upload_id: 'eq.' + uploadId, limit: '1' });
  return found[0] || null;
}
async function ensureRun(ctx, uploadId, estimateUsd) {
  const existing = await runRow(ctx, uploadId);
  if (existing) {
    if (existing.status === 'AUTORIZADO') return existing;
    // A batch that was waiting for an authorization (old per-import limit) goes on; spending,
    // holds and audits are untouched.
    const patch = {};
    if (Number(existing.estimate_usd) !== estimateUsd) patch.estimate_usd = estimateUsd;
    if (existing.status === 'AGUARDANDO_AUTORIZACAO') patch.status = 'ABERTO';
    if (Object.keys(patch).length) await patchRows(ctx, 'manheim_audit_runs', { environment: env(ctx), id: 'eq.' + existing.id }, { ...patch, updated_at: new Date().toISOString() });
    return { ...existing, ...patch };
  }
  const created = await supabase(ctx.config.url, ctx.config.secretKey, '/rest/v1/manheim_audit_runs?on_conflict=environment,upload_id', {
    method: 'POST', headers: { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify({ environment: ctx.environment, upload_id: uploadId, status: 'ABERTO', estimate_usd: estimateUsd, spent_usd: 0 })
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
  const retryable = retryAllowed(existing, manual);
  if (!stale && !retryable) return null;
  const attempts = BUDGET_ERRORS.has(existing.error_code) ? Math.max(Number(existing.attempts || 1), 1) : Math.min(Number(existing.attempts || 0) + 1, 20);
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
    // The hash carries the server's findings, so a stored row always matches today's facts.
    const row = byHash.get(group.hash);
    if (!row && !group.divergences.length) estimate += estimateGroup(group).costUsd;
    const statusCode = row ? row.status : group.divergences.length ? 'REVISAR' : run && run.status === 'AGUARDANDO_AUTORIZACAO' ? 'AGUARDANDO_AUTORIZACAO' : 'CONFERINDO';
    const divergences = row && row.status !== 'CONFERINDO' ? row.divergences || [] : group.divergences;
    byDemand[group.key] = { status: statusCode, label: LABELS[statusCode], divergences, errorCode: row && row.error_code || null, approvedReason: row && row.approved_reason || null, auditId: row && row.id || null,
      canApprove: ['PENDENTE', 'REVISAR', 'AGUARDANDO_AUTORIZACAO'].includes(statusCode) && !hardDivergence(group.divergences), canRetry: statusCode === 'PENDENTE' && retryAllowed(row, true),
      attempts: row && row.attempts || 0 };
  });
  // Demands outside the audit (no car selected for the customer yet): nothing is read for them; the
  // last reading, when there is one, is shown with its reason. A V1 needs selected cars anyway.
  if (Array.isArray(input.scope)) {
    const latest = new Map();
    stored.forEach((row) => latest.set(row.demand_key, row)); // oldest first: the last one wins
    (input.demands || []).forEach((demand) => {
      if (byDemand[demand.key]) return;
      const row = latest.get(demand.key) || null;
      byDemand[demand.key] = { status: 'SEM_SELECAO', label: LABELS.SEM_SELECAO, divergences: [], errorCode: row && row.error_code || null, approvedReason: null, auditId: row && row.id || null,
        lastStatus: row && row.status || null, attempts: row && row.attempts || 0, canApprove: false, canRetry: false };
    });
  }
  return { state, uploadId: input.upload.id, limitUsd: null, estimateUsd: Math.round(estimate * 1e6) / 1e6, run: run ? { status: run.status, estimateUsd: Number(run.estimate_usd), spentUsd: Number(run.spent_usd), limitUsd: null } : null, byDemand };
}
const usable = (entry) => !entry || OK.includes(entry.status);
// V1 and V2 gate for one car of the active batch. demandKey (sent by the BUSCAS card) checks that
// demand only; without it every demand the car belongs to must be released. null: not in the batch.
function heldFor(state, liveMatches, matchId, demandKey = null) {
  const keys = (liveMatches || []).filter((match) => match.id === matchId).map((match) => match.demandKey);
  if (!keys.length) return null;
  const checked = demandKey && keys.includes(demandKey) ? [demandKey] : keys;
  return checked.some((key) => { const entry = state.byDemand[key]; return !entry || !OK.includes(entry.status); });
}

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
  const result = { processed: 0, approved: 0, review: 0, pending: 0, costUsd: 0, deferred: 0, inProgress: 0 };
  const claims = options.claims || aiClaim;
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
    return retryAllowed(row, options.manual && group.key === options.onlyKey);
  });
  if (!pending.length) return result;
  const modelId = model(envValues);
  const estimate = Math.round(pending.reduce((sum, group) => sum + estimateGroup(group, modelId).costUsd, 0) * 1e6) / 1e6;
  const run = await ensureRun(ctx, input.upload.id, estimate);
  // The OpenAI prepaid balance for all the panel's features together (panel-openai-budget).
  const budget = options.budget || openAiBudget;
  const provider = await budget.spentUsd(ctx);
  // The minimal model test (no customer data) must have passed before the first real reading.
  const check = await (options.modelCheck || modelCheck.ensureModelChecked)(ctx, modelId);
  if (!check.ok) return { ...result, stoppedReason: 'MODEL_NOT_CHECKED', error: check.error };
  for (const group of pending) {
    if (options.deadlineAt && Date.now() + TIMEOUT_MS + 5000 > options.deadlineAt) { result.deferred += 1; continue; }
    if (!budget.fits(provider, Math.max(estimateGroup(group, modelId).costUsd * 2, budget.MAX_CALL_USD), result.costUsd)) { result.providerLimit = true; result.deferred += 1; continue; }
    // Atomic reservation first (upload trigger, cron and button at the same time): only the winner calls.
    const task = await claims.claimTask(ctx, { kind: 'MANHEIM_MATCH_AUDIT', subject: group.key, hash: group.hash, rule: RULE_VERSION });
    if (!task.claimed) { result.inProgress += 1; continue; }
    // Then the batch budget, atomically per upload: two demands at the same time never pass the
    // remaining limit together. Twice the estimate is held, so the real cost never crosses the cap.
    const hold = await holdBudget(ctx, input.upload.id, group.key, Math.max(estimateGroup(group, modelId).costUsd * 2, 0.000001), null);
    if (!hold.held) {
      await claims.finishTask(ctx, task, false).catch(() => null);
      result.awaitingAuthorization = true;
      result.deferred += 1; continue;
    }
    const release = () => patchRows(ctx, 'manheim_audit_budget_holds', { environment: env(ctx), id: 'eq.' + hold.id, status: 'eq.ABERTA' }, { status: 'ENCERRADA', closed_at: new Date().toISOString() }).catch(() => null);
    const row = await claim(ctx, group, byHash.get(group.hash), options.manual).catch(() => null);
    if (!row) { await release(); await claims.finishTask(ctx, task, false).catch(() => null); result.inProgress += 1; continue; }
    let patch, paid, budgetStop = false;
    const guard = budget.guard ? budget.guard(ctx, 'MANHEIM_AUDIT', group.key, options.budgetServices) : null;
    try {
      const answer = await callOpenAI(group, { env: envValues, fetchImpl: options.fetchImpl, deadlineAt: options.deadlineAt, guard });
      paid = answer;
      patch = answer.errorCode
        ? { status: 'PENDENTE', error_code: answer.errorCode, reason: 'Resposta da IA inválida' }
        : { status: answer.status, divergences: answer.divergences, error_code: null, reason: answer.status === 'CONFERIDO' ? 'Conferido pela IA' : 'Divergência apontada pela IA' };
    } catch (failure) {
      paid = failure && failure.spent || null;
      const code = failure && failure.code || 'OPENAI_FAILED';
      // A budget refusal called nothing: the row goes back to what it was (same error, same
      // attempts), so a reading cut by the deadline keeps its count and its reason.
      const before = byHash.get(group.hash);
      patch = BUDGET_ERRORS.has(code) ? (before && before.status === 'PENDENTE'
        ? { status: 'PENDENTE', error_code: before.error_code, attempts: before.attempts, reason: 'Sem saldo pré-pago na OpenAI' }
        : { status: 'PENDENTE', error_code: code, attempts: Math.max(1, Number(before && before.attempts || 1)), reason: 'Sem saldo pré-pago na OpenAI' })
        : { status: 'PENDENTE', error_code: code, reason: code === 'AUDIT_DEADLINE' ? 'Tempo esgotado antes de terminar a conferência' : 'IA indisponível' };
      if (BUDGET_ERRORS.has(code)) { result.providerLimit = true; budgetStop = true; }
    }
    const cost = paid ? { input_tokens: (Number(row.input_tokens) || 0) + paid.inputTokens, output_tokens: (Number(row.output_tokens) || 0) + paid.outputTokens, cost_usd: Math.round(((Number(row.cost_usd) || 0) + paid.costUsd) * 1e6) / 1e6 } : {};
    result.costUsd += paid ? paid.costUsd : 0;
    const at = new Date().toISOString();
    try {
      // Only over our own reservation: a manual approval made meanwhile wins (the cost is still kept).
      const written = await patchRows(ctx, 'manheim_match_audits', { environment: env(ctx), id: 'eq.' + row.id, status: 'eq.CONFERINDO' }, { provider: 'openai', model: modelId, ...cost, ...patch, updated_at: at }, true);
      if (!(Array.isArray(written) && written[0]) && paid) await patchRows(ctx, 'manheim_match_audits', { environment: env(ctx), id: 'eq.' + row.id }, { provider: 'openai', model: modelId, ...cost, updated_at: at });
      // The cost is on the audit row now: the OpenAI reservations stop counting it.
      if (budget.recorded) await budget.recorded(guard);
    } catch (error) {
      console.error('[manheim-audit]', { operation: 'record', message: String(error?.code || error?.message || 'UNKNOWN') });
      // A paid answer that could not be written keeps its cost on the OpenAI reservation and is not
      // paid again for this content (the task stays done); nothing paid may be retried.
      await claims.finishTask(ctx, task, Boolean(paid && paid.costUsd > 0)).catch(() => null);
      continue;
    }
    // The real cost is on the audit row now: the budget hold can close.
    await release();
    // A pending reading is released (the automatic retry rules above still apply; the operator can
    // always ask again). A decided one is done for this content.
    await claims.finishTask(ctx, task, patch.status !== 'PENDENTE').catch(() => null);
    if (budgetStop) { result.deferred += 1; break; }
    result.processed += 1;
    if (patch.status === 'CONFERIDO') result.approved += 1; else if (patch.status === 'REVISAR') result.review += 1; else result.pending += 1;
  }
  // Only the spending: the status belongs to the budget holds and to the operator's authorization
  // (a concurrent run may have just set "aguardando autorização").
  await patchRows(ctx, 'manheim_audit_runs', { environment: env(ctx), id: 'eq.' + run.id }, { spent_usd: await spentOf(ctx, input.upload.id), updated_at: new Date().toISOString() });
  result.costUsd = Math.round(result.costUsd * 1e6) / 1e6;
  return result;
}

// A batch left waiting by the old per-import limit goes on (there is no limit per import any more).
async function authorize(ctx, uploadId, actorId) {
  const run = await runRow(ctx, uploadId);
  if (!run || run.status !== 'AGUARDANDO_AUTORIZACAO') { const failure = new Error('AUDIT_NOTHING_TO_AUTHORIZE'); failure.code = 'AUDIT_NOTHING_TO_AUTHORIZE'; throw failure; }
  await patchRows(ctx, 'manheim_audit_runs', { environment: env(ctx), id: 'eq.' + run.id }, { status: 'AUTORIZADO', authorized_by: actorId, authorized_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return { authorized: true, limitUsd: null };
}

// Manual approval with a reason, so the operation never stops. Never over a fact found by the
// server (closed ficha, non-lead, test, undone batch, rule broken).
async function approve(ctx, input, key, reason, actorId) {
  const text = String(reason || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
  if (text.length < 5) { const failure = new Error('AUDIT_REASON_REQUIRED'); failure.code = 'AUDIT_REASON_REQUIRED'; throw failure; }
  const group = buildGroups(input).find((item) => item.key === key);
  if (!group) { const failure = new Error('AUDIT_DEMAND_NOT_FOUND'); failure.code = 'AUDIT_DEMAND_NOT_FOUND'; throw failure; }
  if (hardDivergence(group.divergences)) { const failure = new Error('AUDIT_LOCAL_DIVERGENCE'); failure.code = 'AUDIT_LOCAL_DIVERGENCE'; throw failure; }
  const existing = (await auditRows(ctx, group.uploadId)).find((row) => row.content_hash === group.hash);
  if (existing && existing.status === 'CONFERINDO' && Date.parse(existing.updated_at || 0) >= Date.now() - STALE_CLAIM_MS) { const failure = new Error('AUDIT_IN_PROGRESS'); failure.code = 'AUDIT_IN_PROGRESS'; throw failure; }
  const at = new Date().toISOString();
  const patch = { status: 'APROVADO_MANUAL', approved_by: actorId, approved_reason: text, approved_at: at, updated_at: at };
  if (existing) await patchRows(ctx, 'manheim_match_audits', { environment: env(ctx), id: 'eq.' + existing.id }, patch);
  else await insert(ctx, 'manheim_match_audits', { environment: ctx.environment, upload_id: group.uploadId, journey_id: group.journeyId, logical_mode: group.mode, demand_key: group.key, content_hash: group.hash, rule_version: RULE_VERSION, match_count: group.matches.length, attempts: 1, reason: 'Aprovado à mão sem leitura da IA', ...patch });
  return { approved: true, key };
}

module.exports = {
  RULE_VERSION, APPROVED_MODELS, DEFAULT_MODEL, CODES, LABELS, INSTRUCTIONS, MAX_ATTEMPTS, DEADLINE_ATTEMPTS, retryAllowed,
  model, status, buildGroups, payloadOf, estimateGroup, validated, callOpenAI, viewState, usable, heldFor, runAudit, authorize, approve, auditRows
};

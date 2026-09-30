'use strict';

// OpenAI reads ONLY the Manheim CSV rows the deterministic parser could not read with safety
// (unknown header, make, model, trim, year, mileage or MMR). It never receives a customer, a
// phone, a Ref, a conversation or a ficha: only the cells of the ambiguous row, by column name.
// It only suggests a normalization. The browser runs the suggestion through the same parser and
// rules again; what is still ambiguous goes to review. It never chooses CARRO or VALOR, never
// chooses a customer and never creates a match. OpenAI is the only provider for this job; there
// is no Anthropic fallback. Off unless MANHEIM_OPENAI_ENABLED=1, OPENAI_API_KEY and an allowed
// MANHEIM_OPENAI_MODEL exist, so no cost is created without the owner's decision. Its own flag and
// model variable: never MANHEIM_MATCH_AUDIT_ENABLED or ENTRADA_OPENAI_ENABLED.

// No default model: without an allowed MANHEIM_OPENAI_MODEL the function is off (never a silent choice).
const DEFAULT_MODEL = null;
const { rowAmbiguity } = require('./painel/manheim');
// US$ per 1M tokens (standard tier), from OpenAI's pricing page. Used for the cost estimate only.
const PRICES = Object.freeze({
  'gpt-6-luna': { input: 0.10, output: 0.50 },
  'gpt-5.4-nano': { input: 0.20, output: 1.25 },
  'gpt-5.6-luna': { input: 0.20, output: 1.20 }
});
const FIELDS = Object.freeze(['year', 'make', 'model', 'trim', 'miles', 'mmr']);
const MAX_ROWS = 25;
const MAX_CELL = 120;
const TIMEOUT_MS = 20000;

// Only these models may be used. Any other name in MANHEIM_OPENAI_MODEL turns the AI off (the
// ambiguous rows go to review); there is never a fallback to another, more expensive model.
const APPROVED_MODELS = Object.freeze(['gpt-6-luna', 'gpt-5.4-nano', 'gpt-5.6-luna']);

function model(env = process.env) {
  const configured = String(env.MANHEIM_OPENAI_MODEL || '').trim();
  return APPROVED_MODELS.includes(configured) ? configured : null;
}

function enabled(env = process.env) {
  return env.MANHEIM_OPENAI_ENABLED === '1' && Boolean(env.OPENAI_API_KEY) && Boolean(model(env));
}

function estimateCostUsd(modelId, inputTokens, outputTokens) {
  const price = PRICES[modelId];
  if (!price) return null;
  return Math.round(((Number(inputTokens) || 0) * price.input + (Number(outputTokens) || 0) * price.output) / 1e6 * 1e6) / 1e6;
}

const cellText = (value) => String(value === null || value === undefined ? '' : value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, MAX_CELL);

// Only the cells of the columns the parser reads; any other column (location, VIN, color...)
// never leaves the server. Returns null for an invalid row.
function sanitizeRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = cellText(row.id).slice(0, 40);
  if (!id) return null;
  const cells = {};
  for (const field of FIELDS) cells[field] = cellText(row.cells && row.cells[field]);
  // The server decides what is ambiguous, with the same parser rule as the browser: a row the
  // parser reads with safety never goes to OpenAI, whatever the browser says.
  const ambiguous = rowAmbiguity(cells).filter((field) => FIELDS.includes(field));
  if (!ambiguous.length || !Object.values(cells).some(Boolean)) return null;
  return { id, cells, ambiguous };
}

// Malformed input is refused; clear rows are left out (they stay with the parser's own reading).
function sanitizeRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) return null;
  if (rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row) || !cellText(row.id))) return null;
  const clean = rows.map(sanitizeRow).filter(Boolean);
  return clean.length ? clean : null;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['rows'],
  properties: {
    rows: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'year', 'make', 'model', 'trim', 'miles', 'mmr', 'confident'],
        properties: {
          id: { type: 'string' },
          year: { type: ['integer', 'null'] }, make: { type: ['string', 'null'] }, model: { type: ['string', 'null'] }, trim: { type: ['string', 'null'] },
          miles: { type: ['integer', 'null'] }, mmr: { type: ['integer', 'null'] }, confident: { type: 'boolean' }
        }
      }
    }
  }
};

const INSTRUCTIONS = 'You normalize rows of a Manheim auction CSV. Each row has the raw cells year, make, model, trim, miles (odometer) and mmr (US dollars). For each row return the normalized values only when they are written in the cells: never invent a value, never guess a mileage or an MMR, return null when a value is missing or unreadable. Miles and mmr are whole numbers (12k = 12000). Set confident to false when anything is uncertain.';

// One call for up to 25 rows. Returns { suggestions, usage, model, ms } or throws with a code.
async function suggestRows(rows, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  if (!enabled(env)) { const failure = new Error('OPENAI_NOT_ENABLED'); failure.code = 'OPENAI_NOT_ENABLED'; throw failure; }
  const modelId = model(env);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  if (timer.unref) timer.unref();
  const body = {
    model: modelId,
    messages: [{ role: 'system', content: INSTRUCTIONS }, { role: 'user', content: JSON.stringify({ rows: rows.map((row) => ({ id: row.id, ...row.cells })) }) }],
    response_format: { type: 'json_schema', json_schema: { name: 'manheim_rows', strict: true, schema: SCHEMA } }
  };
  // The US$ 50 OpenAI reservation around the call (options.guard, panel-openai-budget).
  return require('./panel-openai-budget').paidCall(options.guard, { modelId, body, send: async (capped) => {
  try {
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify(capped)
    });
    if (!response.ok) { const failure = new Error('OPENAI_FAILED'); failure.code = response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_FAILED'; failure.status = response.status; throw failure; }
    const payload = await response.json();
    let parsed = null;
    try { parsed = JSON.parse(payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
    const known = new Set(rows.map((row) => row.id));
    const suggestions = Array.isArray(parsed && parsed.rows) ? parsed.rows.filter((item) => item && known.has(String(item.id))).map((item) => ({
      id: String(item.id),
      year: Number.isInteger(item.year) ? item.year : null, make: typeof item.make === 'string' ? cellText(item.make) : null,
      model: typeof item.model === 'string' ? cellText(item.model) : null, trim: typeof item.trim === 'string' ? cellText(item.trim) : null,
      miles: Number.isInteger(item.miles) ? item.miles : null, mmr: Number.isInteger(item.mmr) ? item.mmr : null, confident: item.confident === true
    })) : [];
    const usage = { inputTokens: Number(payload?.usage?.prompt_tokens) || 0, outputTokens: Number(payload?.usage?.completion_tokens) || 0 };
    return { suggestions, usage, model: modelId, ms: Date.now() - started, costUsd: estimateCostUsd(modelId, usage.inputTokens, usage.outputTokens) };
  } catch (failure) {
    if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
    throw failure;
  } finally { clearTimeout(timer); }
  } });
}

// Unknown header: only the column NAMES are sent (never a value of any row).
const HEADER_FIELDS = Object.freeze(['year', 'make', 'model', 'trim', 'miles', 'mmr']);
function sanitizeHeaders(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const headers = (Array.isArray(source.headers) ? source.headers : []).map((header) => cellText(header).slice(0, 80)).filter(Boolean).slice(0, 100);
  const missing = (Array.isArray(source.missing) ? source.missing : []).filter((field) => HEADER_FIELDS.includes(field));
  return headers.length && missing.length ? { headers, missing } : null;
}

const HEADER_SCHEMA = {
  type: 'object', additionalProperties: false, required: HEADER_FIELDS.slice(),
  properties: Object.fromEntries(HEADER_FIELDS.map((field) => [field, { type: ['string', 'null'] }]))
};

async function suggestHeaders(input, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  if (!enabled(env)) { const failure = new Error('OPENAI_NOT_ENABLED'); failure.code = 'OPENAI_NOT_ENABLED'; throw failure; }
  const modelId = model(env);
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  if (timer.unref) timer.unref();
  const body = {
        model: modelId,
        messages: [{ role: 'system', content: 'Map the columns of a Manheim auction CSV. For each field (year, make, model, trim, miles = odometer, mmr = Manheim Market Report value) return the exact column name from the list, or null when no column clearly holds it. Never invent a column name.' }, { role: 'user', content: JSON.stringify(input) }],
        response_format: { type: 'json_schema', json_schema: { name: 'manheim_headers', strict: true, schema: HEADER_SCHEMA } }
  };
  return require('./panel-openai-budget').paidCall(options.guard, { modelId, body, send: async (capped) => {
  try {
    const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify(capped)
    });
    if (!response.ok) { const failure = new Error('OPENAI_FAILED'); failure.code = response.status === 429 ? 'OPENAI_RATE_LIMIT' : 'OPENAI_FAILED'; throw failure; }
    const payload = await response.json();
    let parsed = null;
    try { parsed = JSON.parse(payload?.choices?.[0]?.message?.content || ''); } catch (_) { parsed = null; }
    const known = new Set(input.headers);
    // Only names that exist in the file are kept.
    const mapping = Object.fromEntries(HEADER_FIELDS.map((field) => [field, parsed && typeof parsed[field] === 'string' && known.has(parsed[field]) ? parsed[field] : null]));
    const usage = { inputTokens: Number(payload?.usage?.prompt_tokens) || 0, outputTokens: Number(payload?.usage?.completion_tokens) || 0 };
    return { mapping, usage, model: modelId, ms: Date.now() - started, costUsd: estimateCostUsd(modelId, usage.inputTokens, usage.outputTokens) };
  } catch (failure) {
    if (failure && failure.name === 'AbortError') { const timeout = new Error('OPENAI_TIMEOUT'); timeout.code = 'OPENAI_TIMEOUT'; throw timeout; }
    throw failure;
  } finally { clearTimeout(timer); }
  } });
}

// The batch summary the browser sends back after the import (no row content, no prompt).
function sanitizeSummary(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const int = (key) => { const number = Number(source[key]); return Number.isFinite(number) && number >= 0 ? Math.min(Math.round(number), 10000000) : 0; };
  const cost = Number(source.costUsd);
  return {
    provider: 'openai', model: cellText(source.model).slice(0, 60) || null, at: cellText(source.at).slice(0, 40) || null,
    rowsTotal: int('rowsTotal'), rowsDeterministic: int('rowsDeterministic'), rowsSentToAi: int('rowsSentToAi'), rowsAccepted: int('rowsAccepted'), rowsReview: int('rowsReview'),
    inputTokens: int('inputTokens'), outputTokens: int('outputTokens'), costUsd: Number.isFinite(cost) && cost >= 0 ? Math.round(cost * 1e6) / 1e6 : 0,
    ms: int('ms'), errors: int('errors'), timeouts: int('timeouts'), unavailable: source.unavailable === true,
    review: (Array.isArray(source.review) ? source.review : []).slice(0, 200).map((item) => ({ row: Number.isInteger(item && item.row) ? item.row : null, file: cellText(item && item.file).slice(0, 80), reason: cellText(item && item.reason).slice(0, 80) }))
  };
}

module.exports = { APPROVED_MODELS, DEFAULT_MODEL, FIELDS, HEADER_FIELDS, sanitizeHeaders, suggestHeaders, INSTRUCTIONS, MAX_ROWS, PRICES, SCHEMA, enabled, estimateCostUsd, model, sanitizeRow, sanitizeRows, sanitizeSummary, suggestRows };

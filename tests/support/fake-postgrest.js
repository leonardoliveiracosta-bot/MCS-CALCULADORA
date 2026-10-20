'use strict';
// Banco falso em memória que responde como o PostgREST do Supabase (GET/POST/PATCH com os filtros que o
// painel usa), para testar rotas e regras sem rede. Também grava cada chamada externa.
const crypto = require('node:crypto');

function matches(row, key, raw) {
  const value = String(raw);
  const actual = row[key];
  const [op, ...restParts] = value.split('.');
  const rest = restParts.join('.');
  if (value === 'is.null') return actual === null || actual === undefined;
  if (value === 'not.is.null') return actual !== null && actual !== undefined;
  if (value === 'is.true') return actual === true;
  if (value === 'is.false') return actual === false;
  if (op === 'eq') return String(actual) === rest;
  if (op === 'neq') return String(actual) !== rest;
  if (op === 'in') return rest.replace(/^\(|\)$/g, '').split(',').includes(String(actual));
  if (op === 'gt') return actual !== null && actual !== undefined && String(actual) > rest;
  if (op === 'gte') return actual !== null && actual !== undefined && String(actual) >= rest;
  if (op === 'lt') return actual !== null && actual !== undefined && String(actual) < rest;
  if (op === 'lte') return actual !== null && actual !== undefined && String(actual) <= rest;
  if (op === 'ilike') return new RegExp('^' + rest.replace(/\*/g, '.*') + '$', 'i').test(String(actual || ''));
  return true;
}
const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'and', 'or', 'on_conflict']);

function createFake(tables = {}, options = {}) {
  const calls = [];
  const db = tables;
  const json = (status, body) => ({ ok: status < 400, status, headers: new Map(), json: async () => body, text: async () => (body === null ? '' : JSON.stringify(body)) });
  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = String(init.method || 'GET').toUpperCase();
    calls.push({ host: url.host, path: url.pathname, method, body: init.body });
    if (options.external && url.host !== 'mock.supabase') return options.external(url, init, method);
    if (url.host !== 'mock.supabase') return json(599, { error: 'NO_NETWORK_IN_TEST' });
    const rpcName = (/^\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname) || [])[1];
    if (rpcName) { const fn = options.rpc && options.rpc[rpcName]; return fn ? json(200, await fn(JSON.parse(init.body || '{}'))) : json(404, { message: 'RPC_NOT_FAKED' }); }
    const table = (/^\/rest\/v1\/([a-z0-9_]+)$/.exec(url.pathname) || [])[1];
    if (!table) return json(404, {});
    db[table] = db[table] || [];
    const filters = [...url.searchParams.entries()].filter(([k]) => !RESERVED.has(k));
    let list = db[table].filter((row) => filters.every(([k, v]) => matches(row, k, v)));
    if (method === 'GET') {
      const order = url.searchParams.get('order');
      if (order) { const [col, dir] = order.split(',')[0].split('.'); list = list.slice().sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 100000);
      return json(200, list.slice(offset, offset + limit).map((row) => ({ ...row })));
    }
    const body = JSON.parse(init.body || 'null');
    const wantsRows = /return=representation/.test(String((init.headers || {}).prefer || ''));
    if (method === 'POST') {
      const now = new Date().toISOString();
      const created = (Array.isArray(body) ? body : [body]).map((row) => ({ id: crypto.randomUUID(), created_at: now, ...(table === 'panel_assistant_proposals' ? { status: 'PENDENTE', expires_at: new Date(Date.now() + 600000).toISOString() } : {}), ...row }));
      db[table].push(...created);
      return wantsRows ? json(201, created) : json(201, null);
    }
    if (method === 'PATCH') { list.forEach((row) => Object.assign(row, body)); return wantsRows ? json(200, list.map((row) => ({ ...row }))) : json(204, null); }
    return json(405, {});
  }
  return { db, calls, fetchImpl };
}

module.exports = { createFake };

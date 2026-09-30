'use strict';

// Simulated Supabase for local tests: a PGlite database with every migration, served through the
// same REST paths the panel uses (/auth/v1/user, /rest/v1/<table>, /rest/v1/rpc/<fn>). The real
// api/panel handlers run against it. Any other URL is refused and recorded, so a test can prove
// that nothing (Anthropic, OpenAI, Supabase, WhatsApp) was reached.
const { migratedDatabase } = require('../sql/run');

const BASE = 'http://banco-simulado.local';
const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error('IDENTIFICADOR_INVALIDO ' + name);
  return '"' + name + '"';
};

// A column, or a JSON path like dados->>ref (PostgREST syntax).
const columnRef = (name) => {
  const match = /^([a-z_][a-z0-9_]*)((?:->>?[a-z_][a-z0-9_]*)*)$/i.exec(name);
  if (!match) throw new Error('IDENTIFICADOR_INVALIDO ' + name);
  return ident(match[1]) + match[2].replace(/(->>?)([a-z_][a-z0-9_]*)/gi, "$1'$2'");
};

function whereClause(params, values) {
  const parts = [];
  for (const [key, raw] of params) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue;
    const column = columnRef(key);
    const negated = raw.startsWith('not.');
    const text = negated ? raw.slice(4) : raw;
    const dot = text.indexOf('.');
    const op = text.slice(0, dot), value = text.slice(dot + 1);
    let sql;
    if (op === 'is') sql = `${column} is ${value === 'null' ? 'null' : value === 'true' ? 'true' : 'false'}`;
    else if (op === 'in') { values.push(value.replace(/^\(|\)$/g, '').split(',').map((item) => item.replace(/^"|"$/g, ''))); sql = `${column}::text = any($${values.length}::text[])`; }
    else if (op === 'ilike' || op === 'like') { values.push(value.replace(/\*/g, '%')); sql = `${column}::text ${op} $${values.length}::text`; }
    else {
      const sign = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      if (!sign) throw new Error('OPERADOR_NAO_SIMULADO ' + op);
      values.push(value); sql = `${column}::text ${sign} $${values.length}::text`;
      if (['gt', 'gte', 'lt', 'lte'].includes(op)) { values.pop(); values.push(value); sql = `${column} ${sign} $${values.length}`; }
    }
    parts.push(negated ? `not (${sql})` : sql);
  }
  return parts.length ? ' where ' + parts.join(' and ') : '';
}

function orderClause(order) {
  if (!order) return '';
  return ' order by ' + order.split(',').map((part) => {
    const [column, direction, nulls] = part.split('.');
    return `${ident(column)} ${direction === 'desc' ? 'desc' : 'asc'}${nulls === 'nullslast' ? ' nulls last' : nulls === 'nullsfirst' ? ' nulls first' : ''}`;
  }).join(', ');
}

async function createBackend({ seed } = {}) {
  const { db } = await migratedDatabase();
  if (seed) await db.exec(seed);
  const refused = [];
  const calls = [];
  const columns = async (table) => (await db.query(`select column_name from information_schema.columns where table_schema='public' and table_name=$1`, [table])).rows.map((row) => row.column_name);

  async function rest(method, pathname, search, body, prefer) {
    const table = pathname.replace('/rest/v1/', '');
    if (table.startsWith('rpc/')) {
      const fn = table.slice(4);
      const args = Object.entries(body || {});
      const signature = (await db.query(`select pg_get_function_arguments(p.oid) args, p.proretset retset from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=$1`, [fn])).rows[0];
      if (!signature) throw Object.assign(new Error('RPC_NAO_EXISTE'), { status: 404 });
      const types = Object.fromEntries(signature.args.split(',').map((item) => item.trim().split(/\s+/)).map(([name, type]) => [name, type]));
      // PostgREST takes a JSON array for an array parameter (uuid[], text[]); objects go as json.
      const values = args.map(([name, value]) => Array.isArray(value) && String(types[name] || '').endsWith('[]') ? value : value !== null && typeof value === 'object' ? JSON.stringify(value) : value);
      const list = args.map(([name], index) => `${ident(name)} => $${index + 1}::${types[name] || 'text'}`).join(', ');
      // A set-returning function answers with its rows, as PostgREST does.
      if (signature.retset) return (await db.query(`select * from public.${ident(fn)}(${list})`, values)).rows;
      const result = (await db.query(`select public.${ident(fn)}(${list}) as result`, values)).rows[0].result;
      return result;
    }
    const params = [...new URLSearchParams(search)];
    const get = (key) => (params.find(([name]) => name === key) || [])[1];
    const values = [];
    if (method === 'GET') {
      const select = get('select') && get('select') !== '*' ? get('select').split(',').map((column) => ident(column.trim())).join(', ') : '*';
      let sql = `select ${select} from public.${ident(table)}${whereClause(params, values)}${orderClause(get('order'))}`;
      if (get('limit')) sql += ` limit ${Number(get('limit'))}`;
      if (get('offset')) sql += ` offset ${Number(get('offset'))}`;
      return (await db.query(sql, values)).rows;
    }
    const known = new Set(await columns(table));
    if (method === 'POST') {
      const list = Array.isArray(body) ? body : [body];
      const output = [];
      for (const row of list) {
        const keys = Object.keys(row).filter((key) => known.has(key));
        const rowValues = keys.map((key) => row[key] !== null && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key]);
        const conflict = get('on_conflict') && /ignore-duplicates/.test(prefer || '') ? ` on conflict (${get('on_conflict').split(',').map(ident).join(', ')}) do nothing` : '';
        output.push(...(await db.query(`insert into public.${ident(table)} (${keys.map(ident).join(', ')}) values (${keys.map((_, index) => '$' + (index + 1)).join(', ')})${conflict} returning *`, rowValues)).rows);
      }
      return /return=representation/.test(prefer || '') ? output : null;
    }
    if (method === 'PATCH') {
      const keys = Object.keys(body).filter((key) => known.has(key));
      keys.forEach((key) => values.push(body[key] !== null && typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key]));
      const set = keys.map((key, index) => `${ident(key)} = $${index + 1}`).join(', ');
      const rows = (await db.query(`update public.${ident(table)} set ${set}${whereClause(params, values)} returning *`, values)).rows;
      return /return=representation/.test(prefer || '') ? rows : null;
    }
    if (method === 'DELETE') {
      const rows = (await db.query(`delete from public.${ident(table)}${whereClause(params, values)} returning *`, values)).rows;
      return /return=representation/.test(prefer || '') ? rows : null;
    }
    throw new Error('METODO_NAO_SIMULADO ' + method);
  }

  async function fetchSimulated(input, options = {}) {
    const url = new URL(String(input));
    const method = String(options.method || 'GET').toUpperCase();
    if (url.origin !== BASE) {
      refused.push(url.href);
      throw new Error('REDE_BLOQUEADA ' + url.origin);
    }
    const headers = Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path: url.pathname, search: decodeURIComponent(url.search), body });
    const reply = (status, payload) => ({ ok: status < 400, status, json: async () => payload, text: async () => payload === null ? '' : JSON.stringify(payload) });
    if (url.pathname === '/auth/v1/user') return reply(200, { id: '68000000-0000-4000-8000-00000000a001', email: 'teste@example.test' });
    try {
      return reply(200, await rest(method, url.pathname, url.search, body, headers.prefer));
    } catch (error) {
      if (process.env.MODO_DEBUG) console.log('BANCO', method, url.pathname + decodeURIComponent(url.search), String(error.message));
      const code = /^[A-Z][A-Z0-9_]{2,60}$/.test(String(error.message)) ? error.message : 'ERRO_SIMULADO';
      // A unique violation answers 409, as PostgREST does.
      return reply(error.status || (error.code === '23505' ? 409 : 400), { message: code, detail: String(error.message) });
    }
  }

  return { db, BASE, fetch: fetchSimulated, refused, calls };
}

module.exports = { BASE, createBackend };

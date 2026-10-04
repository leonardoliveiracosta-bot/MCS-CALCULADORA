'use strict';

// Contador público da calculadora: conta sessões reais (uma por sid) nos últimos 30 dias, sem teste, sem preview,
// sem eventos que não são conclusão; "ready" só quem marcou prazo=now. A API devolve exatamente esses números.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');

const row = (sid, evento, prazo, { dias = 1, teste = false, origem = 'mycarscout.net' } = {}) =>
  `insert into public.calc_runs(created_at,is_test,origem,dados) values(now() - interval '${dias} days',${teste},'${origem}','${JSON.stringify({ sid, evento, prazo })}'::jsonb);`;
const seed = [
  row('s1', 'simulacao', 'now'), row('s1', 'simulacao', 'now'), row('s1', 'whatsapp', 'now'), // refresh/repetição: conta 1
  row('s2', 'busca', '30d'),
  row('s3', 'simulacao', '3mo'), row('s3', 'busca', 'now'), // marcou now em algum momento: ready
  row('s4', 'saida', 'now'), // só saída: não conta
  row('s5', 'simulacao', 'now', { teste: true }),
  row('s6', 'simulacao', 'now', { origem: 'mcs-calculadora.vercel.app' }),
  row('s7', 'simulacao', 'now', { dias: 31 }),
  row('', 'simulacao', 'now'), row('no-session', 'simulacao', 'now')
].join('\n');

let backend;
test.before(async () => { backend = await createBackend({ seed }); Object.assign(process.env, { SUPABASE_URL: BASE }); globalThis.fetch = backend.fetch; });
test.after(async () => { if (backend) await backend.db.close(); });

test('calc_public_stats conta sessões reais dos últimos 30 dias', async () => {
  const [{ r }] = (await backend.db.query(`select public.calc_public_stats(30) r`)).rows;
  assert.equal(r.total, 3); assert.equal(r.ready, 2); assert.equal(r.days, 30);
});

test('a API devolve os números reais, com cache público', async () => {
  const headers = {};
  const res = { statusCode: 200, payload: null, setHeader(k, v) { headers[k.toLowerCase()] = v; }, status(c) { this.statusCode = c; return this; }, json(v) { this.payload = v; return v; } };
  await require('../api/calc-stats')({ method: 'GET', url: '/api/calc-stats', headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload, { days: 30, total: 3, ready: 2 });
  assert.match(headers['cache-control'], /s-maxage=600/);
});

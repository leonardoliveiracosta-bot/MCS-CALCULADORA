'use strict';

// runAudit sobre o banco simulado (PGlite + PostgREST) com a migração do teto da OpenAI: o lote
// ABERTO criado com limite de US$ 2 passa a usar e mostrar US$ 50, continua conferindo depois de
// US$ 2 gastos, para no teto global sem pedir autorização, e a conferência PENDENTE por
// AUDIT_DEADLINE com 3 tentativas não é chamada de novo sozinha. OpenAI simulada.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const audit = require('../panel-manheim-audit');

const id = (n) => `6d400000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), UPLOAD = id(2);
const ENV = { OPENAI_API_KEY: 'chave-simulada', MANHEIM_MATCH_AUDIT_ENABLED: '1' };
const wish = { make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 };
const J = [id(10), id(20), id(30)];
const key = (journey) => `journey:${journey}:CARRO`;
const input = {
  upload: { id: UPLOAD, undone_at: null },
  demands: J.map((journey) => ({ key: key(journey), mode: 'CARRO', journeyId: journey, activeWishes: [wish], active: true, issues: [] })),
  matches: J.map((journey, index) => ({ id: id(500 + index), journey_id: journey, logical_mode: 'CARRO', demandKey: key(journey), match_kind: 'BATE', row_fingerprint: 'f' + index, vehicle_json: { parsed: { vin: 'VINT' + index, year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: 3000000 } } })),
  base: { journeyById: new Map(J.map((journey) => [journey, { id: journey, status: 'ATIVO', contact: { is_lead: true } }])), refsOf: () => [], calcRuns: [] }
};
const hashOf = (journey) => audit.buildGroups(input).find((group) => group.key === key(journey)).hash;
function fakeOpenAI(calls) {
  return async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 400, completion_tokens: 60 }, choices: [{ message: { content: JSON.stringify({ aprovado: true, divergencias: [] }) } }] }) };
  };
}
// The per-call JS check always passes here, so the database hold is what is being tested.
// (The per-call reservation of the US$ 50 stays the real one, in the database.)
const openBudget = { ...require('../panel-openai-budget'), spentUsd: async () => ({ total: 0 }), fits: () => true };

let backend, ctx;
test.before(async () => {
  backend = await createBackend({ seed: `
    insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','6d400000-0000-4000-8000-00000000a001','t@example.test','admin',true,false);
    insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) values('${UPLOAD}','preview',1,10,'${ACTOR}');
    ${J.map((journey, index) => `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(40 + index)}','preview','Pessoa fictícia ${index}','WHATSAPP_DIRECT',now(),now());
    insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${id(40 + index)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`).join('\n')}` });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: ACTOR, role: 'admin' } };
  // State like production on 2026-09-30, but with US$ 2.50 already spent (above the old limit):
  // the run was created with limit 2; demand J[0] is PENDENTE by AUDIT_DEADLINE with 3 attempts.
  await backend.db.query(`insert into public.manheim_audit_runs(environment,upload_id,status,estimate_usd,limit_usd,spent_usd) values('preview',$1,'ABERTO',0.003878,2,2.509014)`, [UPLOAD]);
  await backend.db.query(`insert into public.manheim_match_audits(environment,upload_id,demand_key,content_hash,rule_version,status,error_code,attempts,cost_usd,provider,model)
    values('preview',$1,$2,$3,'conferencia-v1','PENDENTE','AUDIT_DEADLINE',3,0.009014,'openai','gpt-6-luna'),
          ('preview',$1,'journey:antiga:CARRO',$4,'conferencia-v1','CONFERIDO',null,1,2.5,'openai','gpt-6-luna')`, [UPLOAD, key(J[0]), hashOf(J[0]), 'b'.repeat(64)]);
});
test.after(async () => { if (backend) await backend.db.close(); });

test('lote antigo passa de US$ 2 e mostra US$ 50; a pendente por AUDIT_DEADLINE tem uma única tentativa a mais', async () => {
  const calls = [];
  // The extra attempt of the pending demand (car VINT0) still gets no confirmation (provider error).
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (JSON.stringify(body).includes('VINT0')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 400, completion_tokens: 60 }, choices: [{ message: { content: JSON.stringify({ aprovado: true, divergencias: [] }) } }] }) };
  };
  const result = await audit.runAudit(ctx, input, { env: ENV, fetchImpl, budget: openBudget });
  assert.equal(calls.length, 3, JSON.stringify(result) + ' duas demandas novas + uma tentativa a mais da pendente');
  assert.ok(calls.every((body) => body.max_completion_tokens === 16000), 'saída limitada em toda chamada');
  assert.equal(result.awaitingAuthorization, undefined);
  const run = (await backend.db.query('select status,limit_usd,spent_usd from public.manheim_audit_runs where upload_id=$1', [UPLOAD])).rows[0];
  assert.equal(run.status, 'ABERTO');
  assert.equal(Number(run.limit_usd), 50);
  assert.ok(Number(run.spent_usd) > 2.509014, `gasto acumulado ${run.spent_usd}`);
  const pending = (await backend.db.query('select status,error_code,attempts,cost_usd from public.manheim_match_audits where demand_key=$1', [key(J[0])])).rows[0];
  assert.deepEqual([pending.status, pending.error_code, pending.attempts, Number(pending.cost_usd)], ['PENDENTE', 'OPENAI_FAILED', 4, 0.009014], 'continua pendente, nada aprovado');
  const state = await audit.viewState(ctx, input, { env: ENV });
  assert.equal(state.limitUsd, 50);
  assert.equal(state.run.limitUsd, 50);
  assert.deepEqual([state.byDemand[key(J[0])].status, state.byDemand[key(J[0])].canRetry, state.byDemand[key(J[0])].attempts], ['PENDENTE', false, 4], 'bloqueada, sem novo botão de tentativa');
  assert.equal(audit.usable(state.byDemand[key(J[0])]), false);
  // Nothing more: neither the next cycle nor the button calls again.
  await audit.runAudit(ctx, input, { env: ENV, fetchImpl, budget: openBudget });
  await audit.runAudit(ctx, input, { env: ENV, fetchImpl, budget: openBudget, manual: true, onlyKey: key(J[0]) });
  assert.equal(calls.length, 3);
  // Ledger: the two answers are on their audit rows (REGISTRADA); the refused call released.
  const ledger = (await backend.db.query("select status, count(*)::int n from public.openai_budget_holds where environment='preview' and feature='MANHEIM_AUDIT' group by status order by status")).rows;
  assert.deepEqual(ledger.map((row) => [row.status, row.n]), [['LIBERADA', 1], ['REGISTRADA', 2]]);
  const holds = (await backend.db.query("select count(*) filter (where status='ABERTA') open from public.manheim_audit_budget_holds where upload_id=$1", [UPLOAD])).rows[0];
  assert.equal(Number(holds.open), 0);
});

test('teto global: a reserva que passaria de US$ 50 é recusada no banco, sem chamada e sem pedir autorização', async () => {
  // Other features already took the budget close to US$ 50.
  const spent = Number((await backend.db.query("select public.panel_openai_spent_usd('preview') s")).rows[0].s);
  await backend.db.query(`insert into public.audit_log(environment,entity_type,action,after_json) values('preview','manheim_openai','READ',jsonb_build_object('costUsd',$1::numeric))`, [Math.round((50 - spent - 0.000001) * 1e6) / 1e6]);
  const more = { ...input, matches: input.matches.map((match) => ({ ...match, vehicle_json: { parsed: { ...match.vehicle_json.parsed, miles: 31000 } } })) };
  const calls = [];
  const result = await audit.runAudit(ctx, more, { env: ENV, fetchImpl: fakeOpenAI(calls), budget: openBudget });
  assert.equal(calls.length, 0);
  assert.equal(result.providerLimit, true);
  assert.equal(result.awaitingAuthorization, undefined);
  assert.equal((await backend.db.query('select status from public.manheim_audit_runs where upload_id=$1', [UPLOAD])).rows[0].status, 'ABERTO');
  const projected = Number((await backend.db.query("select public.panel_openai_spent_usd('preview') + coalesce((select sum(amount_usd) from public.manheim_audit_budget_holds where environment='preview' and status='ABERTA'),0) p")).rows[0].p);
  assert.ok(projected <= 50, `projetado ${projected}`);
});

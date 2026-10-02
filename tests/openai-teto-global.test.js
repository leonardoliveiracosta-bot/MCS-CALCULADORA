'use strict';

// OpenAI pelo saldo pré-pago informado, com reserva por chamada (openai_budget_holds), sem teto
// interno: as quatro funções (PESQUISAS, ENTRADA, conferência Manheim e leitura do CSV Manheim) ao
// mesmo tempo nunca passam do saldo; o limite é exato; sem saldo nada é chamado; falha ao gravar o custo deixa o custo contando e
// não paga de novo; tempo esgotado conta o pior caso; recusa do provedor libera; retomada sem
// chamada duplicada. Banco PGlite com as migrações e OpenAI simulada: nada sai da máquina.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const budget = require('../panel-openai-budget');
const triage = require('../panel-triage');
const search = require('../panel-search-requests');
const manheimAi = require('../panel-manheim-ai');
const audit = require('../panel-manheim-audit');

const id = (n) => `6e100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), UPLOAD = id(2);
const ENV = {
  VERCEL_ENV: 'production', OPENAI_API_KEY: 'chave-simulada',
  ENTRADA_OPENAI_ENABLED: '1', ENTRADA_OPENAI_MODEL: 'gpt-6-luna', ENTRADA_OPENAI_SINCE: '2026-01-01T00:00:00Z',
  SEARCH_EXTRACTION_AI_ENABLED: '1', SEARCH_EXTRACTION_MODEL: 'gpt-6-luna',
  MANHEIM_OPENAI_ENABLED: '1', MANHEIM_OPENAI_MODEL: 'gpt-6-luna', MANHEIM_MATCH_AUDIT_ENABLED: '1'
};
const person = (n, text) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(n + 1)}','preview','Pessoa fictícia ${n}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(n)}','preview','${id(n + 1)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(n + 2)}','preview','WHATSAPP','${id(n + 1)}','c-${n}','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n + 3)}','preview','${id(n + 2)}','WHATSAPP','CUSTOMER','${text}','x',now(),'s${n}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(n + 3)}','${id(n)}','IMPORT',now());`
].join('\n');
const PEOPLE = [100, 200, 300, 400, 500, 600];
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  `insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) values('${UPLOAD}','preview',1,10,'${ACTOR}');`,
  ...PEOPLE.map((n) => person(n, 'Quero comprar um Honda CR-V 2020 pela MCS'))
].join('\n');

const answers = {
  triage: (body) => ({ category: 'PRE_COMPRA_MCS', confidence: 'alta', reason: 'Quer comprar', evidence_ids: [JSON.parse(body.messages[1].content).mensagens.at(-1).id] }),
  search: () => ({ hasRequest: false, requests: [] }),
  csv: () => ({ rows: [] }),
  audit: () => ({ aprovado: true, divergencias: [] })
};
const kindOf = (body) => body.response_format?.json_schema?.name === 'triagem_entrada' ? 'triage' : body.response_format?.json_schema?.name === 'pedido_de_veiculo' ? 'search'
  : body.response_format?.json_schema?.name === 'manheim_rows' ? 'csv' : 'audit';
// Simulated OpenAI. During each call, the spend since the balance was informed is read: it must
// never pass that balance.
function openAI(calls, { delayMs = 20, fail = null } = {}) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    calls.projected = Math.max(calls.projected || 0, await projected());
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const kind = kindOf(body);
    if (fail && fail(kind, body)) return fail(kind, body);
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 400, completion_tokens: 60 }, choices: [{ message: { content: JSON.stringify(answers[kind](body)) } }] }) };
  };
}
const projected = async () => Number((await backend.db.query("select public.panel_openai_budget_state('preview')->>'projected' p")).rows[0].p);
let balance = null;
const ledger = async (where = '') => (await backend.db.query(`select feature,status,amount_usd,actual_usd from public.openai_budget_holds where environment='preview' ${where} order by created_at`)).rows;
// Informs a prepaid balance of exactly `remaining` (what the owner sees in the OpenAI console).
async function leave(remaining) {
  await backend.db.query("select public.panel_ai_set_balance('preview','OPENAI',$1,null)", [remaining]);
  balance = remaining;
  assert.equal(Number((await backend.db.query("select public.panel_ai_balance_state('preview','OPENAI')->>'remaining' r")).rows[0].r), remaining);
}
const auditInput = (journey) => {
  const key = `journey:${journey}:CARRO`;
  return {
    upload: { id: UPLOAD, undone_at: null },
    demands: [{ key, mode: 'CARRO', journeyId: journey, activeWishes: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], active: true, issues: [] }],
    matches: [{ id: id(900 + PEOPLE.indexOf(Number(journey.slice(-3)))), journey_id: journey, logical_mode: 'CARRO', demandKey: key, match_kind: 'BATE', row_fingerprint: 'f' + journey, vehicle_json: { parsed: { vin: 'VINTETO' + journey.slice(-3), year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: 3000000 } } }],
    base: { journeyById: new Map([[journey, { id: journey, status: 'ATIVO', contact: { is_lead: true } }]]), refsOf: () => [], calcRuns: [] }
  };
};
const csvRows = [{ id: '1', cells: { year: '2022', make: 'BMW', model: 'X5', miles: '45k mi', mmr: '41500' } }];
// The four features, each with its own US$ 50 reservation per call.
const runAll = (fetchImpl, options = {}) => Promise.all([
  triage.runTriage(ctx, { env: ENV, fetchImpl }).catch((error) => ({ error: error.code || error.message })),
  search.extractChat(ctx, id(PEOPLE[0] + 2), { env: ENV, fetchImpl }).catch((error) => ({ error: error.code || error.message })),
  manheimAi.suggestRows(csvRows, { env: ENV, fetchImpl, guard: budget.guard(ctx, 'MANHEIM_CSV', 'rows') }).then((out) => ({ csv: out.suggestions.length }), (error) => ({ error: error.code })),
  audit.runAudit(ctx, auditInput(id(options.auditJourney || PEOPLE[1])), { env: ENV, fetchImpl }).catch((error) => ({ error: error.code || error.message }))
]);

let backend, ctx;
test.before(async () => {
  backend = await createBackend({ seed });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: ACTOR, role: 'admin' } };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('custo máximo por chamada: entrada pelos bytes enviados, saída limitada em toda requisição', () => {
  const body = { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x'.repeat(10000) }], max_completion_tokens: 2000 };
  const bound = budget.maxCostUsd('gpt-6-luna', body);
  // 10000+ bytes at US$ 0.10/1M + 2000 tokens at US$ 0.50/1M.
  assert.ok(bound >= (10000 * 0.10 + 2000 * 0.50) / 1e6 && bound < 0.0025, String(bound));
  assert.throws(() => budget.maxCostUsd('gpt-6-luna', { messages: [] }), { code: 'OPENAI_OUTPUT_CAP_MISSING' });
  assert.throws(() => budget.maxCostUsd('modelo-sem-preco', body), { code: 'OPENAI_MODEL_PRICE_UNKNOWN' });
  assert.deepEqual(budget.OUTPUT_CAP, { PESQUISAS: 8000, MODELO_TESTE: 200, ENTRADA: 2000, MANHEIM_AUDIT: 16000, MANHEIM_CSV: 8000, RESPOSTA: 1500, RESPOSTA_ORIENTADA: 1500, TRADUCAO_CONVERSA: 8000 });
});

test('as quatro funções ao mesmo tempo, com saldo para todas: cada chamada reservada, paga e registrada', async () => {
  const calls = [];
  const [triaged, searched, csv, audited] = await runAll(openAI(calls));
  assert.equal(triaged.processed, PEOPLE.length, JSON.stringify(triaged));
  assert.ok(searched.runId, JSON.stringify(searched));
  assert.equal(csv.csv, 0);
  assert.equal(audited.approved, 1, JSON.stringify(audited));
  assert.equal(calls.length, PEOPLE.length + 3);
  assert.ok(calls.every((body) => body.max_completion_tokens > 0), 'saída limitada em toda chamada');
  const rows = await ledger();
  assert.equal(rows.length, calls.length, 'uma reserva por chamada');
  // CSV here was called without the handler that records it: its cost stays counted (PAGA).
  assert.deepEqual([...new Set(rows.filter((row) => row.feature !== 'MANHEIM_CSV').map((row) => row.status))], ['REGISTRADA']);
  assert.deepEqual(rows.filter((row) => row.feature === 'MANHEIM_CSV').map((row) => row.status), ['PAGA']);
  assert.ok(rows.every((row) => Number(row.actual_usd) <= Number(row.amount_usd)), 'custo real nunca acima do reservado');
  // No balance informed: no internal ceiling (US$ 50 or any other) stopped anything.
  assert.equal(triaged.stoppedReason || null, null);
});

test('as quatro funções ao mesmo tempo perto do fim do saldo: só entra o que cabe; nunca acima do saldo', async () => {
  // New content for every feature (new customer message, new batch content).
  for (const n of PEOPLE) await backend.db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n + 4)}','preview','${id(n + 2)}','WHATSAPP','CUSTOMER','Ainda quero o CR-V','x',now(),'t${n}',1,'WHATSAPP_WEBHOOK',now())`);
  await leave(0.01);
  const calls = [];
  const results = await runAll(openAI(calls), { auditJourney: PEOPLE[2] });
  const after = await projected();
  assert.ok(after <= balance, `projetado ${after}`);
  assert.ok(calls.projected <= balance, `projetado durante as chamadas ${calls.projected}`);
  // With US$ 0.01 left, a few calls fit and the rest was refused before calling anything.
  assert.ok(calls.length >= 1 && calls.length < PEOPLE.length + 3, `${calls.length} chamadas`);
  assert.equal(results[0].stoppedReason, 'PROVIDER_LIMIT', JSON.stringify(results[0]));
  // Every call made had its reservation; nothing was called without one.
  assert.equal((await ledger()).length, PEOPLE.length + 3 + calls.length);
});

test('limite exato e sem saldo: a chamada que passaria do saldo não sai; nada é gasto nem tentativa consumida', async () => {
  await leave(0);
  const calls = [];
  for (const n of PEOPLE) await backend.db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n + 5)}','preview','${id(n + 2)}','WHATSAPP','CUSTOMER','Tem novidade?','x',now(),'u${n}',1,'WHATSAPP_WEBHOOK',now())`);
  const before = (await ledger()).length;
  const [triaged, searched, csv, audited] = await runAll(openAI(calls), { auditJourney: PEOPLE[3] });
  assert.equal(calls.length, 0, 'nenhuma chamada');
  assert.equal((await ledger()).length, before, 'nenhuma reserva criada');
  assert.equal(triaged.stoppedReason, 'PROVIDER_LIMIT');
  assert.equal(searched.error, 'OPENAI_BUDGET_LIMIT');
  assert.equal(csv.error, 'OPENAI_BUDGET_LIMIT');
  assert.equal(audited.providerLimit, true);
  // Stopped before reserving the demand: no audit row, no attempt used.
  assert.equal((await backend.db.query('select count(*)::int n from public.manheim_match_audits where demand_key=$1', [`journey:${id(PEOPLE[3])}:CARRO`])).rows[0].n, 0);
  assert.equal(await projected(), 0);
  // A bound of exactly the remaining balance fits; one millionth more does not.
  // The balance is informed in cents, as in the provider's console.
  await leave(0.01);
  const exact = await backend.db.query("select public.panel_openai_budget_hold('preview','ENTRADA','x','gpt-6-luna',0.01) r");
  assert.equal(exact.rows[0].r.held, true);
  const over = await backend.db.query("select public.panel_openai_budget_hold('preview','ENTRADA','x','gpt-6-luna',0.000001) r");
  assert.equal(over.rows[0].r.held, false);
  await backend.db.query("select public.panel_openai_budget_settle('preview',$1,'LIBERADA')", [exact.rows[0].r.id]);
});

test('falha ao gravar o custo: o custo continua contando e a mesma leitura não é paga de novo', async () => {
  await leave(5);
  const calls = [];
  // ENTRADA: the answer arrives, the triage row cannot be written.
  const failing = await triage.runTriage(ctx, { env: ENV, fetchImpl: openAI(calls), record: async () => { throw Object.assign(new Error('GRAVACAO_FALHOU'), { code: 'GRAVACAO_FALHOU' }); } }).catch((error) => ({ error: error.code }));
  assert.equal(failing.error, 'GRAVACAO_FALHOU');
  assert.equal(calls.length, 1);
  const paid = (await ledger("and feature='ENTRADA' and status='PAGA'"));
  assert.equal(paid.length, 1, 'o custo pago e não gravado continua contando');
  const counted = await projected();
  assert.ok(Math.abs(counted - Number(paid[0].actual_usd)) < 1e-6, `projetado ${counted}`);
  // Next cycle: the same content is not paid again.
  await triage.runTriage(ctx, { env: ENV, fetchImpl: openAI(calls) });
  assert.equal(calls.filter((body) => kindOf(body) === 'triage' && body.messages[1].content.includes(id(PEOPLE[0] + 5))).length, 1, 'mesma conversa não chamada de novo');
  // PESQUISAS: the run cannot be written.
  const chat = id(PEOPLE[1] + 2);
  const before = calls.length;
  const out = await search.extractChat(ctx, chat, { env: ENV, fetchImpl: openAI(calls), services: { insert: async () => { throw Object.assign(new Error('GRAVACAO_FALHOU'), { code: 'GRAVACAO_FALHOU' }); } } }).catch((error) => ({ error: error.code }));
  assert.equal(out.error, 'GRAVACAO_FALHOU');
  assert.equal(calls.length, before + 1);
  assert.equal((await ledger("and feature='PESQUISAS' and status='PAGA'")).length, 1);
  const again = await search.extractChat(ctx, chat, { env: ENV, fetchImpl: openAI(calls) });
  assert.equal(again.inProgress, true);
  assert.equal(calls.length, before + 1, 'não paga de novo');
});

test('tempo esgotado conta o pior caso; recusa do provedor libera a reserva', async () => {
  await leave(5);
  const guardTimeout = budget.guard(ctx, 'MANHEIM_CSV', 'timeout');
  const timeout = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(manheimAi.suggestRows(csvRows, { env: ENV, fetchImpl: timeout, guard: guardTimeout }), { code: 'OPENAI_TIMEOUT' });
  const [timed] = await ledger("and subject='timeout'");
  assert.deepEqual([timed.status, Number(timed.actual_usd)], ['PAGA', Number(timed.amount_usd)]);
  const refused = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(manheimAi.suggestRows(csvRows, { env: ENV, fetchImpl: refused, guard: budget.guard(ctx, 'MANHEIM_CSV', 'recusa') }), { code: 'OPENAI_FAILED' });
  const [released] = await ledger("and subject='recusa'");
  assert.deepEqual([released.status, Number(released.actual_usd)], ['LIBERADA', 0]);
});

test('retomada sem duplicar: cron e botão ao mesmo tempo leem a mesma conversa uma vez (PESQUISAS)', async () => {
  await leave(5);
  const chat = id(PEOPLE[4] + 2);
  const calls = [];
  const fetchImpl = openAI(calls, { delayMs: 60 });
  const [left, right] = await Promise.all([search.extractChat(ctx, chat, { env: ENV, fetchImpl }), search.extractChat(ctx, chat, { env: ENV, fetchImpl })]);
  assert.equal(calls.length, 1);
  assert.equal([left, right].filter((item) => item.inProgress).length, 1);
  assert.equal((await backend.db.query('select count(*)::int n from public.vehicle_request_runs where chat_id=$1', [chat])).rows[0].n, 1);
  // Produção sem guarda: nunca chama.
  const saved = process.env.VERCEL_ENV;
  process.env.VERCEL_ENV = 'production';
  try { await assert.rejects(manheimAi.suggestRows(csvRows, { env: ENV, fetchImpl }), { code: 'OPENAI_BUDGET_GUARD_MISSING' }); }
  finally { process.env.VERCEL_ENV = saved; }
  assert.equal(calls.length, 1);
});

test('nenhuma mensagem sai: só o banco simulado e a OpenAI simulada foram chamados', () => {
  assert.deepEqual(backend.refused, []);
});

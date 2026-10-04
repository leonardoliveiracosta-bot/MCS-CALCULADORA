'use strict';

// Reserva atômica antes da OpenAI: cron e botão ao mesmo tempo fazem uma única chamada, uma única
// cobrança e um único resultado; a outra execução recebe "já em processamento". Reserva abandonada
// é retomada depois do prazo. Banco PGlite com as migrações e OpenAI simulada.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const triage = require('../panel-triage');
const audit = require('../panel-manheim-audit');
const aiClaim = require('../panel-ai-claim');

const id = (n) => `6c200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), UPLOAD = id(2);
const ENV = { ENTRADA_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'chave-simulada', ENTRADA_OPENAI_MODEL: 'gpt-6-luna', ENTRADA_OPENAI_SINCE: '2026-01-01T00:00:00Z', MANHEIM_MATCH_AUDIT_ENABLED: '1' };
const person = (n, text) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(n + 1)}','preview','Pessoa ${n}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${id(n)}','preview','${id(n + 1)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(n + 2)}','preview','WHATSAPP','${id(n + 1)}','c-${n}','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n + 3)}','preview','${id(n + 2)}','WHATSAPP','CUSTOMER','${text}','x',now(),'s${n}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(n + 3)}','${id(n)}','IMPORT',now());`
].join('\n');
function seed() {
  return [
    `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
    person(10, 'Quero comprar um carro pela MCS'), person(20, 'Outra conversa de compra'), person(30, 'Terceira conversa'),
    // The first person is also in "Precisa de você": the cron and the button both see her conversation.
    `insert into public.whatsapp_link_suggestions(environment,source_contact_id,source_journey_id,source_chat_id,target_contact_id,target_journey_id,phone_e164,status,suggestion_kind) values('preview','${id(11)}','${id(10)}','${id(12)}','${id(21)}','${id(20)}','+14075550100','PENDING','AI');`,
    `insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) values('${UPLOAD}','preview',1,10,'${ACTOR}');`
  ].join('\n');
}
// Slow simulated OpenAI: both runs are in flight at the same time.
function slowOpenAI(calls, reply) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const content = reply ? reply(body) : JSON.stringify({ category: 'PRE_COMPRA_MCS', confidence: 'alta', reason: 'Quer comprar', evidence_ids: [JSON.parse(body.messages[1].content).mensagens.at(-1).id] });
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 400, completion_tokens: 60 }, choices: [{ message: { content } }] }) };
  };
}

let backend, ctx;
test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.OPENAI_API_KEY; delete process.env.ENTRADA_OPENAI_ENABLED; delete process.env.MANHEIM_MATCH_AUDIT_ENABLED;
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: ACTOR, role: 'admin' } };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('a função de reserva: um vencedor; concluída nunca volta; liberada pode ser retomada', async () => {
  const task = { kind: 'ENTRADA_TRIAGE', subject: 'teste', hash: 'a'.repeat(64), rule: 'r1' };
  const [first, second] = await Promise.all([aiClaim.claimTask(ctx, task), aiClaim.claimTask(ctx, task)]);
  assert.deepEqual([first.claimed, second.claimed].sort(), [false, true]);
  const winner = first.claimed ? first : second;
  await aiClaim.finishTask(ctx, winner, false);
  const retry = await aiClaim.claimTask(ctx, task);
  assert.equal(retry.claimed, true, 'liberada: pode tentar de novo');
  await aiClaim.finishTask(ctx, retry, true);
  assert.equal((await aiClaim.claimTask(ctx, task)).claimed, false, 'concluída: nunca mais');
  // Only the owner's token ends a reservation.
  const other = await aiClaim.claimTask(ctx, { ...task, hash: 'b'.repeat(64) });
  assert.deepEqual(await aiClaim.finishTask(ctx, { ...other, token: id(999) }, true), { finished: false });
});

test('cron e botão "Precisa de você" ao mesmo tempo: uma chamada, uma cobrança, um resultado', async () => {
  const calls = [];
  const fetchImpl = slowOpenAI(calls);
  const [cron, button] = await Promise.all([
    triage.runTriage(ctx, { env: ENV, fetchImpl }),
    triage.runPending(ctx, { env: ENV, fetchImpl })
  ]);
  const chat = id(12);
  const forChat = calls.filter((body) => JSON.stringify(body).includes('Quero comprar um carro pela MCS'));
  assert.equal(forChat.length, 1, 'uma única chamada para a conversa disputada');
  assert.equal(cron.inProgress + button.inProgress, 1, 'a outra execução recebeu "já em processamento"');
  const rows = (await backend.db.query("select status,cost_usd from public.conversation_triage where chat_id=$1 and source='AI'", [chat])).rows;
  assert.equal(rows.length, 1, 'um único resultado');
  assert.equal(rows.filter((row) => row.status === 'ACTIVE').length, 1);
  assert.equal(rows.reduce((sum, row) => sum + Number(row.cost_usd), 0), Number(rows[0].cost_usd), 'uma única cobrança registrada');
  const claims = (await backend.db.query("select status,attempts from public.ai_task_claims where task_kind='ENTRADA_TRIAGE' and subject_key=$1", [chat])).rows;
  assert.deepEqual(claims.map((row) => [row.status, row.attempts]), [['CONCLUIDA', 1]]);
  // Running both again pays nothing.
  const again = [];
  await Promise.all([triage.runTriage(ctx, { env: ENV, fetchImpl: slowOpenAI(again) }), triage.runPending(ctx, { env: ENV, fetchImpl: slowOpenAI(again) })]);
  assert.equal(again.length, 0);
});

test('reserva abandonada: dentro do prazo ninguém chama; depois do prazo é retomada uma vez', async () => {
  // A new customer message for the third person, whose run "crashed" after reserving.
  await backend.db.query(`insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(39)}','preview','${id(32)}','WHATSAPP','CUSTOMER','Mais uma pergunta','x',now()+interval '1 minute','s39',1,'WHATSAPP_WEBHOOK',now()+interval '1 minute')`);
  await backend.db.query(`insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(39)}','${id(30)}','IMPORT',now())`);
  const item = (await triage.candidates(ctx, { env: ENV })).find((entry) => entry.chatId === id(32));
  await backend.db.query(`insert into public.ai_task_claims(environment,task_kind,subject_key,content_hash,rule_version,status,claim_token,expires_at) values('preview','ENTRADA_TRIAGE',$1,$2,$3,'RESERVADA',gen_random_uuid(),now()+interval '4 minutes')`, [id(32), item.contentHash, triage.RULE_VERSION]);
  const calls = [];
  const busy = await triage.runTriage(ctx, { env: ENV, fetchImpl: slowOpenAI(calls) });
  assert.equal(calls.length, 0, 'reserva ainda válida: já em processamento');
  assert.equal(busy.inProgress, 1);
  // The crashed run never came back: after the safe period the reservation is taken over.
  await backend.db.query("update public.ai_task_claims set expires_at=now()-interval '1 second' where subject_key=$1 and content_hash=$2", [id(32), item.contentHash]);
  const [left, right] = await Promise.all([triage.runTriage(ctx, { env: ENV, fetchImpl: slowOpenAI(calls) }), triage.runTriage(ctx, { env: ENV, fetchImpl: slowOpenAI(calls) })]);
  assert.equal(calls.length, 1, 'retomada por uma única execução');
  assert.equal(left.processed + right.processed, 1);
  assert.deepEqual((await backend.db.query("select status,attempts from public.ai_task_claims where subject_key=$1 and content_hash=$2", [id(32), item.contentHash])).rows.map((row) => [row.status, row.attempts]), [['CONCLUIDA', 2]]);
});

test('conferência Manheim: disparo do upload e cron ao mesmo tempo fazem uma chamada por demanda', async () => {
  const key = `journey:${id(10)}:CARRO`;
  const input = {
    upload: { id: UPLOAD, undone_at: null },
    demands: [{ key, mode: 'CARRO', journeyId: id(10), activeWishes: [{ make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 }], active: true, issues: [] }],
    matches: [{ id: id(500), journey_id: id(10), logical_mode: 'CARRO', demandKey: key, match_kind: 'BATE', row_fingerprint: 'f', vehicle_json: { parsed: { lane: '1', run: '1', vin: 'VINX', year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: 3000000 } } }],
    base: { journeyById: new Map([[id(10), { id: id(10), status: 'ATIVO', contact: { is_lead: true } }]]), refsOf: () => [], calcRuns: [] }
  };
  const calls = [];
  const fetchImpl = slowOpenAI(calls, () => JSON.stringify({ aprovado: true, divergencias: [] }));
  const results = await Promise.all([audit.runAudit(ctx, input, { env: ENV, fetchImpl }), audit.runAudit(ctx, input, { env: ENV, fetchImpl })]);
  assert.equal(calls.length, 1);
  assert.equal(results[0].inProgress + results[1].inProgress, 1);
  const rows = (await backend.db.query('select status,cost_usd from public.manheim_match_audits where demand_key=$1', [key])).rows;
  assert.deepEqual(rows.map((row) => row.status), ['CONFERIDO']);
  assert.ok(Number(rows[0].cost_usd) > 0);
});

test('saldo pré-pago atômico: duas demandas ao mesmo tempo nunca passam juntas do saldo da OpenAI (sem limite por lote)', async () => {
  const UPLOAD2 = id(3);
  await backend.db.query(`insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) values('${UPLOAD2}','preview',1,10,'${ACTOR}')`);
  const wish = { make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 60000 };
  const keyA = `journey:${id(10)}:CARRO`, keyB = `journey:${id(20)}:CARRO`;
  const match = (n, journey, key) => ({ id: id(n), journey_id: journey, logical_mode: 'CARRO', demandKey: key, match_kind: 'BATE', row_fingerprint: 'f' + n, vehicle_json: { parsed: { lane: '1', run: '1', vin: 'VIN' + n, year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: 3000000 } } });
  const input = {
    upload: { id: UPLOAD2, undone_at: null },
    demands: [keyA, keyB].map((key, index) => ({ key, mode: 'CARRO', journeyId: [id(10), id(20)][index], activeWishes: [wish], active: true, issues: [] })),
    matches: [match(600, id(10), keyA), match(601, id(20), keyB)],
    base: { journeyById: new Map([id(10), id(20)].map((journey) => [journey, { id: journey, status: 'ATIVO', contact: { is_lead: true } }])), refsOf: () => [], calcRuns: [] }
  };
  // Prepaid balance of US$ 0.01: one reading's worst case (~US$ 0.0085) fits, two do not.
  await backend.db.query("select public.panel_ai_set_balance('preview','OPENAI',0.01,null)");
  // The JS pre-check always passes here, so the database reservation is what is being tested.
  const openBudget = { ...require('../panel-openai-budget'), spentUsd: async () => ({ total: 0 }), fits: () => true };
  const calls = [];
  const fetchImpl = slowOpenAI(calls, () => JSON.stringify({ aprovado: true, divergencias: [] }));
  const [left, right] = await Promise.all([
    audit.runAudit(ctx, input, { env: ENV, fetchImpl, onlyKey: keyA, budget: openBudget }),
    audit.runAudit(ctx, input, { env: ENV, fetchImpl, onlyKey: keyB, budget: openBudget })
  ]);
  assert.equal(calls.length, 1, 'só a demanda que cabe no saldo chama a OpenAI');
  assert.equal([left, right].filter((result) => result.awaitingAuthorization).length, 0, 'nada fica aguardando autorização');
  const state = await audit.viewState(ctx, input, { env: ENV });
  const statuses = [state.byDemand[keyA].status, state.byDemand[keyB].status].sort();
  assert.ok(statuses.includes('CONFERIDO'), JSON.stringify(statuses));
  assert.notEqual(state.run.status, 'AGUARDANDO_AUTORIZACAO');
  const balance = (await backend.db.query("select public.panel_ai_balance_state('preview','OPENAI') s")).rows[0].s;
  assert.ok(Number(balance.spent) > 0 && Number(balance.spent) <= 0.01, `gasto ${balance.spent} dentro do saldo`);
});

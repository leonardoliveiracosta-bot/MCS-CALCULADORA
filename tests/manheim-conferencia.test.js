'use strict';

// MANHEIM_MATCH_AUDIT: conferência dos matches do Manheim pela OpenAI. Banco PGlite com todas as
// migrações e OpenAI simulada: nenhuma chamada externa real, nenhuma cobrança, nenhum dado real.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const audit = require('../panel-manheim-audit');
const vitrines = require('../api/panel/vitrines');

const id = (n) => `6a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1), UPLOAD = id(2);
const J = { valor: id(10), carro: id(20), closed: id(30), nolead: id(40) };
const ENV = { MANHEIM_MATCH_AUDIT_ENABLED: '1', OPENAI_API_KEY: 'chave-simulada' };

function seed() {
  const rows = [`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`];
  Object.values(J).forEach((journey, index) => {
    const contact = id(100 + index);
    rows.push(`insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${contact}','preview','Maria Cliente ${index}','WHATSAPP_DIRECT',now(),now());`);
    rows.push(`insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,created_at,updated_at) values('${journey}','preview','${contact}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','{}',now(),now());`);
  });
  rows.push(`insert into public.manheim_uploads(id,environment,source_file_count,vehicle_count,created_by) values('${UPLOAD}','preview',2,9998,'${ACTOR}');`);
  return rows.join('\n');
}

// What the BUSCAS view hands to the audit (the same shape manheimView builds).
const car = (n, journeyId, mode, kind, parsed) => ({ id: id(1000 + n), journey_id: journeyId, logical_mode: mode, match_kind: kind, row_fingerprint: 'f' + n, vehicle_json: { parsed, raw: { 'Lot #': 'L' + n } } });
const valorWish = { make: 'Toyota', model: 'RAV4' };
const carroWish = { make: 'Honda', model: 'CR-V', yearMin: 2019, yearMax: 2022, minMiles: 10000, maxMiles: 60000 };
function input(extra = {}) {
  const demands = [
    { key: `journey:${J.valor}:VALOR`, mode: 'VALOR', journeyId: J.valor, activeWishes: [valorWish], bidCents: 3000000, active: true, issues: [] },
    { key: `journey:${J.carro}:CARRO`, mode: 'CARRO', journeyId: J.carro, activeWishes: [carroWish], bidCents: null, active: true, issues: [] },
    { key: `journey:${J.closed}:CARRO`, mode: 'CARRO', journeyId: J.closed, activeWishes: [carroWish], bidCents: null, active: true, issues: [] },
    { key: `journey:${J.nolead}:CARRO`, mode: 'CARRO', journeyId: J.nolead, activeWishes: [carroWish], bidCents: null, active: true, issues: [] }
  ];
  const matches = [
    car(1, J.valor, 'VALOR', 'POR_VALOR', { vin: 'VINVALOR000000001', year: 2021, make: 'Toyota', model: 'RAV4', miles: 40000, mmrCents: 2800000 }),
    car(2, J.valor, 'VALOR', 'POR_VALOR', { vin: 'VINVALOR000000002', year: 2018, make: 'Toyota', model: 'RAV4', miles: 90000, mmrCents: 3300000 }),
    car(3, J.carro, 'CARRO', 'BATE', { vin: 'VINCARRO000000003', year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: 9900000 }),
    car(4, J.closed, 'CARRO', 'BATE', { vin: 'VINCLOSED00000004', year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: null }),
    car(5, J.nolead, 'CARRO', 'BATE', { vin: 'VINNOLEAD00000005', year: 2020, make: 'Honda', model: 'CR-V', miles: 30000, mmrCents: null })
  ].map((match) => ({ ...match, demandKey: `journey:${match.journey_id}:${match.logical_mode}` }));
  const journeyById = new Map([
    [J.valor, { id: J.valor, status: 'ATIVO', reference_code: 'AAAAA', budget_cents: 3000000, confirmed_total_ceiling_cents: 4000000, contact: { is_lead: true, display_name: 'Maria Cliente 0' } }],
    [J.carro, { id: J.carro, status: 'ATIVO', reference_code: 'BBBBB', contact: { is_lead: true, display_name: 'Maria Cliente 1' } }],
    [J.closed, { id: J.closed, status: 'ENCERRADO', reference_code: 'CCCCC', contact: { is_lead: true } }],
    [J.nolead, { id: J.nolead, status: 'ATIVO', reference_code: 'DDDDD', contact: { is_lead: false } }]
  ]);
  const value = { upload: { id: UPLOAD, undone_at: null }, demands, matches, base: { journeyById, refsOf: () => [], calcRuns: [] } };
  return extra.mutate ? extra.mutate(value) : value;
}

function fakeOpenAI(answer, calls) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, payload: JSON.parse(body.messages[1].content) });
    const reply = typeof answer === 'function' ? answer(JSON.parse(body.messages[1].content)) : answer;
    if (reply instanceof Error) throw reply;
    if (reply && reply.status) return { ok: false, status: reply.status, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 500, completion_tokens: 80 }, choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }) };
  };
}
const approveAll = () => ({ aprovado: true, divergencias: [] });

let backend, ctx;
const statusOf = async (key) => (await backend.db.query('select status,error_code,attempts,provider,model,rule_version,input_tokens,output_tokens,cost_usd,divergences,approved_reason from public.manheim_match_audits where demand_key=$1 order by created_at desc limit 1', [key])).rows[0];
test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  delete process.env.MANHEIM_MATCH_AUDIT_ENABLED; delete process.env.OPENAI_API_KEY;
  globalThis.fetch = backend.fetch;
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: ACTOR, role: 'admin' } };
});
test.after(async () => { if (backend) await backend.db.close(); });

test('nasce desligada, flag própria, modelo fixo da allowlist e sem modelo reserva', async () => {
  assert.equal(audit.status({}), 'DESLIGADA');
  assert.equal(audit.status({ ENTRADA_OPENAI_ENABLED: '1', MANHEIM_OPENAI_ENABLED: '1', OPENAI_API_KEY: 'x' }), 'DESLIGADA', 'não reutiliza as flags das outras funções');
  assert.equal(audit.status({ ...ENV, OPENAI_API_KEY: '' }), 'SEM_CHAVE');
  assert.equal(audit.status({ ...ENV, MANHEIM_MATCH_AUDIT_MODEL: 'gpt-5.4-nano' }), 'MODELO_INVALIDO');
  assert.equal(audit.status(ENV), 'LIGADA');
  assert.equal(audit.model(ENV), 'gpt-6-luna');
  const calls = [];
  assert.deepEqual(await audit.runAudit(ctx, input(), { env: {}, fetchImpl: fakeOpenAI(approveAll, calls) }), { skipped: 'DESLIGADA', processed: 0 });
  assert.deepEqual(await audit.viewState(ctx, input(), { env: {} }), { state: 'DESLIGADA', byDemand: {} });
  assert.equal(calls.length, 0);
  // Off: V1 is never held.
  assert.equal(await vitrines.auditGate(ctx, [id(1001)]), null);
});

test('checagem local: ficha encerrada e contato não-lead vão para Revisar sem chamada; opções visíveis', async () => {
  const groups = audit.buildGroups(input());
  const byKey = Object.fromEntries(groups.map((group) => [group.key, group]));
  assert.deepEqual(byKey[`journey:${J.valor}:VALOR`].divergences, []);
  assert.deepEqual(byKey[`journey:${J.carro}:CARRO`].divergences, []);
  assert.deepEqual(byKey[`journey:${J.closed}:CARRO`].divergences.map((item) => item.code), ['JOURNEY_CLOSED']);
  assert.deepEqual(byKey[`journey:${J.nolead}:CARRO`].divergences.map((item) => item.code), ['NOT_LEAD']);
  // Other facts: VIN repeated, split duplicate, match without mode, rule broken, ceiling as bid,
  // test record, undone batch and incomplete demand.
  const broken = audit.buildGroups(input({ mutate: (value) => {
    const [valor] = value.matches;
    value.matches.push({ ...valor, id: id(1101), row_fingerprint: 'dup' });
    value.matches.push({ ...car(12, J.carro, 'CARRO', 'BATE', { vin: '', year: 2020, make: 'Honda', model: 'CR-V', miles: 20000 }), demandKey: `journey:${J.carro}:CARRO` });
    value.matches.push({ ...car(13, J.carro, 'CARRO', 'BATE', { vin: '', year: 2020, make: 'Honda', model: 'CR-V', miles: 20000 }), demandKey: `journey:${J.carro}:CARRO` });
    value.matches.push({ ...car(14, J.carro, 'CARRO', 'BATE', { vin: 'VINOLD', year: 2015, make: 'Honda', model: 'CR-V', miles: 20000 }), demandKey: `journey:${J.carro}:CARRO` });
    value.matches.push({ ...car(15, J.carro, null, 'BATE', { vin: 'VINNOMODE', year: 2020, make: 'Honda', model: 'CR-V', miles: 20000 }), demandKey: `journey:${J.carro}:CARRO` });
    value.demands[0].bidCents = 4000000;
    value.base.calcRuns = [{ is_test: true, dados: { ref: 'BBBBB' } }];
    value.demands[3].active = false;
    return value;
  } }));
  const codes = Object.fromEntries(broken.map((group) => [group.key, group.divergences.map((item) => item.code).sort()]));
  assert.ok(codes[`journey:${J.valor}:VALOR`].includes('BID_IS_CEILING'));
  assert.ok(codes[`journey:${J.valor}:VALOR`].includes('VIN_DUPLICATE'));
  assert.deepEqual(codes[`journey:${J.carro}:CARRO`], ['CRITERIA_MISMATCH', 'MODE_MISSING', 'SPLIT_DUPLICATE', 'TEST_RECORD'].sort());
  assert.ok(codes[`journey:${J.nolead}:CARRO`].includes('DEMAND_INCOMPLETE'));
  const undone = audit.buildGroups(input({ mutate: (value) => ({ ...value, upload: { ...value.upload, undone_at: new Date().toISOString() } }) }));
  assert.ok(undone.every((group) => group.divergences.some((item) => item.code === 'BATCH_UNDONE')));
  // Every divergence points to the car it is about.
  assert.ok(broken.flatMap((group) => group.divergences).filter((item) => item.option).every((item) => item.matchId));
});

test('privacidade e escopo: só Ref ou id interno, modo, critérios, lance e dados dos carros da própria demanda', async () => {
  const calls = [];
  const result = await audit.runAudit(ctx, input(), { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls) });
  assert.equal(calls.length, 2, 'só as duas demandas sem divergência local vão para a OpenAI');
  assert.equal(result.review, 2);
  calls.forEach((entry) => {
    assert.equal(entry.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(entry.body.model, 'gpt-6-luna');
    assert.equal(entry.body.response_format.json_schema.strict, true);
    const text = JSON.stringify(entry.payload);
    assert.doesNotMatch(text, /Maria|display_name|phone|telefone|@|conversa/i);
    assert.deepEqual(Object.keys(entry.payload).sort(), ['criterios', 'demanda', 'modo', 'opcoes', 'versao_regra']);
    entry.payload.opcoes.forEach((option) => assert.deepEqual(Object.keys(option).sort(), ['ano', 'id', 'lote', 'marca', 'milhagem', 'mmr_usd', 'modelo', 'tipo', 'vin']));
  });
  const valor = calls.find((entry) => entry.payload.modo === 'VALOR').payload;
  assert.equal(valor.criterios.lance_usd, 30000, 'lance da demanda, nunca o teto total');
  assert.equal(valor.opcoes.length, 2);
  assert.deepEqual(valor.opcoes.map((option) => option.lote), ['L1', 'L2']);
  const carro = calls.find((entry) => entry.payload.modo === 'CARRO').payload;
  assert.equal(carro.criterios.lance_usd, undefined, 'CARRO não leva lance');
  assert.equal(carro.opcoes.length, 1, 'nunca o CSV inteiro: só os matches da demanda');
});

test('fluxo: Conferindo, Conferido, Revisar; registro completo; mesma conferência nunca cobrada duas vezes', async () => {
  const valorKey = `journey:${J.valor}:VALOR`, carroKey = `journey:${J.carro}:CARRO`, closedKey = `journey:${J.closed}:CARRO`;
  const state = await audit.viewState(ctx, input(), { env: ENV });
  assert.deepEqual([state.byDemand[valorKey].status, state.byDemand[carroKey].status, state.byDemand[closedKey].status], ['CONFERIDO', 'CONFERIDO', 'REVISAR']);
  assert.equal(state.byDemand[closedKey].canApprove, false, 'fato do servidor não se aprova à mão');
  const stored = await statusOf(valorKey);
  assert.deepEqual([stored.provider, stored.model, stored.rule_version, stored.input_tokens, stored.output_tokens, Number(stored.cost_usd)], ['openai', 'gpt-6-luna', audit.RULE_VERSION, 500, 80, 0.00009]);
  // Same batch, demand, criteria, matches and rule: no new call.
  const calls = [];
  const again = await audit.runAudit(ctx, input(), { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls) });
  assert.equal(calls.length, 0);
  assert.equal(again.processed, 0);
  // A new car for the CARRO demand: only that demand is read again, and the AI finds a divergence.
  const withNew = input({ mutate: (value) => { value.matches.push({ ...car(6, J.carro, 'CARRO', 'BATE', { vin: 'VINCARRO000000006', year: 2021, make: 'Honda', model: 'CR-V', miles: 50000 }), demandKey: carroKey }); return value; } });
  const divergence = (payload) => ({ aprovado: false, divergencias: [{ opcao: payload.opcoes[1].id, codigo: 'MILES_OUT_OF_RANGE', motivo: 'Milhagem acima do limite.' }] });
  await audit.runAudit(ctx, withNew, { env: ENV, fetchImpl: fakeOpenAI(divergence, calls) });
  assert.equal(calls.length, 1);
  const after = await audit.viewState(ctx, withNew, { env: ENV });
  assert.equal(after.byDemand[valorKey].status, 'CONFERIDO', 'as demais demandas aprovadas continuam utilizáveis');
  assert.equal(after.byDemand[carroKey].status, 'REVISAR');
  assert.deepEqual(after.byDemand[carroKey].divergences.map((item) => [item.code, item.text, item.matchId]), [['MILES_OUT_OF_RANGE', 'Milhagem acima do limite', id(1006)]]);
  assert.equal(after.byDemand[carroKey].canApprove, true);
  // A mixed or invalid answer never approves in silence.
  assert.equal(audit.validated({ aprovado: true, divergencias: [{ opcao: 'm1', codigo: 'OTHER', motivo: 'x' }] }, { options: [{ id: 'm1' }], matches: [{ id: 'a' }] }).status, 'REVISAR');
  assert.equal(audit.validated({ aprovado: true, divergencias: [{ opcao: 'm9', codigo: 'OTHER', motivo: 'x' }] }, { options: [{ id: 'm1' }], matches: [{ id: 'a' }] }).errorCode, 'OPENAI_RESPONSE_INVALID');
  assert.equal(audit.validated({ aprovado: 'sim' }, { options: [], matches: [] }).errorCode, 'OPENAI_RESPONSE_INVALID');
});

test('falha da OpenAI: Conferência pendente, opções visíveis, novas tentativas limitadas, tentar de novo e aprovação manual com motivo', async () => {
  const carroKey = `journey:${J.carro}:CARRO`;
  const changed = (n) => input({ mutate: (value) => { value.matches.push({ ...car(n, J.carro, 'CARRO', 'BATE', { vin: 'VINNEW' + n, year: 2022, make: 'Honda', model: 'CR-V', miles: 15000 }), demandKey: carroKey }); return value; } });
  const calls = [];
  const timeout = Object.assign(new Error('timeout'), { name: 'AbortError' });
  const view = changed(7);
  const first = await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI(timeout, calls) });
  assert.equal(first.pending, 1);
  let state = await audit.viewState(ctx, view, { env: ENV });
  assert.deepEqual([state.byDemand[carroKey].status, state.byDemand[carroKey].label, state.byDemand[carroKey].canRetry, state.byDemand[carroKey].canApprove], ['PENDENTE', 'Conferência pendente', true, true]);
  assert.equal(await audit.usable(state.byDemand[carroKey]), false, 'nada aprovado em silêncio');
  await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI({ status: 500 }, calls) });
  await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI({ status: 503 }, calls) });
  await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls) });
  assert.equal(calls.length, 3, 'no máximo 3 tentativas automáticas');
  assert.equal((await statusOf(carroKey)).attempts, 3);
  // The operator asks again: allowed, and it works.
  await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls), onlyKey: carroKey, manual: true });
  assert.equal(calls.length, 4);
  assert.equal((await statusOf(carroKey)).status, 'CONFERIDO');
  // An invalid (paid) answer is final: no automatic retry, cost kept.
  const invalid = changed(8);
  await audit.runAudit(ctx, invalid, { env: ENV, fetchImpl: fakeOpenAI('não é json', calls) });
  await audit.runAudit(ctx, invalid, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls) });
  assert.equal(calls.length, 5);
  const row = await statusOf(carroKey);
  assert.deepEqual([row.status, row.error_code, Number(row.cost_usd) > 0], ['PENDENTE', 'OPENAI_RESPONSE_INVALID', true]);
  // Manual approval needs a reason and is recorded.
  await assert.rejects(audit.approve(ctx, invalid, carroKey, 'ok', ACTOR), { code: 'AUDIT_REASON_REQUIRED' });
  await audit.approve(ctx, invalid, carroKey, 'Conferi os dois carros no leilão', ACTOR);
  const approved = await statusOf(carroKey);
  assert.deepEqual([approved.status, approved.approved_reason], ['APROVADO_MANUAL', 'Conferi os dois carros no leilão']);
  assert.equal(audit.usable((await audit.viewState(ctx, invalid, { env: ENV })).byDemand[carroKey]), true);
  // A fact found by the server can not be approved by hand.
  await assert.rejects(audit.approve(ctx, invalid, `journey:${J.closed}:CARRO`, 'Quero liberar mesmo assim', ACTOR), { code: 'AUDIT_LOCAL_DIVERGENCE' });
});

test('limite por importação: acima dele nada é chamado, mostra a estimativa e espera autorização', async () => {
  const valorKey = `journey:${J.valor}:VALOR`;
  const view = input({ mutate: (value) => { value.demands[0].bidCents = 3100000; return value; } });
  const calls = [];
  const blocked = await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls), limitUsd: 0.00001 });
  assert.equal(calls.length, 0);
  assert.equal(blocked.awaitingAuthorization, true);
  assert.ok(blocked.estimateUsd > 0);
  const state = await audit.viewState(ctx, view, { env: ENV });
  assert.equal(state.run.status, 'AGUARDANDO_AUTORIZACAO');
  assert.equal(state.byDemand[valorKey].status, 'AGUARDANDO_AUTORIZACAO');
  assert.equal(state.limitUsd, 2);
  await audit.authorize(ctx, UPLOAD, ACTOR);
  await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls), limitUsd: 0.00001 });
  assert.equal(calls.length, 1);
  assert.equal((await audit.viewState(ctx, view, { env: ENV })).byDemand[valorKey].status, 'CONFERIDO');
  // The authorized amount is used up: a new reading of the batch waits for a new authorization.
  const more = input({ mutate: (value) => { value.demands[0].bidCents = 3150000; return value; } });
  const again = await audit.runAudit(ctx, more, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls), limitUsd: 0.00001 });
  assert.equal(again.awaitingAuthorization, true);
  assert.equal(calls.length, 1);
  assert.equal((await audit.viewState(ctx, more, { env: ENV })).run.status, 'AGUARDANDO_AUTORIZACAO');
  await backend.db.query("update public.manheim_audit_runs set status='ABERTO', authorized_by=null, authorized_at=null, limit_usd=2 where upload_id=$1", [UPLOAD]);
  // Deadline: never start a call the function could be stopped in the middle of.
  const late = input({ mutate: (value) => { value.demands[0].bidCents = 3200000; return value; } });
  const deferred = await audit.runAudit(ctx, late, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls), deadlineAt: Date.now() + 1000 });
  assert.equal(calls.length, 1);
  assert.equal(deferred.deferred, 1);
});

test('V1 e V2 bloqueadas só para a demanda pendente ou reprovada', async () => {
  const insertCalls = [];
  const services = {
    rows: async (_ctx, table) => table === 'journeys' ? [{ id: J.carro, contact_id: id(101), reference_code: 'BBBBB', budget_cents: null }] : table === 'contacts' ? [{ display_name: 'x' }] : table === 'manheim_matches' ? [{ id: id(1003), vehicle_json: { parsed: {} } }] : [],
    insert: async (...args) => { insertCalls.push(args); return [{ id: id(9) }]; },
    activeFilter: async () => ({}),
    auditGate: async () => 'MANHEIM_AUDIT_PENDING'
  };
  assert.deepEqual(await vitrines.create(ctx, { journeyId: J.carro, matchIds: [id(1003)] }, services), { error: 'MANHEIM_AUDIT_PENDING' });
  assert.equal(insertCalls.length, 0, 'nenhuma vitrine criada');
  // Per demand: the approved VALOR demand stays usable while the CARRO one is held.
  const view = input({ mutate: (value) => { value.matches.push({ ...car(9, J.carro, 'CARRO', 'BATE', { vin: 'VINHELD9', year: 2022, make: 'Honda', model: 'CR-V', miles: 15000 }), demandKey: `journey:${J.carro}:CARRO` }); return value; } });
  const state = await audit.viewState(ctx, view, { env: ENV });
  assert.equal(audit.usable(state.byDemand[`journey:${J.valor}:VALOR`]), true);
  assert.equal(audit.usable(state.byDemand[`journey:${J.carro}:CARRO`]), false);
  assert.equal(state.byDemand[`journey:${J.carro}:CARRO`].status, 'CONFERINDO');
});

test('nenhum dado real alterado: matches, fichas e contatos intactos; nenhuma rede externa', async () => {
  const counts = (await backend.db.query('select (select count(*) from public.manheim_matches) m, (select count(*) from public.vitrines) v, (select count(*) from public.journeys where status<>\'ATIVO\') j, (select count(*) from public.contacts where is_lead=false) c')).rows[0];
  assert.deepEqual([Number(counts.m), Number(counts.v), Number(counts.j), Number(counts.c)], [0, 0, 0, 0]);
  assert.deepEqual(backend.refused, []);
});

// Correções da revisão independente.
test('demanda ampla: conferida em blocos de até 100 opções e aprovada só se todos aprovarem', async () => {
  const valorKey = `journey:${J.valor}:VALOR`;
  const wide = input({ mutate: (value) => {
    for (let n = 0; n < 230; n += 1) value.matches.push({ ...car(3000 + n, J.valor, 'VALOR', 'POR_VALOR', { vin: 'VINWIDE' + String(n).padStart(6, '0'), year: 2021, make: 'Toyota', model: 'RAV4', miles: 30000 + n, mmrCents: 2800000 }), demandKey: valorKey });
    return value;
  } });
  const group = audit.buildGroups(wide).find((item) => item.key === valorKey);
  assert.equal(group.options.length, 232);
  assert.deepEqual(group.divergences, [], 'muitas opções não viram divergência');
  const calls = [];
  const second = (payload) => payload.opcoes[0].id === 'm101' ? { aprovado: false, divergencias: [{ opcao: 'm150', codigo: 'MMR_OUT_OF_RANGE', motivo: 'MMR fora da faixa' }] } : approveAll();
  await audit.runAudit(ctx, wide, { env: ENV, fetchImpl: fakeOpenAI(second, calls), onlyKey: valorKey });
  assert.deepEqual(calls.map((entry) => entry.payload.opcoes.length), [100, 100, 32]);
  const state = await audit.viewState(ctx, wide, { env: ENV });
  assert.equal(state.byDemand[valorKey].status, 'REVISAR');
  assert.deepEqual(state.byDemand[valorKey].divergences.map((item) => [item.code, item.matchId]), [['MMR_OUT_OF_RANGE', group.matches[149].id]]);
  const row = await statusOf(valorKey);
  assert.deepEqual([row.input_tokens, row.output_tokens], [1500, 240], 'tokens das três chamadas somados');
});

test('match histórico sem modo vai para Revisar; fato mudou, demanda relida; duplicata aprovável com motivo, fato duro não', async () => {
  const carroKey = `journey:${J.carro}:CARRO`;
  const historical = input({ mutate: (value) => { value.matches.find((match) => match.journey_id === J.carro).historicalMode = true; return value; } });
  const group = audit.buildGroups(historical).find((item) => item.key === carroKey);
  assert.deepEqual(group.divergences.map((item) => item.code), ['MODE_MISSING']);
  assert.notEqual(group.hash, audit.buildGroups(input()).find((item) => item.key === carroKey).hash, 'o fato entra no hash');
  let state = await audit.viewState(ctx, historical, { env: ENV });
  assert.deepEqual([state.byDemand[carroKey].status, state.byDemand[carroKey].canApprove], ['REVISAR', false]);
  await assert.rejects(audit.approve(ctx, historical, carroKey, 'Liberar mesmo assim', ACTOR), { code: 'AUDIT_LOCAL_DIVERGENCE' });
  // A repeated VIN from overlapping CSV splits can be approved by hand with a reason.
  const duplicated = input({ mutate: (value) => { const own = value.matches.find((match) => match.journey_id === J.carro); value.matches.push({ ...own, id: id(1999), row_fingerprint: 'split-2' }); return value; } });
  await audit.runAudit(ctx, duplicated, { env: ENV, fetchImpl: fakeOpenAI(approveAll, []) });
  state = await audit.viewState(ctx, duplicated, { env: ENV });
  assert.deepEqual([state.byDemand[carroKey].status, state.byDemand[carroKey].canApprove], ['REVISAR', true]);
  await audit.approve(ctx, duplicated, carroKey, 'Mesmo carro repetido entre as divisões', ACTOR);
  assert.equal((await audit.viewState(ctx, duplicated, { env: ENV })).byDemand[carroKey].status, 'APROVADO_MANUAL');
});

test('V1 checa a demanda do cartão: carro que serve VALOR e CARRO não troca a demanda conferida', () => {
  const car = { id: 'x', demandKey: 'journey:a:VALOR' }, same = { id: 'x', demandKey: 'journey:a:CARRO' };
  const state = { byDemand: { 'journey:a:VALOR': { status: 'CONFERIDO' }, 'journey:a:CARRO': { status: 'PENDENTE' } } };
  assert.equal(audit.heldFor(state, [car, same], 'x', 'journey:a:VALOR'), false);
  assert.equal(audit.heldFor(state, [car, same], 'x', 'journey:a:CARRO'), true);
  assert.equal(audit.heldFor(state, [car, same], 'x'), true, 'sem a demanda (V2) todas precisam estar liberadas');
  assert.equal(audit.heldFor(state, [car, same], 'outro'), null);
});

test('gasto do lote é a soma real das conferências e nenhuma aprovação passa por cima de uma leitura em andamento', async () => {
  const valorKey = `journey:${J.valor}:VALOR`;
  const spent = (await backend.db.query('select coalesce(sum(cost_usd),0) s from public.manheim_match_audits where upload_id=$1', [UPLOAD])).rows[0].s;
  const view = input({ mutate: (value) => { value.demands[0].bidCents = 3300000; return value; } });
  // Already spent (by any run) counts against the limit: a limit just below it blocks every call.
  const calls = [];
  await backend.db.query("update public.manheim_audit_runs set status='ABERTO', authorized_by=null, authorized_at=null where upload_id=$1", [UPLOAD]);
  const blocked = await audit.runAudit(ctx, view, { env: ENV, fetchImpl: fakeOpenAI(approveAll, calls), limitUsd: Number(spent) });
  assert.equal(blocked.awaitingAuthorization, true);
  assert.equal(calls.length, 0);
  const group = audit.buildGroups(view).find((item) => item.key === valorKey);
  await backend.db.query(`insert into public.manheim_match_audits(environment,upload_id,journey_id,logical_mode,demand_key,content_hash,rule_version,status,attempts) values('preview',$1,$2,'VALOR',$3,$4,$5,'CONFERINDO',1)`, [UPLOAD, J.valor, valorKey, group.hash, audit.RULE_VERSION]);
  await assert.rejects(audit.approve(ctx, view, valorKey, 'Aprovar durante a leitura', ACTOR), { code: 'AUDIT_IN_PROGRESS' });
});

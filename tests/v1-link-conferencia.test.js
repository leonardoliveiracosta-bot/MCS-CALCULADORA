'use strict';

// "Gerar link V1" com a conferência Manheim ligada, contra um banco PGlite que corta resultados em
// 1000 linhas como o Supabase. Em produção a conferência lia só as 1000 primeiras linhas do lote
// (6 de 349 demandas): as demais ficavam "Conferindo" para sempre e o botão, travado. Aqui: uma
// demanda com mais de 1000 opções vem antes; a demanda com carros selecionados é conferida, o link
// sai; a pendente continua bloqueada com o motivo; V1_DIRECT_SEND_ENABLED não participa e nenhuma
// mensagem é enviada. Handlers reais, OpenAI simulada.
const test = require('node:test');
const assert = require('node:assert/strict');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { contentHash } = require('../panel-manheim-batch');
const audit = require('../panel-manheim-audit');
const { auditInputFor, liveOptions, demandContext } = require('../panel-buscas-view');

const id = (n) => `6e200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ACTOR = id(1);
// Journey ids sort BIG < SEL < PEND: the big demand fills the first 1000 rows.
const BIG = id(10), SEL = id(20), PEND = id(30);
const person = (journey, n, make, model) => [
  `insert into public.contacts(id,environment,display_name,source,created_at,updated_at) values('${id(n + 1)}','preview','Cliente fictício ${n}','WHATSAPP_DIRECT',now(),now());`,
  `insert into public.journeys(id,environment,contact_id,source,stage,status,criteria_json,budget_cents,reference_code,created_at,updated_at) values('${journey}','preview','${id(n + 1)}','WHATSAPP_DIRECT','RESPONDIDO','ATIVO','${JSON.stringify({ wishlists: [{ make, model, yearMin: 2019, yearMax: 2022, minMiles: 1000, maxMiles: 90000 }], logical_modes: ['CARRO'] })}',3000000,'${{ 10: 'BGAAA', 20: 'SLAAA', 30: 'PNAAA' }[n]}',now(),now());`,
  `insert into public.chats(id,environment,channel,contact_id,canonical_key,resolution_status,is_group,first_seen_at,last_seen_at,created_at,updated_at) values('${id(n + 2)}','preview','WHATSAPP','${id(n + 1)}','v1-${n}','RESOLVED',false,now(),now(),now(),now());`,
  `insert into public.messages(id,environment,chat_id,channel,direction,body_text,body_normalized,occurred_at_utc,signature_base,occurrence_index,source_kind,created_at) values('${id(n + 3)}','preview','${id(n + 2)}','WHATSAPP','CUSTOMER','Quero um ${make}','x',now(),'s${n}',1,'WHATSAPP_WEBHOOK',now());`,
  `insert into public.message_journeys(environment,message_id,journey_id,association_source,associated_at) values('preview','${id(n + 3)}','${journey}','IMPORT',now());`
].join('\n');
const seed = [
  `insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values('${ACTOR}','preview','68000000-0000-4000-8000-00000000a001','teste@example.test','admin',true,false);`,
  person(BIG, 10, 'Toyota', 'RAV4'), person(SEL, 20, 'Honda', 'CR-V'), person(PEND, 30, 'Mazda', 'CX-5')
].join('\n');
const car = (prefix, n, make, model) => {
  const vin = prefix + String(n).padStart(17 - prefix.length, '0');
  return { fingerprint: 'vin:' + vin, vehicle: { vin, year: 2020, make, model, trim: 'LX', miles: 20000 + n, mmrCents: 2500000, location: 'FL - Orlando', lane: String(1 + (n % 3)), run: String(10 + n), saleType: 'Simulcast', conditionGrade: '4.0', cleanTitle: true, odometerOk: true } };
};
const cars = [
  ...Array.from({ length: 1005 }, (_, n) => car('BIGV', n, 'Toyota', 'RAV4')),
  ...Array.from({ length: 4 }, (_, n) => car('SELV', n, 'Honda', 'CR-V')),
  ...Array.from({ length: 2 }, (_, n) => car('PNDV', n, 'Mazda', 'CX-5'))
];

let backend, ctx;
const openAiCalls = [];
async function call(name, url, method = 'GET', body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  return res;
}
const matchIdOf = async (vin) => (await backend.db.query('select id from public.manheim_matches where vin=$1', [vin])).rows[0].id;
const keyOf = (journey) => `journey:${journey}:CARRO`;

test.before(async () => {
  backend = await createBackend({ seed, maxRows: 1000 });
  Object.assign(process.env, { SUPABASE_URL: BASE, MANHEIM_MATCH_AUDIT_ENABLED: '1', OPENAI_API_KEY: 'chave-simulada' });
  for (const key of ['MANHEIM_OPENAI_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'V1_DIRECT_SEND_ENABLED', 'D360_API_KEY']) delete process.env[key];
  // OpenAI simulated; everything else goes to the simulated database (any other host is refused).
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.openai.com/')) {
      const body = JSON.parse(options.body);
      openAiCalls.push(body);
      const pending = JSON.stringify(body).includes('PNDV');
      if (pending) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ usage: { prompt_tokens: 500, completion_tokens: 40 }, choices: [{ message: { content: JSON.stringify({ aprovado: true, divergencias: [] }) } }] }) };
    }
    return backend.fetch(url, options);
  };
  require('../panel-manheim-state').resetUndoSupport();
  ctx = { config: { url: BASE, secretKey: 'secreta-simulada' }, environment: 'preview', panel: { id: ACTOR, role: 'admin' } };
  const chunks = [];
  for (let index = 0; index < cars.length; index += 500) chunks.push(cars.slice(index, index + 500));
  const files = [{ name: 'V1.csv', size: 1, rowCount: cars.length, vehicleCount: cars.length, chunkCount: chunks.length, chunks: chunks.map((part) => ({ count: part.length, hash: contentHash(part) })) }];
  const started = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'start', clientKey: 'f'.repeat(32), vehicleCount: cars.length, files, manifestHash: contentHash(files), headers: [['Vin', 'Lane', 'Run']], headerMap: {} });
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  for (const [chunkIndex, vehicles] of chunks.entries()) {
    const stored = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'chunk', uploadId: started.payload.uploadId, fileIndex: 0, chunkIndex, vehicles });
    assert.equal(stored.statusCode, 200, JSON.stringify(stored.payload));
  }
  const done = await call('manheim-batch', '/api/panel/manheim-batch', 'POST', { action: 'finalize', uploadId: started.payload.uploadId });
  assert.equal(done.statusCode, 200, JSON.stringify(done.payload));
});
test.after(async () => { if (backend) await backend.db.close(); });

test('causa do bug: a leitura antiga corta em 1000 linhas e a demanda seguinte nem entra na conferência', async () => {
  const input = await auditInputFor(ctx);
  const context = demandContext(input.base);
  const old = await liveOptions(ctx, input.upload.id, context, 1001);
  const keys = new Set(old.map((match) => match.demandKey));
  assert.ok(keys.has(keyOf(BIG)));
  assert.equal(keys.has(keyOf(SEL)), false, 'com o corte, a demanda SEL some');
  // Now nothing is selected: nothing is read; each demand says the reading starts with a selection.
  assert.deepEqual(input.scope, []);
  const state = await audit.viewState(ctx, input);
  assert.equal(state.byDemand[keyOf(SEL)].status, 'SEM_SELECAO');
  assert.equal(state.byDemand[keyOf(SEL)].label, 'Conferência começa ao selecionar carros');
});

test('Gerar link V1: carros selecionados, conferência na hora (uma chamada, com reserva), link criado; nada enviado', async () => {
  const selected = [await matchIdOf('SELV0000000000000'), await matchIdOf('SELV0000000000001')];
  for (const matchId of selected) assert.equal((await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'select', matchId })).statusCode, 200);
  // The demand is in the audit now, even after the 1005 of BIG: only its 2 selected cars (of 4).
  const input = await auditInputFor(ctx);
  assert.deepEqual(input.scope, [keyOf(SEL)]);
  assert.equal(input.matches.filter((match) => match.demandKey === keyOf(SEL)).length, 2);
  // First click: not checked yet.
  const body = { journeyId: SEL, matchIds: selected, demandKey: keyOf(SEL) };
  const first = await call('vitrines', '/api/panel/vitrines', 'POST', body);
  assert.deepEqual([first.statusCode, first.payload.error], [409, 'MANHEIM_AUDIT_PENDING']);
  // The button asks for this demand's reading, then tries again (what painel.js does).
  const checked = await call('manheim-audit', '/api/panel/manheim-audit', 'POST', { action: 'check', key: keyOf(SEL) });
  assert.equal(checked.payload.approved, 1, JSON.stringify(checked.payload));
  assert.equal(checked.payload.entry.status, 'CONFERIDO', 'o card recebe o estado novo na hora');
  assert.equal(openAiCalls.length, 1);
  assert.equal(openAiCalls[0].max_completion_tokens, 16000);
  assert.deepEqual(JSON.parse(openAiCalls[0].messages[1].content).opcoes.map((option) => option.vin).sort(), ['SELV0000000000000', 'SELV0000000000001'], 'só os carros selecionados');
  const created = await call('vitrines', '/api/panel/vitrines', 'POST', body);
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
  assert.match(created.payload.link, /^\/v\/[A-Za-z0-9_-]+$/);
  // Reserved, paid and recorded once; V1 sending untouched and nothing sent.
  const ledger = (await backend.db.query("select feature,status from public.openai_budget_holds where environment='preview'")).rows;
  assert.deepEqual(ledger.map((row) => [row.feature, row.status]), [['MANHEIM_AUDIT', 'REGISTRADA']]);
  assert.equal(process.env.V1_DIRECT_SEND_ENABLED, undefined);
  assert.equal((await backend.db.query('select count(*)::int n from public.v1_sends')).rows[0].n, 0);
  assert.deepEqual(backend.refused, []);
});

test('pedido amplo (1005 opções) com 6 selecionadas: a conferência envia só as 6, um bloco, e libera a V1', async () => {
  const vins = [0, 3, 7, 100, 500, 1004].map((n) => 'BIGV' + String(n).padStart(13, '0'));
  const selected = [];
  for (const vin of vins) { const matchId = await matchIdOf(vin); selected.push(matchId); assert.equal((await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'select', matchId })).statusCode, 200); }
  const input = await auditInputFor(ctx);
  assert.equal(input.matches.filter((match) => match.demandKey === keyOf(BIG)).length, 6);
  const before = openAiCalls.length;
  const checked = await call('manheim-audit', '/api/panel/manheim-audit', 'POST', { action: 'check', key: keyOf(BIG) });
  assert.equal(openAiCalls.length, before + 1, JSON.stringify(checked.payload));
  assert.deepEqual(JSON.parse(openAiCalls[before].messages[1].content).opcoes.map((option) => option.vin).sort(), vins.sort());
  assert.deepEqual([checked.payload.entry.status, checked.payload.entry.carCount], ['CONFERIDO', 6]);
  const created = await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: BIG, matchIds: selected, demandKey: keyOf(BIG) });
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
});

test('pendente por tempo esgotado nunca fica sem saída: Conferir de novo sempre, Aprovar com motivo depois de 2 falhas', async () => {
  const selected = [await matchIdOf('PNDV0000000000000')];
  assert.equal((await call('manheim-options', '/api/panel/manheim-options', 'POST', { action: 'select', matchId: selected[0] })).statusCode, 200);
  const input = await auditInputFor(ctx);
  const group = audit.buildGroups(input).find((item) => item.key === keyOf(PEND));
  // The production case: 3 attempts ended by AUDIT_DEADLINE.
  await backend.db.query(`insert into public.manheim_match_audits(environment,upload_id,journey_id,logical_mode,demand_key,content_hash,rule_version,status,error_code,attempts,cost_usd,provider,model)
    values('preview',$1,$2,'CARRO',$3,$4,'conferencia-v1','PENDENTE','AUDIT_DEADLINE',3,0.009014,'openai','gpt-6-luna')`, [input.upload.id, PEND, keyOf(PEND), group.hash]);
  const body = { journeyId: PEND, matchIds: selected, demandKey: keyOf(PEND) };
  assert.equal((await call('vitrines', '/api/panel/vitrines', 'POST', body)).payload.error, 'MANHEIM_AUDIT_PENDING');
  const before = openAiCalls.length;
  // One automatic attempt more (within the ceiling), still without confirmation; the reason comes back.
  const checked = await call('manheim-audit', '/api/panel/manheim-audit', 'POST', { action: 'check', key: keyOf(PEND) });
  assert.equal(openAiCalls.length, before + 1);
  assert.deepEqual([checked.payload.entry.status, checked.payload.entry.errorCode, checked.payload.entry.canRetry, checked.payload.entry.canApprove], ['PENDENTE', 'OPENAI_FAILED', true, true]);
  // The cron and the automatic check stop here; the "Conferir de novo" button always works.
  await call('manheim-audit', '/api/panel/manheim-audit', 'POST', { action: 'check', key: keyOf(PEND) });
  await call('manheim-audit', '/api/panel/manheim-audit', 'POST', { action: 'run' });
  assert.equal(openAiCalls.length, before + 1);
  const retry = await call('manheim-audit', '/api/panel/manheim-audit', 'POST', { action: 'retry', key: keyOf(PEND) });
  assert.equal(openAiCalls.length, before + 2, JSON.stringify(retry.payload));
  const refused = await call('vitrines', '/api/panel/vitrines', 'POST', body);
  assert.deepEqual([refused.statusCode, refused.payload.error], [409, 'MANHEIM_AUDIT_PENDING']);
  // Manual approval with a reason releases it.
  const approved = await call('manheim-audit', '/api/panel/manheim-audit', 'POST', { action: 'approve', key: keyOf(PEND), reason: 'Conferi o carro no leilão' });
  assert.equal(approved.payload.entry.status, 'APROVADO_MANUAL', JSON.stringify(approved.payload));
  assert.equal((await call('vitrines', '/api/panel/vitrines', 'POST', body)).statusCode, 201);
  // The released demand still gives its link.
  assert.equal((await call('vitrines', '/api/panel/vitrines', 'POST', { journeyId: SEL, matchIds: [await matchIdOf('SELV0000000000000'), await matchIdOf('SELV0000000000001')], demandKey: keyOf(SEL) })).statusCode, 200);
});

test('carro sem MMR válido continua fora da V1', async () => {
  const vin = 'SELV0000000000002';
  await backend.db.query("update public.manheim_matches set vehicle_json = jsonb_set(vehicle_json, '{parsed,mmrCents}', 'null'::jsonb) where vin=$1", [vin]);
  const out = await require('../api/panel/vitrines').create(ctx, { journeyId: SEL, matchIds: [await matchIdOf(vin)], demandKey: keyOf(SEL) });
  assert.equal(out.error, 'MANHEIM_MATCH_WITHOUT_MMR');
});

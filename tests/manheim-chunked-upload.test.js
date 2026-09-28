'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manheim = require('../painel/manheim');
const upload = require('../painel/manheim-upload');
const { consolidateCalcRuns, groupCalculatorByRef, wishlistsForJourney } = require('../panel-domain');
const realServer = require('../panel-server');
const { migratedDatabase } = require('./sql/run');
const { malibuCsv, porsche911Csv, porscheCustomers, uuid } = require('./fixtures/manheim-sintetico');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const ACTOR = uuid('50000000', 1);
const MAX_REQUEST_BYTES = 1500000;

function loadWith(relative, mocks) {
  const file = path.join(root, relative), mod = { exports: {} };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  return mod.exports;
}

function response() {
  return { code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(value) { this.payload = value; return value; } };
}

// actions.js wired to a real Postgres (PGlite) with every migration applied.
async function harness(customers = porscheCustomers()) {
  const { db } = await migratedDatabase();
  const { journeys, calcRuns } = customers;
  await db.query(`insert into public.panel_users(id,environment,auth_user_id,email,role,active,must_change_password) values($1,'preview',$2,'manheim@example.test','admin',true,false)`, [ACTOR, uuid('50000000', 2)]);
  for (const journey of journeys) {
    await db.query(`insert into public.contacts(id,environment,display_name,created_at,updated_at) values($1,'preview','Cliente Ficticio',now(),now())`, [journey.contactId]);
    await db.query(`insert into public.journeys(id,environment,contact_id,source,status,stage,criteria_json,budget_cents,created_at,updated_at) values($1,'preview',$2,'MANUAL','ATIVO','NOVO',$3::jsonb,$4,now(),now())`, [journey.id, journey.contactId, JSON.stringify(journey.criteria_json), journey.budget_cents]);
  }
  for (const run of calcRuns) await db.query(`insert into public.calc_runs(created_at,zip,estado,lance,pagamento,dados,is_test) values($1,$2,$3,$4,$5,$6::jsonb,false)`, [run.created_at, run.zip, run.estado, run.lance, run.pagamento, JSON.stringify(run.dados)]);

  const environmentTables = new Set(['journeys', 'journey_toggle_states', 'calculator_request_links', 'panel_item_dispositions']);
  const allRows = async (_ctx, table, params) => {
    const where = [];
    if (environmentTables.has(table)) where.push(`environment='preview'`);
    if (params.cleared_at === 'is.null') where.push('cleared_at is null');
    return (await db.query(`select ${params.select} from public.${table}${where.length ? ' where ' + where.join(' and ') : ''}`)).rows;
  };
  const rpcCalls = [];
  const supabase = async (_url, _key, requestPath, options) => {
    const name = requestPath.replace('/rest/v1/rpc/', '');
    const exists = (await db.query(`select 1 from pg_proc where proname=$1`, [name])).rows.length;
    if (!exists) throw Object.assign(new Error('SUPABASE_REQUEST_FAILED'), { status: 404 });
    const body = JSON.parse(options.body);
    const keys = Object.keys(body);
    const args = keys.map((key, index) => `${key} => $${index + 1}${body[key] !== null && typeof body[key] === 'object' ? '::jsonb' : ''}`);
    const values = keys.map((key) => body[key] !== null && typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key]);
    rpcCalls.push({ name, partIndex: body.p_part_index || null });
    try { return (await db.query(`select public.${name}(${args.join(', ')}) as result`, values)).rows[0].result; }
    catch (cause) { throw Object.assign(new Error('SUPABASE_REQUEST_FAILED'), { status: 400, cause }); }
  };
  const handler = loadWith('api/panel/actions.js', { '../../panel-server': {
    ...realServer, allRows, supabase,
    requirePanel: async () => ({ config: { url: 'https://example.test', secretKey: 'test' }, panel: { id: ACTOR }, environment: 'preview' })
  } });

  const sent = [];
  const request = async (_path, options) => {
    assert.ok(Buffer.byteLength(options.body, 'utf8') < MAX_REQUEST_BYTES, 'cada parte fica abaixo de 1,5 MB');
    const body = JSON.parse(options.body);
    if (body.action === 'manheim_upload_part') assert.ok(body.matches.length <= 250, 'cada parte tem no máximo 250 combinações');
    sent.push(body);
    const res = response();
    await handler({ method: 'POST', body, headers: {} }, res);
    if (res.code >= 400) throw Object.assign(new Error(res.payload.error), { code: res.payload.error });
    return res.payload;
  };

  const clientJourneys = journeys.map((journey) => ({ ...journey, enabled: true, wishlists: wishlistsForJourney(journey) }));
  const clientOrders = groupCalculatorByRef(consolidateCalcRuns(calcRuns, []), []);
  const latest = async () => (await db.query(`select id,matched_vehicle_count,lead_count,vehicle_count from public.manheim_uploads where environment='preview' order by uploaded_at desc limit 1`)).rows[0] || null;
  return { db, handler, request, sent, rpcCalls, latest, clientJourneys, clientOrders };
}

function prepare(text, journeys, orders) {
  const parsed = manheim.parseCsv(text);
  const mapping = manheim.mapHeaders(parsed.headers);
  const vehicles = upload.markSearchFiltered(manheim.chooseAuctionRows(manheim.normalizeRows(parsed, mapping)));
  const matches = upload.buildMatches(vehicles, journeys, orders, manheim);
  const base = { sourceFileCount: 1, vehicleCount: vehicles.length, headers: [parsed.headers], headerMap: { files: [mapping.fields] } };
  return { parsed, vehicles, matches, base, parts: upload.planParts(matches, base) };
}

test('312 Porsche 911 x 34 pedidos 911: mais de 4.000 combinações importadas inteiras, em partes', async () => {
  const h = await harness();
  try {
    const run = prepare(porsche911Csv(), h.clientJourneys, h.clientOrders);
    assert.equal(run.parsed.rows.length, 322);
    assert.equal(run.vehicles.length, 312);
    assert.equal(h.clientJourneys.length + h.clientOrders.length, 34);
    assert.ok(run.matches.length > 4000, `combinações: ${run.matches.length}`);
    assert.ok(run.matches.some((match) => match.targetType === 'ORDER'));
    assert.ok(run.vehicles.every((vehicle) => vehicle.cleanTitle === true && vehicle.odometerOk === true));
    assert.ok(run.parts.length > 1);
    assert.deepEqual(run.parts.flat(), run.matches);

    const progress = [];
    const result = await upload.sendParts({ parts: run.parts, base: run.base, request: h.request, wait: async () => assert.fail('nenhuma parte deveria falhar'), onProgress: (index, count) => progress.push(`${index}/${count}`) });
    assert.equal(result.complete, true);
    assert.equal(result.matchedVehicleCount, run.matches.length);
    assert.equal(progress.length, run.parts.length);
    assert.equal(h.sent[0].uploadId, null);
    assert.ok(h.sent.slice(1).every((body) => body.uploadId === result.uploadId), 'as partes seguintes anexam ao mesmo uploadId');
    assert.ok(h.rpcCalls.every((call) => call.name === 'panel_store_manheim_upload_part'));

    const latest = await h.latest();
    assert.equal(latest.id, result.uploadId);
    assert.equal(latest.matched_vehicle_count, run.matches.length);
    assert.equal(latest.vehicle_count, 312);
    assert.equal(latest.lead_count, 34);
    const stored = (await h.db.query(`select count(*)::int as total from public.manheim_matches where upload_id=$1`, [result.uploadId])).rows[0].total;
    assert.equal(stored, run.matches.length);
    assert.equal((await h.db.query(`select count(*)::int as total from public.manheim_upload_draft_parts`)).rows[0].total, 0, 'partes temporárias apagadas');

    // Resending the last part (lost response) returns the same upload and stores nothing twice.
    const last = h.sent.at(-1);
    const again = await h.request('/api/panel/actions', { method: 'POST', body: JSON.stringify(last) });
    assert.equal(again.uploadId, result.uploadId);
    assert.equal(again.complete, true);
    assert.equal((await h.db.query(`select count(*)::int as total from public.manheim_uploads`)).rows[0].total, 1);
  } finally { await h.db.close(); }
});

test('20.000+ combinações passam pelo banco inteiras (MANHEIM_HEAVY=1)', { skip: process.env.MANHEIM_HEAVY !== '1' }, async () => {
  const h = await harness(porscheCustomers(100, 4));
  try {
    const run = prepare(porsche911Csv(), h.clientJourneys, h.clientOrders);
    assert.ok(run.matches.length >= 20000, `combinações: ${run.matches.length}`);
    const started = Date.now();
    const result = await upload.sendParts({ parts: run.parts, base: run.base, request: h.request });
    console.log(`${run.matches.length} combinações, ${run.parts.length} partes, ${Date.now() - started} ms`);
    assert.equal((await h.latest()).matched_vehicle_count, run.matches.length);
    assert.equal(result.matchedVehicleCount, run.matches.length);
  } finally { await h.db.close(); }
});

test('o último upload só muda quando a última parte é gravada: falha na parte 3 mantém o anterior', async () => {
  const h = await harness();
  try {
    const small = prepare(malibuCsv(), [{ id: uuid('51000000', 1), enabled: true, wishlists: [{ make: 'Chevrolet', model: 'Malibu', yearMin: 2018, maxMiles: 80000 }] }], []);
    assert.equal(small.parts.length, 1);
    // The panel journey wants a 911, so this Malibu upload has no match but still becomes the previous upload.
    await h.db.query(`update public.journeys set criteria_json=$1::jsonb where id=$2`, [JSON.stringify({ wishlists: [{ make: 'Chevrolet', model: 'Malibu', yearMin: 2018, maxMiles: 80000 }] }), uuid('51000000', 1)]);
    const previous = await upload.sendParts({ parts: small.parts, base: small.base, request: h.request });
    assert.equal(previous.complete, true);
    assert.equal(previous.matchedVehicleCount, small.matches.length);
    assert.ok(small.matches.length > 0);
    await h.db.query(`update public.journeys set criteria_json=$1::jsonb where id=$2`, [JSON.stringify(porscheCustomers().journeys[0].criteria_json), uuid('51000000', 1)]);

    const run = prepare(porsche911Csv(), h.clientJourneys, h.clientOrders);
    assert.ok(run.parts.length > 3);
    const attempts = [];
    const waits = [];
    const flaky = async (requestPath, options) => {
      const body = JSON.parse(options.body);
      attempts.push(body.partIndex);
      if (body.partIndex === 3) throw Object.assign(new Error('PANEL_ACTION_FAILED'), { code: 'PANEL_ACTION_FAILED' });
      return h.request(requestPath, options);
    };
    await assert.rejects(
      () => upload.sendParts({ parts: run.parts, base: run.base, request: flaky, wait: async (ms) => waits.push(ms) }),
      (failure) => failure.code === 'MANHEIM_UPLOAD_INCOMPLETE' && failure.partIndex === 3 && failure.partCount === run.parts.length && failure.cause.code === 'PANEL_ACTION_FAILED'
    );
    assert.deepEqual(attempts, [1, 2, 3, 3, 3], 'parte 3 tenta 3 vezes e nada depois dela é enviado');
    assert.deepEqual(waits, [2000, 2000]);

    const latest = await h.latest();
    assert.equal(latest.id, previous.uploadId, 'o painel continua mostrando o upload anterior');
    assert.equal((await h.db.query(`select count(*)::int as total from public.manheim_uploads`)).rows[0].total, 1);
    const draft = (await h.db.query(`select received_parts, completed_at from public.manheim_upload_drafts`)).rows;
    assert.equal(draft.length, 1);
    assert.equal(draft[0].received_parts, 2);
    assert.equal(draft[0].completed_at, null);
    assert.equal((await h.db.query(`select count(*)::int as total from public.manheim_matches where upload_id<>$1`, [previous.uploadId])).rows[0].total, 0);
  } finally { await h.db.close(); }
});

test('Export pequeno (269 Malibu) segue em uma parte pela RPC original', async () => {
  const h = await harness();
  try {
    await h.db.query(`update public.journeys set criteria_json=$1::jsonb where id=$2`, [JSON.stringify({ wishlists: [{ make: 'Chevrolet', model: 'Malibu', yearMin: 2018, maxMiles: 80000 }] }), uuid('51000000', 2)]);
    const journeys = [{ id: uuid('51000000', 2), enabled: true, wishlists: [{ make: 'Chevrolet', model: 'Malibu', yearMin: 2018, maxMiles: 80000 }] }];
    const run = prepare(malibuCsv(), journeys, []);
    assert.equal(run.parsed.rows.length, 269);
    assert.equal(run.parts.length, 1);
    const result = await upload.sendParts({ parts: run.parts, base: run.base, request: h.request });
    assert.equal(result.complete, true);
    assert.deepEqual(h.rpcCalls.map((call) => call.name), ['panel_store_manheim_upload']);
    assert.equal((await h.latest()).matched_vehicle_count, run.matches.length);
  } finally { await h.db.close(); }
});

test('sem a migração aplicada, envio em partes responde MANHEIM_MIGRATION_PENDING', async () => {
  const handler = loadWith('api/panel/actions.js', { '../../panel-server': {
    ...realServer, allRows: async () => [],
    supabase: async () => { throw Object.assign(new Error('SUPABASE_REQUEST_FAILED'), { status: 404 }); },
    requirePanel: async () => ({ config: { url: 'https://example.test', secretKey: 'test' }, panel: { id: ACTOR }, environment: 'preview' })
  } });
  const res = response();
  await handler({ method: 'POST', headers: {}, body: { action: 'manheim_upload_part', uploadId: null, partIndex: 1, partCount: 2, sourceFileCount: 1, vehicleCount: 1, headers: [['Year']], headerMap: {}, matches: [] } }, res);
  assert.equal(res.code, 503);
  assert.equal(res.payload.error, 'MANHEIM_MIGRATION_PENDING');
  const tooMany = response();
  await handler({ method: 'POST', headers: {}, body: { action: 'manheim_upload_part', uploadId: null, partIndex: 1, partCount: 2, sourceFileCount: 1, vehicleCount: 1, headers: [['Year']], headerMap: {}, matches: Array(251).fill({}) } }, tooMany);
  assert.equal(tooMany.payload.error, 'MANHEIM_UPLOAD_INVALID');
});

test('20.000 combinações cabem no plano de partes', () => {
  const vehicle = { headers: ['Vin'], raw: { Vin: 'x'.repeat(900) }, parsed: { year: 2020, model: '911', miles: 1 } };
  const matches = Array.from({ length: 20000 }, (_, index) => ({ journeyId: uuid('51000000', 1), kind: 'BATE', fingerprint: 'vin:' + index, vehicle }));
  const parts = upload.planParts(matches, { sourceFileCount: 1, vehicleCount: 20000, headers: [['Vin']], headerMap: {} });
  assert.equal(parts.length, 80);
  assert.ok(parts.length <= 400);
  assert.ok(parts.every((part) => part.length <= 250));
  const heavy = Array.from({ length: 600 }, (_, index) => ({ kind: 'BATE', fingerprint: 'vin:' + index, vehicle: { ...vehicle, raw: { Vin: 'y'.repeat(20000) } } }));
  const heavyParts = upload.planParts(heavy, {});
  assert.ok(heavyParts.every((part) => Buffer.byteLength(JSON.stringify({ action: 'manheim_upload_part', matches: part })) < MAX_REQUEST_BYTES));
  assert.ok(heavyParts.length > 3);
});

test('BUSCAS: BATE antes de QUASE, menor milhagem primeiro, 10 visíveis e "Ver mais"', () => {
  const row = (kind, miles) => ({ match_kind: kind, vehicle_json: { parsed: { miles } } });
  const sorted = upload.sortForDisplay([row('QUASE', 100), row('BATE', 5000), row('QUASE', 50), row('BATE', 10)]);
  assert.deepEqual(sorted.map((item) => `${item.match_kind}:${item.vehicle_json.parsed.miles}`), ['BATE:10', 'BATE:5000', 'QUASE:50', 'QUASE:100']);
  const client = read('painel/painel.js');
  assert.match(client, /const MANHEIM_VISIBLE_ROWS = 10;/);
  assert.match(client, /`Ver mais \(\$\{hidden\.length\}\)`/);
  assert.match(client, /more\.replaceWith\(\.\.\.hidden\.map\(renderRow\)\)/);
  assert.equal((client.match(/appendManheimRows\(table, matches, \(match\)/g) || []).length, 2);
});

function panelSnippet(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `função ${name} existe`);
  const open = source.indexOf('{', match.index);
  let depth = 0, end = open;
  for (; end < source.length; end++) { if (source[end] === '{') depth++; else if (source[end] === '}' && !--depth) { end++; break; } }
  return source.slice(match.index, end);
}

test('todo erro da importação do Manheim tem código ou vira "Erro inesperado: …"', () => {
  const client = read('painel/painel.js');
  const importer = panelSnippet(client, 'importManheim');
  assert.doesNotMatch(importer, /throw new Error\(/, 'importManheim só lança erros com código');
  assert.doesNotMatch(importer, /askCleanStatus|showModal|<dialog/);
  assert.doesNotMatch(client, /function askCleanStatus|Esta busca tem clean title/);
  assert.doesNotMatch(client, /Não foi possível ler ou comparar este CSV\./);
  assert.doesNotMatch(client, /matches\.length > 2000/);
  const messages = /const MANHEIM_FAILURE_MESSAGES = (\{[\s\S]*?\n {2}\});/.exec(client)[1];
  const failureText = new Function('MAX_FILES', 'MANHEIM_MAX_MATCHES', 'window', 'MCSManheimUpload',
    `const MANHEIM_FAILURE_MESSAGES = ${messages};\nreturn (${panelSnippet(client, 'manheimFailureText')});`)(20, 100000, { MCSManheimUpload: upload }, upload);
  const coded = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
  for (const code of ['MANHEIM_FILES_INVALID', 'MANHEIM_READER_UNAVAILABLE', 'MANHEIM_JOURNEY_ID_INVALID', 'MANHEIM_FILE_TOO_LARGE', 'MANHEIM_FILE_READ_FAILED', 'MANHEIM_MATCH_LIMIT', 'MANHEIM_UPLOAD_INVALID', 'MANHEIM_MATCH_INVALID', 'MANHEIM_JOURNEY_DISABLED', 'MANHEIM_MIGRATION_PENDING', 'PAYLOAD_TOO_LARGE', 'PANEL_ACTION_FAILED']) {
    const text = failureText(coded(code));
    assert.ok(text && !text.startsWith('Erro inesperado'), `${code} tem mensagem própria`);
  }
  assert.equal(failureText(coded('MANHEIM_CSV_COLUMNS_MISSING', { missing: ['year', 'model'] })), 'CSV incompleto: faltam year, model.');
  assert.match(failureText(coded('MANHEIM_UPLOAD_INCOMPLETE', { partIndex: 3, partCount: 9, cause: coded('PANEL_ACTION_FAILED') })), /^Envio incompleto: a parte 3 de 9 falhou depois de 3 tentativas \(.+\)\. O último upload continua sendo o anterior\.$/);
  assert.match(failureText(coded('MANHEIM_UPLOAD_INCOMPLETE', { partIndex: 1, partCount: 2, cause: coded('MANHEIM_MIGRATION_PENDING') })), /parte 1 de 2 falhou \(O banco/);
  assert.equal(failureText(new TypeError('x is not a function')), 'Erro inesperado: x is not a function');
  assert.equal(failureText(coded('ALGO_NOVO')), 'Erro inesperado: ALGO_NOVO');
  assert.equal(failureText(undefined), 'Erro inesperado: undefined');
  const shower = panelSnippet(client, 'showManheimFailure');
  assert.match(shower, /console\.error\(failure\)/);
  assert.match(client, /status\.textContent = 'Lendo…'/);
  assert.match(client, /`Comparando \$\{vehicles\.length\} carros…`/);
  assert.match(client, /`Enviando parte \$\{partIndex\} de \$\{partCount\}…`/);
  assert.match(client, /`\$\{archived\} carros arquivados, \$\{ignored\} ignorados, \$\{combinations\} combinações\$\{discardedText\}`/);
  assert.match(read('painel/index.html'), /manheim\.js[\s\S]*manheim-upload\.js[\s\S]*painel\.js/);
});

test('migração do envio em partes: aditiva, RLS forçado e só service_role executa', () => {
  const sql = read('supabase/migrations/20260929020000_panel_manheim_upload_parts.sql');
  for (const table of ['manheim_upload_drafts', 'manheim_upload_draft_parts']) assert.match(sql, new RegExp(`alter table public\\.${table} force row level security`));
  assert.match(sql, /revoke all on table public\.manheim_upload_drafts, public\.manheim_upload_draft_parts from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.panel_store_manheim_upload_part\([^)]*\)\s+to service_role/);
  assert.doesNotMatch(sql, /drop table|drop function|alter table public\.manheim_uploads|create or replace function public\.panel_store_manheim_upload\(/i);
  assert.match(sql, /jsonb_array_length\(p_matches\) > 250/);
});

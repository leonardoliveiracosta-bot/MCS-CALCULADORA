'use strict';

// Teste realista de volume: 19 CSVs com ~70.000 linhas lidos pelo MESMO código do navegador
// (painel/manheim.js e painel/manheim-upload.js) e enviados como UM lote pelos handlers reais
// (api/panel/manheim-batch.js) contra um banco PGlite com todas as migrações. Falha de rede no meio
// e retomada, resposta perdida com bloco reenviado, telas comuns abertas durante o envio, dezenas de
// milhares de matches, BUSCAS por página, critério alterado depois da importação e métricas (tempo,
// tamanho das respostas, consultas ao banco, memória, linhas entregues ao navegador).
// Nada sai da máquina: Supabase, OpenAI, Anthropic e WhatsApp simulados ou recusados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
Object.assign(process.env, { VERCEL_ENV: 'preview', SUPABASE_URL: 'http://banco-simulado.local', SUPABASE_PUBLISHABLE_KEY: 'publica-simulada', SUPABASE_SECRET_KEY: 'secreta-simulada' });
for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'MANHEIM_OPENAI_ENABLED', 'MANHEIM_MATCH_AUDIT_ENABLED', 'ENTRADA_OPENAI_ENABLED', 'AUTO_REPLY_ENABLED', 'D360_API_KEY']) delete process.env[key];
const { BASE, createBackend } = require('./fixtures/banco-simulado');
const { volumeFiles, volumeSeed, volumeJourneyId: journeyId } = require('./fixtures/manheim-volume');
const manheim = require('../painel/manheim');
const upload = require('../painel/manheim-upload');

const ACTOR = '6e400000-0000-4000-8000-000000000001';
const REPORT = process.env.VOLUME_REPORT || '';

const seed = () => volumeSeed(ACTOR);

let backend;
const metrics = { api: [], memoryPeakMb: 0, uploadMs: 0, parseMs: 0, chunks: 0, requestBytesMax: 0 };
let sampler;
const sample = () => { metrics.memoryPeakMb = Math.max(metrics.memoryPeakMb, Math.round(process.memoryUsage().rss / 1048576)); };

async function handler(name, method, url, body) {
  const parsed = new URL(url, 'http://painel.local');
  const res = { statusCode: 200, payload: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(value) { this.payload = value; return value; }, end() {} };
  const before = backend.calls.length;
  const started = process.hrtime.bigint();
  await require('../api/panel/' + name)({ method, url: parsed.pathname + parsed.search, headers: { authorization: 'Bearer token-simulado' }, query: Object.fromEntries(parsed.searchParams), body }, res);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const bytes = Buffer.byteLength(JSON.stringify(res.payload || {}));
  sample();
  return { res, ms, bytes, queries: backend.calls.length - before };
}
async function screen(label, name, url) {
  const out = await handler(name, 'GET', url);
  assert.equal(out.res.statusCode, 200, `${label}: ${JSON.stringify(out.res.payload).slice(0, 200)}`);
  metrics.api.push({ label, ms: Math.round(out.ms), kb: Math.round(out.bytes / 102.4) / 10, queries: out.queries });
  return out;
}

// The browser request function, bridged to the real handler (JSON round trip, errors with code).
function bridge(options = {}) {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    metrics.requestBytesMax = Math.max(metrics.requestBytesMax, init.body ? Buffer.byteLength(init.body) : 0);
    const key = body && body.action === 'chunk' ? `${body.fileIndex}:${body.chunkIndex}` : body && body.action;
    if (options.beforeServer && options.beforeServer(key)) throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' });
    const out = await handler(url.replace(/^\/api\/panel\//, '').split('?')[0], init.method || 'GET', url, body);
    if (body && body.action === 'chunk') metrics.chunks += 1;
    if (options.afterServer && options.afterServer(key)) throw Object.assign(new Error('NETWORK_ERROR'), { code: 'NETWORK_ERROR' });
    if (out.res.statusCode >= 400) throw Object.assign(new Error(out.res.payload && out.res.payload.error || 'REQUEST_FAILED'), { code: out.res.payload && out.res.payload.error });
    if (options.onChunk && body && body.action === 'chunk') await options.onChunk(key);
    return JSON.parse(JSON.stringify(out.res.payload));
  };
}

// The same steps as importManheim in painel/painel.js (AI off: ambiguous rows go to review).
function readFiles(files) {
  const vehicles = [], meta = [], headers = [], mappings = [];
  let ignored = 0, ambiguous = 0;
  files.forEach((file, fileIndex) => {
    const parsed = manheim.parseCsv(file.text);
    const mapping = manheim.mapHeaders(parsed.headers);
    assert.deepEqual(mapping.missing, []);
    headers.push(parsed.headers); mappings.push(mapping.fields);
    const classified = manheim.classifyRows(parsed, mapping);
    ambiguous += classified.ambiguous.length;
    const normalized = upload.markSearchFiltered(manheim.chooseAuctionRows(classified.vehicles));
    ignored += parsed.rows.length - normalized.length - classified.ambiguous.length;
    normalized.forEach((vehicle) => vehicles.push({ ...upload.compactVehicle(vehicle), fileIndex, raw: { Inventory: vehicle.raw && vehicle.raw.Inventory || '' }, hasBuyNow: vehicle.hasBuyNow }));
    meta.push({ name: file.name, size: file.text.length, lastModified: 1790000000000, rowCount: parsed.rows.length });
  });
  return { vehicles, meta, headers, mappings, ignored, ambiguous };
}

test.before(async () => {
  backend = await createBackend({ seed: seed() });
  Object.assign(process.env, { SUPABASE_URL: BASE });
  globalThis.fetch = backend.fetch;
  require('../panel-manheim-state').resetUndoSupport();
  sampler = setInterval(sample, 200);
});
test.after(async () => {
  clearInterval(sampler);
  if (REPORT) fs.writeFileSync(REPORT, JSON.stringify(metrics, null, 2));
  if (backend) await backend.db.close();
});

let uploadId, plan, deduped, read;
test('19 CSVs, ~70 mil linhas: um lote, falha no meio e retomada, sem duplicar nada', async () => {
  const { files, rows } = volumeFiles();
  assert.equal(files.length, 19);
  assert.ok(rows >= 70000, `linhas: ${rows}`);
  const parseStarted = Date.now();
  read = readFiles(files);
  deduped = upload.dedupeAcrossFiles(read.vehicles, manheim);
  plan = upload.planBatch(read.meta, deduped.vehicles, manheim);
  metrics.parseMs = Date.now() - parseStarted;
  metrics.rows = rows; metrics.vehiclesRead = read.vehicles.length; metrics.uniqueVehicles = deduped.vehicles.length; metrics.duplicatesBetweenFiles = deduped.duplicates; metrics.ambiguousToReview = read.ambiguous;
  assert.ok(deduped.duplicates > 5000, `repetidos entre arquivos: ${deduped.duplicates}`);
  const common = { clientKey: '0123456789abcdef0123456789abcdef', vehicleCount: deduped.vehicles.length, headers: read.headers, headerMap: { files: read.mappings }, wait: async () => {}, retryDelayMs: 0 };

  // Network down at file 13, block 4 (the cases of the incident: files 12 and 13 never imported).
  const screensDuring = [];
  const started = Date.now();
  let failure = null;
  await upload.sendBatch({ ...common, plan, request: bridge({
    beforeServer: (key) => key === '12:3',
    onChunk: async (key) => {
      // The panel keeps working while the batch is sent: login, CLIENTES, HOJE, ENTRADA and BUSCAS.
      if (key === '5:0') {
        screensDuring.push(await screen('sessão durante o envio', 'session', '/api/panel/session'));
        screensDuring.push(await screen('CLIENTES durante o envio', 'records', '/api/panel/records?sort=ready'));
        screensDuring.push(await screen('HOJE durante o envio', 'today', '/api/panel/today?sort=ready'));
        screensDuring.push(await screen('ENTRADA durante o envio', 'entry', '/api/panel/entry'));
        const buscas = await screen('BUSCAS durante o envio', 'records', '/api/panel/records?view=manheim');
        assert.equal(buscas.res.payload.upload, null, 'o lote em montagem nunca aparece');
      }
    }
  }) }).catch((error) => { failure = error; });
  assert.ok(failure, 'o envio parou no bloco sem rede');
  assert.equal(failure.code, 'MANHEIM_UPLOAD_INCOMPLETE');
  assert.equal(failure.fileName, 'MCS_VOLUME_13.csv');
  uploadId = failure.uploadId;
  const staging = (await backend.db.query(`select activated_at from public.manheim_uploads where id=$1`, [uploadId])).rows[0];
  assert.equal(staging.activated_at, null, 'nada foi ativado pela metade');

  // Same files chosen again: the batch continues from the confirmed blocks. One response is lost
  // after the server stored its block (the block is sent again and nothing is duplicated).
  let lost = false;
  const result = await upload.sendBatch({ ...common, plan, request: bridge({ afterServer: (key) => { if (key === '15:2' && !lost) { lost = true; return true; } return false; } }) });
  metrics.uploadMs = Date.now() - started;
  assert.equal(result.uploadId, uploadId, 'mesmo lote');
  assert.ok(result.totals.resumedChunks >= 80, `blocos retomados: ${result.totals.resumedChunks}`);
  assert.equal(result.fileCount, 19);
  metrics.batch = { vehicleCount: result.vehicleCount, matchedCars: result.matchedVehicleCount, leadCount: result.leadCount, discarded: result.discarded };

  const { rows: [counts] } = await backend.db.query(`select (select count(*)::int from public.manheim_uploads where environment='preview') uploads,
      (select count(*)::int from public.manheim_uploads where environment='preview' and activated_at is not null and undone_at is null) live,
      (select count(*)::int from public.manheim_vehicles where upload_id=$1) vehicles,
      (select count(distinct row_fingerprint)::int from public.manheim_vehicles where upload_id=$1) fingerprints,
      (select count(*)::int from public.manheim_upload_chunks where upload_id=$1) chunks,
      (select count(*)::int from public.manheim_matches where upload_id=$1) matches,
      (select count(*)::int from (select 1 from public.manheim_matches where upload_id=$1 group by row_fingerprint, demand_key having count(*) > 1) d) duplicated,
      (select count(*)::int from public.manheim_matches where upload_id=$1 and coalesce(mmr_cents,0) <= 0) without_mmr`, [uploadId]);
  metrics.database = counts;
  assert.equal(counts.uploads, 1, 'um único lote lógico');
  assert.equal(counts.live, 1);
  assert.equal(counts.vehicles, deduped.vehicles.length, 'todos os carros, deduplicados entre arquivos');
  assert.equal(counts.fingerprints, counts.vehicles);
  assert.equal(counts.chunks, plan.reduce((sum, file) => sum + file.chunkCount, 0), 'todos os arquivos e blocos registrados');
  assert.ok(counts.matches >= 20000, `matches: ${counts.matches}`);
  assert.equal(counts.duplicated, 0, 'nenhum match duplicado');
  assert.equal(counts.without_mmr, 0, 'carro sem MMR nunca vira opção');
  // Cars without a valid MMR were stored (cold inventory) but never matched.
  const { rows: [invalid] } = await backend.db.query(`select count(*)::int n from public.manheim_vehicles v where v.upload_id=$1 and v.mmr_cents is null and exists (select 1 from public.manheim_matches m where m.upload_id=v.upload_id and m.row_fingerprint=v.row_fingerprint)`, [uploadId]);
  assert.equal(invalid.n, 0);
  const { rows: [noMmr] } = await backend.db.query(`select count(*)::int n from public.manheim_vehicles where upload_id=$1 and mmr_cents is null`, [uploadId]);
  assert.ok(noMmr.n > 3000, `carros sem MMR guardados e nunca comparados: ${noMmr.n}`);
  metrics.withoutMmrStored = noMmr.n;
  // The per-file progress is on the server.
  const status = await handler('manheim-batch', 'POST', '/api/panel/manheim-batch', { action: 'status', uploadId });
  assert.equal(status.res.payload.files.length, 19);
  assert.ok(status.res.payload.files.every((file) => file.received === file.chunkCount));
  // Screens stayed small and fast during the upload.
  for (const out of screensDuring) assert.ok(out.bytes < 2 * 1048576, 'resposta menor que 2 MB');
  assert.ok(metrics.requestBytesMax < 1500000, `maior requisição: ${metrics.requestBytesMax} bytes`);
});

test('depois do lote: telas comuns sem inventário, BUSCAS sem carros e páginas sem pular nem repetir', async () => {
  const session = await screen('sessão', 'session', '/api/panel/session');
  const clients = await screen('CLIENTES', 'records', '/api/panel/records?sort=ready');
  const today = await screen('HOJE', 'today', '/api/panel/today?sort=ready');
  const entry = await screen('ENTRADA', 'entry', '/api/panel/entry');
  const buscas = await screen('BUSCAS (resumo)', 'records', '/api/panel/records?view=manheim');
  const searches = await screen('BUSCAS (buscas por cliente)', 'searches', '/api/panel/searches');
  assert.ok(session.ms < 2000, `sessão: ${session.ms} ms`);
  for (const out of [clients, today, entry, buscas, searches]) {
    assert.ok(out.ms < 5000, `tela comum: ${out.ms} ms`);
    assert.ok(out.bytes < 2 * 1048576, `resposta: ${out.bytes} bytes`);
  }
  // CLIENTES and HOJE never read the inventory nor the matches (only presented cars, by index).
  const before = backend.calls.length;
  await handler('records', 'GET', '/api/panel/records?sort=ready');
  await handler('today', 'GET', '/api/panel/today?sort=ready');
  const inventory = backend.calls.slice(before).filter((entryCall) => /\/rest\/v1\/(manheim_vehicles|manheim_matches)\b/.test(entryCall.path) && !/presented_unit_id=not\.is\.null/.test(entryCall.search));
  assert.deepEqual(inventory, []);
  const view = buscas.res.payload;
  assert.equal(view.matches, undefined);
  metrics.buscasCarsSent = 0;
  const totalMatches = (await backend.db.query(`select count(*)::int n from public.manheim_matches where upload_id=$1 and undone_at is null`, [uploadId])).rows[0].n;
  assert.equal(view.counts.total.matches, totalMatches, 'contadores do servidor batem com o banco');
  assert.ok(view.demands.every((demand) => !demand.stale));
  // Largest demand: every page (50 at a time) with the stable cursor, no car skipped or repeated.
  const largest = view.demands.slice().sort((a, b) => b.matchCount - a.matchCount)[0];
  const seen = new Set();
  let cursor = null, pages = 0, firstPage = null;
  do {
    const page = await screen(pages ? 'BUSCAS página seguinte' : 'BUSCAS primeira página (10)', 'manheim-options', `/api/panel/manheim-options?key=${largest.key}&limit=${pages ? 50 : 10}${cursor ? '&cursor=' + cursor : ''}`);
    if (!pages) firstPage = page;
    page.res.payload.options.forEach((option) => { assert.ok(!seen.has(option.id), 'nenhum carro repetido'); seen.add(option.id); });
    cursor = page.res.payload.nextCursor; pages += 1;
  } while (cursor);
  assert.equal(seen.size, largest.matchCount, 'nenhum carro pulado');
  assert.equal(firstPage.res.payload.options.length, 10, 'no máximo 10 opções na abertura');
  assert.ok(firstPage.bytes < 64 * 1024);
  metrics.largestDemand = { key: largest.key.replace(/[0-9a-f-]{36}/, 'ficha'), matches: largest.matchCount, pages };
  metrics.rowsToBrowser = { clientes: clients.res.payload.items.length, hoje: today.res.payload.items.length, buscasCars: 0, firstOptionsPage: firstPage.res.payload.options.length };
});

test('critério alterado depois da importação: "Conferir novamente" e nova comparação só dessa demanda', async () => {
  const target = journeyId(1);
  await backend.db.query(`update public.journeys set criteria_json=$2 where id=$1`, [target, JSON.stringify({ wishlists: [{ make: 'Honda', model: 'CR-V', yearMin: 2016, yearMax: 2017, minMiles: 10000, maxMiles: 40000 }], logical_modes: ['CARRO'] })]);
  let view = (await handler('records', 'GET', '/api/panel/records?view=manheim')).res.payload;
  const key = `journey:${target}:CARRO`;
  const before = view.demands.find((demand) => demand.key === key);
  assert.equal(before.stale, true);
  const otherBefore = view.demands.filter((demand) => demand.key !== key).map((demand) => [demand.key, demand.matchCount]);
  const rematch = await handler('manheim-options', 'POST', '/api/panel/manheim-options', { action: 'rematch', key });
  assert.equal(rematch.res.statusCode, 200, JSON.stringify(rematch.res.payload));
  metrics.api.push({ label: 'Conferir novamente (uma demanda)', ms: Math.round(rematch.ms), kb: Math.round(rematch.bytes / 102.4) / 10, queries: rematch.queries });
  view = (await handler('records', 'GET', '/api/panel/records?view=manheim')).res.payload;
  const after = view.demands.find((demand) => demand.key === key);
  assert.equal(after.stale, false);
  assert.ok(after.matchCount < before.matchCount, `${before.matchCount} → ${after.matchCount}`);
  assert.deepEqual(view.demands.filter((demand) => demand.key !== key).map((demand) => [demand.key, demand.matchCount]), otherBefore, 'as outras demandas não mudam');
  // Every option left is inside the new criterion.
  const { rows } = await backend.db.query(`select vehicle_json from public.manheim_matches where upload_id=$1 and demand_key=$2 and undone_at is null`, [uploadId, key]);
  assert.ok(rows.every(({ vehicle_json: { parsed } }) => parsed.year >= 2016 && parsed.year <= 2017 && parsed.miles >= 10000 && parsed.miles <= 40000));
});

test('consultas dirigidas usam os índices novos (EXPLAIN com o lote de ~60 mil carros)', async () => {
  const key = (await backend.db.query(`select demand_key from public.manheim_matches where upload_id=$1 and undone_at is null group by 1 order by count(*) desc limit 1`, [uploadId])).rows[0].demand_key;
  await backend.db.query('analyze');
  const plan = async (label, sql, params) => {
    const text = (await backend.db.query('explain (analyze, costs off, timing on, summary on) ' + sql, params)).rows.map((row) => row['QUERY PLAN']).join('\n');
    metrics.plans = metrics.plans || {};
    metrics.plans[label] = text;
    return text;
  };
  const page = await plan('página de uma demanda', `select m.id from public.manheim_matches m where m.environment='preview' and m.upload_id=$1 and m.undone_at is null and m.demand_key=$2 order by m.sort_rank, m.sort_miles, m.id limit 11`, [uploadId, key]);
  assert.match(page, /Index (Only )?Scan using manheim_matches_demand_page_idx/);
  const summary = await plan('resumo por demanda', `select * from public.panel_manheim_batch_summary('preview', $1)`, [uploadId]);
  assert.match(summary, /Execution Time/);
  const make = await plan('inventário por marca (ficha)', `select row_fingerprint from public.manheim_vehicles where environment='preview' and upload_id=$1 and undone_at is null and make_key = any($2)`, [uploadId, ['honda', '']]);
  assert.match(make, /manheim_vehicles_upload_make_idx/);
  const ms = (text) => Number((/Execution Time: ([\d.]+) ms/.exec(text) || [])[1]);
  metrics.planMs = Object.fromEntries(Object.entries(metrics.plans).map(([label, text]) => [label, ms(text)]));
  metrics.planMs['score (MMR por pessoa)'] = ms(await plan('score (MMR por pessoa)', `select * from public.panel_manheim_score_mmr('preview', now() - interval '60 days')`, []));
  metrics.planMs['carros por pessoa'] = ms(await plan('carros por pessoa', `select * from public.panel_manheim_batch_people('preview', $1)`, [uploadId]));
  metrics.planMs['página (função, maior demanda)'] = ms(await plan('página (função, maior demanda)', `select id from public.panel_manheim_demand_options('preview', $1, $2, null, null, null, 11)`, [uploadId, key]));
  metrics.planMs['carros por lote'] = ms(await plan('carros por lote', `select * from public.panel_manheim_batch_cars('preview', array[$1]::uuid[])`, [uploadId]));
  assert.ok(Object.values(metrics.planMs).every((value) => value < 1000), JSON.stringify(metrics.planMs));
});

test('nenhuma chamada paga, nenhuma mensagem enviada, nenhum cliente alterado pelo lote', async () => {
  assert.deepEqual(backend.refused, [], 'nada saiu da máquina');
  const { rows: [facts] } = await backend.db.query(`select (select count(*)::int from public.audit_log where entity_type='manheim_openai') openai,
    (select count(*)::int from public.messages where direction='MCS') sent, (select count(*)::int from public.contacts) contacts,
    (select count(*)::int from public.journeys where updated_at > now() - interval '1 hour' and id <> $1) touched`, [journeyId(1)]);
  assert.equal(facts.openai, 0);
  assert.equal(facts.sent, 0);
  assert.equal(facts.contacts, 32);
  metrics.memoryPeakMb = Math.max(metrics.memoryPeakMb, Math.round(process.memoryUsage().rss / 1048576));
  console.log(JSON.stringify({ volume: metrics }, null, 1));
  if (REPORT) fs.writeFileSync(path.resolve(REPORT), JSON.stringify(metrics, null, 2));
});

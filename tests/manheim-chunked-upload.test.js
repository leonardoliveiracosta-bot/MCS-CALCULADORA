'use strict';

// Envio do Manheim em lote único (navegador): blocos de até 500 carros por arquivo, deduplicação
// entre arquivos em tempo linear, repetição de bloco com espera crescente, retomada dos blocos já
// confirmados, recuperação quando a ativação acusa bloco faltando, cancelamento pelo operador,
// mensagens de erro e as migrações (antiga e nova) aditivas e restritas ao service_role.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manheim = require('../painel/manheim');
const upload = require('../painel/manheim-upload');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const MAX_REQUEST_BYTES = 1500000;

const car = (n, fileIndex, extra = {}) => ({ vin: 'VIN' + String(n).padStart(14, '0'), year: 2020, make: 'BMW', model: 'X5', trim: 'xDrive40i', miles: 1000 + n, mmrCents: 4000000,
  location: 'FL - Orlando', saleDate: '2026-10-01', fileIndex, raw: { 'Lot #': 'L' + n, Inventory: '' }, headers: ['Vin', 'Lot #'], ...extra });

test('plano do lote: blocos de até 500 por arquivo, só o carro lido (sem a linha crua) e o lote do leilão', () => {
  const files = [{ name: 'A.csv', size: 10, rowCount: 1200 }, { name: 'B.csv', size: 10, rowCount: 3 }];
  const vehicles = [...Array.from({ length: 1200 }, (_, n) => car(n, 0)), car(5000, 1), car(5001, 1), car(5002, 1)];
  const plan = upload.planBatch(files, vehicles, manheim);
  assert.deepEqual(plan.map((file) => [file.name, file.vehicleCount, file.chunkCount, file.chunks.map((chunk) => chunk.length)]), [['A.csv', 1200, 3, [500, 500, 200]], ['B.csv', 3, 1, [3]]]);
  const first = plan[0].chunks[0][0];
  assert.equal(first.fingerprint, manheim.fingerprint(car(0, 0)));
  assert.equal(first.vehicle.lot, 'L0');
  assert.equal(first.vehicle.raw, undefined);
  assert.equal(first.vehicle.headers, undefined);
  // A heavy block of 500 cars stays far below the request limit.
  const heavy = upload.planBatch([{ name: 'H.csv' }], Array.from({ length: 500 }, (_, n) => car(n, 0, { trim: 'x'.repeat(120), location: 'y'.repeat(200), conditionGrade: 'z'.repeat(120) })), manheim);
  assert.ok(Buffer.byteLength(JSON.stringify({ action: 'chunk', vehicles: heavy[0].chunks[0] })) < MAX_REQUEST_BYTES);
});

test('o mesmo carro em dois arquivos é um carro (simulcast vence, "buy now" preservado), em tempo linear', () => {
  const a = car(1, 0, { buyNowPrice: '' }), b = car(1, 1, { raw: { Inventory: 'Simulcast' }, buyNowPrice: '$40,000' }), c = car(2, 1);
  const { vehicles, duplicates } = upload.dedupeAcrossFiles([a, b, c], manheim);
  assert.equal(duplicates, 1);
  assert.equal(vehicles.length, 2);
  const kept = vehicles.find((vehicle) => vehicle.vin === a.vin);
  assert.equal(kept.raw.Inventory, 'Simulcast');
  assert.equal(kept.fileIndex, 0, 'fica no arquivo em que apareceu primeiro');
  assert.equal(kept.buyNowPrice, '$40,000');
  // 70.000 cars (half repeated between files) in well under a second.
  const many = Array.from({ length: 70000 }, (_, n) => car(n % 35000, n < 35000 ? 0 : 1));
  const started = Date.now();
  const result = upload.dedupeAcrossFiles(many, manheim);
  assert.equal(result.vehicles.length, 35000);
  assert.ok(Date.now() - started < 3000, `levou ${Date.now() - started} ms`);
});

// A fake server with the same answers as api/panel/manheim-batch.js.
function fakeServer(options = {}) {
  const state = { calls: [], received: new Set(options.received || []), failures: { ...(options.failures || {}) }, finalized: false, missing: options.missing || null };
  const request = async (_path, init) => {
    const body = JSON.parse(init.body);
    state.calls.push(body.action + (body.action === 'chunk' ? ` ${body.fileIndex}:${body.chunkIndex}` : ''));
    const key = body.action === 'chunk' ? `${body.fileIndex}:${body.chunkIndex}` : body.action;
    if (state.failures[key]) { const failure = state.failures[key].shift(); if (!state.failures[key].length) delete state.failures[key]; throw Object.assign(new Error(failure), { code: failure }); }
    if (body.action === 'start') return { uploadId: '7a000000-0000-4000-8000-000000000001', resumed: state.received.size > 0, received: [...state.received].map((item) => item.split(':').map(Number)) };
    if (body.action === 'chunk') { state.received.add(key); return { storedVehicles: body.vehicles.length, storedMatches: 1, discarded: 0 }; }
    if (body.action === 'status') return { received: [...state.received].map((item) => item.split(':').map(Number)) };
    if (body.action === 'finalize') {
      if (state.missing && state.received.has(state.missing)) { state.received.delete(state.missing); state.missing = null; throw Object.assign(new Error('MANHEIM_BATCH_INCOMPLETE'), { code: 'MANHEIM_BATCH_INCOMPLETE' }); }
      state.finalized = true;
      return { complete: true, fileCount: 2, vehicleCount: 1203, matchedVehicleCount: 4 };
    }
    throw new Error('ACAO_DESCONHECIDA');
  };
  return { state, request };
}
const plan = () => upload.planBatch([{ name: 'A.csv' }, { name: 'B.csv' }], [...Array.from({ length: 1200 }, (_, n) => car(n, 0)), car(5000, 1), car(5001, 1), car(5002, 1)], manheim);
const base = { clientKey: 'f'.repeat(32), vehicleCount: 1203, headers: [['Vin']], headerMap: {}, wait: async () => {}, retryDelayMs: 0 };

test('envio: todos os blocos, falha passageira repete, ativação só no fim', async () => {
  const server = fakeServer({ failures: { '0:1': ['NETWORK_ERROR', 'REQUEST_TIMEOUT'] } });
  const waits = [];
  const progress = [];
  const result = await upload.sendBatch({ ...base, plan: plan(), request: server.request, wait: async (ms) => { waits.push(ms); }, retryDelayMs: 1000, onProgress: (event) => progress.push(event.done) });
  assert.equal(result.complete, true);
  assert.deepEqual(server.state.calls, ['start', 'chunk 0:0', 'chunk 0:1', 'chunk 0:1', 'chunk 0:1', 'chunk 0:2', 'chunk 1:0', 'finalize']);
  assert.deepEqual(waits, [1000, 2000], 'espera crescente entre tentativas');
  assert.deepEqual(progress, [0, 1, 2, 3, 4]);
  assert.equal(result.totals.storedVehicles, 1203);
});

test('retomada: blocos já confirmados não são reenviados; erro definitivo para na hora', async () => {
  const server = fakeServer({ received: ['0:0', '0:1'] });
  const progress = [];
  await upload.sendBatch({ ...base, plan: plan(), request: server.request, onProgress: (event) => progress.push(event.resumed || event.done) });
  assert.deepEqual(server.state.calls, ['start', 'chunk 0:2', 'chunk 1:0', 'finalize']);
  assert.deepEqual(progress[0], [[0, 0], [0, 1]], 'o progresso começa com os blocos já confirmados');
  const final = fakeServer({ failures: { '0:1': ['MANHEIM_BATCH_CANCELED'] } });
  await assert.rejects(() => upload.sendBatch({ ...base, plan: plan(), request: final.request }), (failure) => failure.code === 'MANHEIM_UPLOAD_INCOMPLETE' && failure.fileIndex === 0 && failure.chunkIndex === 1 && failure.fileName === 'A.csv' && failure.cause.code === 'MANHEIM_BATCH_CANCELED' && Boolean(failure.uploadId));
  assert.deepEqual(final.state.calls, ['start', 'chunk 0:0', 'chunk 0:1'], 'erro definitivo não repete e nada é ativado');
  assert.equal(final.state.finalized, false);
});

test('ativação acusa bloco faltando: o navegador pergunta quais faltam, reenvia e ativa', async () => {
  const server = fakeServer({ missing: '1:0' });
  const result = await upload.sendBatch({ ...base, plan: plan(), request: server.request });
  assert.equal(result.complete, true);
  assert.deepEqual(server.state.calls.slice(-4), ['finalize', 'status', 'chunk 1:0', 'finalize']);
});

test('cancelar pelo operador para o envio antes do próximo bloco', async () => {
  const server = fakeServer();
  let sent = 0;
  await assert.rejects(() => upload.sendBatch({ ...base, plan: plan(), request: server.request, canceled: () => sent >= 2, onProgress: (event) => { if (event.fileIndex !== null) sent += 1; } }), (failure) => failure.code === 'MANHEIM_BATCH_CANCELED_BY_OPERATOR');
  assert.equal(server.state.finalized, false);
  assert.deepEqual(server.state.calls, ['start', 'chunk 0:0', 'chunk 0:1']);
});

test('BUSCAS: ordem de exibição e opções carregadas por página, 10 de cada vez', () => {
  const row = (kind, miles) => ({ match_kind: kind, vehicle_json: { parsed: { miles } } });
  const sorted = upload.sortForDisplay([row('QUASE', 100), row('BATE', 5000), row('QUASE', 50), row('BATE', 10)]);
  assert.deepEqual(sorted.map((item) => `${item.match_kind}:${item.vehicle_json.parsed.miles}`), ['BATE:10', 'BATE:5000', 'QUASE:50', 'QUASE:100']);
  const client = read('painel/painel.js');
  assert.match(client, /const MANHEIM_PAGE_ROWS = 10;/);
  assert.match(client, /'\/api\/panel\/manheim-options\?' \+ params\.toString\(\)/);
  assert.match(client, /`Ver mais \(\$\{Math\.max\(demand\.matchCount - loaded\.length, 1\)\}\)`/);
  assert.equal((client.match(/const table = lazyOptions\(card, demand, loaded,/g) || []).length, 2);
  // The same order is kept by the database page (BATE, POR VALOR, lowest mileage, then id).
  assert.match(read('supabase/migrations/20261005010000_panel_manheim_lote_unico.sql'), /order by coalesce\(m\.sort_rank::integer, case m\.match_kind when 'BATE' then 0 when 'POR_VALOR' then 1 else 2 end\), coalesce\(m\.sort_miles,/);
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
  // The screen is reloaded once, after the whole batch (never after each file).
  assert.equal((importer.match(/await loadCurrent\(\)/g) || []).length, 1);
  assert.match(importer, /MCSManheimUpload\.sendBatch\(/);
  assert.doesNotMatch(importer, /buildMatches|manheim_archive|manheim_upload_part/);
  const messages = /const MANHEIM_FAILURE_MESSAGES = (\{[\s\S]*?\n {2}\});/.exec(client)[1];
  const failureText = new Function('MAX_FILES', 'MANHEIM_MAX_MATCHES', 'window', 'MCSManheimUpload',
    `const MANHEIM_FAILURE_MESSAGES = ${messages};\nreturn (${panelSnippet(client, 'manheimFailureText')});`)(20, 100000, { MCSManheimUpload: upload }, upload);
  const coded = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
  for (const code of ['MANHEIM_FILES_INVALID', 'MANHEIM_READER_UNAVAILABLE', 'MANHEIM_FILE_TOO_LARGE', 'MANHEIM_FILE_READ_FAILED', 'MANHEIM_UPLOAD_INVALID', 'MANHEIM_MATCH_INVALID', 'MANHEIM_MIGRATION_PENDING', 'MANHEIM_UPLOAD_RUNNING', 'MANHEIM_BATCH_CANCELED', 'PAYLOAD_TOO_LARGE']) {
    const text = failureText(coded(code));
    assert.ok(text && !text.startsWith('Erro inesperado'), `${code} tem mensagem própria`);
  }
  assert.equal(failureText(coded('MANHEIM_CSV_COLUMNS_MISSING', { missing: ['year', 'model'] })), 'CSV incompleto: faltam year, model.');
  const interrupted = failureText(coded('MANHEIM_UPLOAD_INCOMPLETE', { fileName: 'MCS_HOJE_12.csv', chunkIndex: 3, uploadId: 'x', cause: coded('REQUEST_TIMEOUT') }));
  assert.equal(interrupted, 'Envio interrompido em MCS_HOJE_12.csv, bloco 4 (O servidor demorou para responder). Nada foi ativado e o lote ativo não mudou. Selecione os mesmos arquivos de novo para continuar de onde parou');
  assert.equal(failureText(new TypeError('x is not a function')), 'Erro inesperado: x is not a function');
  assert.equal(failureText(coded('ALGO_NOVO')), 'Erro inesperado: ALGO_NOVO');
  const shower = panelSnippet(client, 'showManheimFailure');
  assert.match(shower, /console\.error\(failure\)/);
  assert.match(shower, /Descartar este envio/);
  assert.match(read('painel/index.html'), /manheim\.js[\s\S]*manheim-upload\.js[\s\S]*refresh-coordinator\.js[\s\S]*painel\.js/);
});

test('migrações: a antiga continua como estava; a nova é aditiva, com RLS forçado e só service_role executa', () => {
  const old = read('supabase/migrations/20260929020000_panel_manheim_upload_parts.sql');
  assert.match(old, /jsonb_array_length\(p_matches\) > 250/);
  const sql = read('supabase/migrations/20261005010000_panel_manheim_lote_unico.sql');
  assert.doesNotMatch(sql, /\bdrop\s+(table|function|column|index)\b/i);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/i, 'nada é apagado');
  assert.doesNotMatch(sql, /\btruncate\b/i);
  assert.match(sql, /alter table public\.manheim_upload_chunks force row level security/);
  assert.match(sql, /revoke all on table public\.manheim_upload_chunks from public, anon, authenticated/);
  assert.match(sql, /execute format\('revoke all on function %s from public, anon, authenticated', v_signature\)/);
  assert.match(sql, /execute format\('grant execute on function %s to service_role', v_signature\)/);
  const functions = [...sql.matchAll(/create or replace function (public\.panel_manheim_[a-z_]+)\(/g)].map((match) => match[1]);
  const granted = [...sql.matchAll(/'(public\.panel_manheim_[a-z_]+)\(/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(functions)].sort(), [...new Set(granted)].sort(), 'toda função nova tem permissão revogada e dada só ao service_role');
});

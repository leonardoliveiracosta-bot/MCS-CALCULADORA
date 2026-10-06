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
const base = { clientKey: 'f'.repeat(32), manifest: { files: [], manifestHash: 'f'.repeat(64) }, vehicleCount: 1203, headers: [['Vin']], headerMap: {}, wait: async () => {}, retryDelayMs: 0 };

test('manifesto: hash canônico igual no navegador e no servidor, por bloco, e enviado no início do lote', async () => {
  const crypto = require('node:crypto');
  const { contentHash } = require('../panel-manheim-batch');
  const hashText = async (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  // Key order and absent fields do not change the hash; any value does.
  assert.equal(upload.canonicalJson({ b: 1, a: [{ y: 2, x: undefined, z: 'ç' }] }), '{"a":[{"y":2,"z":"ç"}],"b":1}');
  assert.equal(upload.canonicalJson({ a: 1, b: 2 }), upload.canonicalJson({ b: 2, a: 1 }));
  const sealed = plan();
  const manifest = await upload.sealPlan(sealed, hashText);
  assert.deepEqual(manifest.files.map((file) => file.chunks.map((chunk) => chunk.count)), [[500, 500, 200], [3]]);
  // What the server recalculates from the block as it arrives (after JSON) is the same hash.
  const arrived = JSON.parse(JSON.stringify(sealed[0].chunks[1]));
  assert.equal(contentHash(arrived), manifest.files[0].chunks[1].hash);
  assert.equal(contentHash(JSON.parse(JSON.stringify(manifest.files))), manifest.manifestHash);
  const changed = JSON.parse(JSON.stringify(sealed[0].chunks[1])); changed[0].vehicle.mmrCents += 1;
  assert.notEqual(contentHash(changed), manifest.files[0].chunks[1].hash, 'um centavo muda o hash');
  const server = fakeServer();
  const bodies = [];
  const spy = async (path, init) => { bodies.push(JSON.parse(init.body)); return server.request(path, init); };
  await upload.sendBatch({ ...base, plan: sealed, manifest, request: spy });
  assert.deepEqual(bodies[0].files, manifest.files);
  assert.equal(bodies[0].manifestHash, manifest.manifestHash);
  await assert.rejects(() => upload.sendBatch({ ...base, manifest: null, plan: plan(), request: spy }), (failure) => failure.code === 'MANHEIM_UPLOAD_INVALID');
});

test('recusas de integridade param na hora e guardam o lote para o operador descartar', async () => {
  for (const code of ['MANHEIM_CHUNK_CONFLICT', 'MANHEIM_CHUNK_HASH_MISMATCH']) {
    const server = fakeServer({ failures: { '0:1': [code] } });
    await assert.rejects(() => upload.sendBatch({ ...base, plan: plan(), request: server.request }), (failure) => failure.code === 'MANHEIM_UPLOAD_INCOMPLETE' && failure.cause.code === code && Boolean(failure.uploadId));
    assert.deepEqual(server.state.calls, ['start', 'chunk 0:0', 'chunk 0:1'], `${code} não repete`);
  }
  const integrity = fakeServer({ failures: { finalize: ['MANHEIM_BATCH_INTEGRITY_ERROR'] } });
  await assert.rejects(() => upload.sendBatch({ ...base, plan: plan(), request: integrity.request }), (failure) => failure.code === 'MANHEIM_BATCH_INTEGRITY_ERROR' && failure.uploadId === '7a000000-0000-4000-8000-000000000001');
  assert.equal(integrity.state.calls.filter((call) => call === 'finalize').length, 1, 'recusa de integridade não repete');
  const mismatch = fakeServer({ failures: { start: ['MANHEIM_BATCH_RESUME_MISMATCH'] } });
  await assert.rejects(() => upload.sendBatch({ ...base, plan: plan(), request: mismatch.request }), (failure) => failure.code === 'MANHEIM_BATCH_RESUME_MISMATCH');
  assert.deepEqual(mismatch.state.calls, ['start'], 'retomada recusada não envia bloco nenhum');
});

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

test('acréscimo ao lote ativo: dentro do limite segue direto; o limite do banco para na hora, sem repetir', async () => {
  // Common path: an append that fits goes start, blocks, finalize once, with nothing added.
  const server = fakeServer();
  const result = await upload.sendBatch({ ...base, plan: plan(), request: server.request, append: true });
  assert.equal(result.complete, true);
  assert.deepEqual(server.state.calls, ['start', 'chunk 0:0', 'chunk 0:1', 'chunk 0:2', 'chunk 1:0', 'finalize']);
  // The database refuses the join above 50 files (MANHEIM_BATCH_LIMIT): a definitive answer, asked once.
  const full = fakeServer({ failures: { finalize: ['MANHEIM_BATCH_LIMIT'] } });
  const waits = [];
  await assert.rejects(() => upload.sendBatch({ ...base, plan: plan(), request: full.request, append: true, wait: async (ms) => { waits.push(ms); } }),
    (failure) => failure.code === 'MANHEIM_BATCH_LIMIT' && failure.uploadId === '7a000000-0000-4000-8000-000000000001');
  assert.equal(full.state.calls.filter((call) => call === 'finalize').length, 1, 'limite não repete');
  assert.deepEqual(waits, []);
  // The panel applies the same limit before any block travels (active files + new files > MANHEIM_MAX_FILES).
  const importer = panelSnippet(read('painel/painel.js'), 'importManheim');
  const guard = /\n\s*(if \(append && \(Number\(current\.latest\.fileCount\)[^\n]*)/.exec(importer);
  assert.ok(guard, 'o painel confere o limite antes do envio');
  assert.ok(importer.indexOf(guard[1]) < importer.indexOf('MCSManheimUpload.sendBatch('), 'a conferência vem antes do envio');
  const refuses = (activeFiles, newFiles) => {
    try { new Function('append', 'current', 'fileMeta', 'MANHEIM_MAX_FILES', 'manheimError', guard[1])(true, { latest: { fileCount: activeFiles } }, Array.from({ length: newFiles }), 50, (code, details) => Object.assign(new Error(code), { code }, details)); return null; }
    catch (failure) { return failure; }
  };
  assert.equal(refuses(35, 13), null, '35 + 13 cabe');
  assert.equal(refuses(48, 2), null, 'exatamente 50 cabe');
  assert.deepEqual({ ...refuses(48, 13) }, { code: 'MANHEIM_BATCH_LIMIT', activeFiles: 48, newFiles: 13 });
  assert.equal(new Function('append', 'current', 'fileMeta', 'MANHEIM_MAX_FILES', 'manheimError', guard[1])(false, { latest: { fileCount: 48 } }, Array.from({ length: 13 }), 50, () => { throw new Error('x'); }), undefined, 'lote novo não passa por esta conferência');
});

test('BUSCAS: ordem de exibição e opções carregadas por página, 10 de cada vez', () => {
  const row = (kind, miles) => ({ match_kind: kind, vehicle_json: { parsed: { miles } } });
  const sorted = upload.sortForDisplay([row('QUASE', 100), row('BATE', 5000), row('QUASE', 50), row('BATE', 10)]);
  assert.deepEqual(sorted.map((item) => `${item.match_kind}:${item.vehicle_json.parsed.miles}`), ['BATE:10', 'BATE:5000', 'QUASE:50', 'QUASE:100']);
  const client = read('painel/painel.js');
  assert.match(client, /const MANHEIM_PAGE_ROWS = 10;/);
  assert.match(client, /'\/api\/panel\/manheim-options\?' \+ params\.toString\(\)/);
  assert.match(client, /`Ver mais \(\$\{Math\.max\(filteredTotal - loadedCount, 1\)\}\)`/);
  // The paged option lists moved from the tab cards into the ficha (offerGroup): nothing loads inline any more.
  assert.doesNotMatch(client, /const table = lazyOptions\(card, demand, loaded,/);
  assert.match(client, /function offerGroup\(demand, groupKey, count, state\)/);
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
  const refusals = /const CHUNK_REFUSALS = (\{[\s\S]*?\n {2}\});/.exec(client)[1];
  const reasons = /const RESUME_REASONS = (\{[\s\S]*?\n {2}\});/.exec(client)[1];
  const failureText = new Function('MANHEIM_MAX_FILES', 'MANHEIM_MAX_MATCHES', 'window', 'MCSManheimUpload',
    `const MANHEIM_FAILURE_MESSAGES = ${messages};\nconst CHUNK_REFUSALS = ${refusals};\nconst RESUME_REASONS = ${reasons};\nreturn (${panelSnippet(client, 'manheimFailureText')});`)(20, 100000, { MCSManheimUpload: upload }, upload);
  const coded = (code, extra) => Object.assign(new Error(code), { code }, extra || {});
  for (const code of ['MANHEIM_FILES_INVALID', 'MANHEIM_READER_UNAVAILABLE', 'MANHEIM_FILE_TOO_LARGE', 'MANHEIM_FILE_READ_FAILED', 'MANHEIM_UPLOAD_INVALID', 'MANHEIM_MATCH_INVALID', 'MANHEIM_MIGRATION_PENDING', 'MANHEIM_UPLOAD_RUNNING', 'MANHEIM_BATCH_CANCELED', 'PAYLOAD_TOO_LARGE']) {
    const text = failureText(coded(code));
    assert.ok(text && !text.startsWith('Erro inesperado'), `${code} tem mensagem própria`);
  }
  assert.equal(failureText(coded('MANHEIM_CSV_COLUMNS_MISSING', { missing: ['year', 'model'] })), 'CSV incompleto: faltam year, model.');
  const interrupted = failureText(coded('MANHEIM_UPLOAD_INCOMPLETE', { fileName: 'MCS_HOJE_12.csv', chunkIndex: 3, uploadId: 'x', cause: coded('REQUEST_TIMEOUT') }));
  assert.equal(interrupted, 'Envio interrompido em MCS_HOJE_12.csv, bloco 4 (O servidor demorou para responder) · Nada foi ativado e o lote ativo não mudou · Selecione os mesmos arquivos de novo para continuar de onde parou');
  // The integrity refusals say what happened and what to do.
  for (const code of ['MANHEIM_BATCH_INCOMPLETE', 'MANHEIM_BATCH_INTEGRITY_ERROR', 'MANHEIM_BATCH_RESUME_MISMATCH']) {
    const text = failureText(coded(code, { uploadId: 'x' }));
    assert.match(text, /Nada foi ativado|não será continuado/, code);
    assert.match(text, /Descarte|descarte/, code);
    assert.doesNotMatch(text, /\.$|—/, code);
  }
  assert.match(failureText(coded('MANHEIM_BATCH_RESUME_MISMATCH', { uploadId: 'x', reason: 'TARGETS' })), /as buscas dos clientes mudaram/);
  assert.match(failureText(coded('MANHEIM_BATCH_RESUME_MISMATCH', { uploadId: 'x', reason: 'MANIFEST' })), /conteúdo lido agora é diferente/);
  const conflict = failureText(coded('MANHEIM_UPLOAD_INCOMPLETE', { fileName: 'MCS_HOJE_12.csv', chunkIndex: 3, uploadId: 'x', cause: coded('MANHEIM_CHUNK_CONFLICT') }));
  assert.equal(conflict, 'O bloco 4 de MCS_HOJE_12.csv já tinha sido recebido com outro conteúdo: os arquivos mudaram desde o primeiro envio · Nada foi gravado neste bloco, nada foi ativado e o lote ativo não mudou · Descarte este envio e selecione os arquivos de novo para começar outro lote');
  assert.match(failureText(coded('MANHEIM_UPLOAD_INCOMPLETE', { fileName: 'A.csv', chunkIndex: 0, uploadId: 'x', cause: coded('MANHEIM_CHUNK_HASH_MISMATCH') })), /não confere com o que foi declarado/);
  // Batch limit: with the counts (checked in the panel) or without them (refused by the database).
  assert.equal(failureText(coded('MANHEIM_BATCH_LIMIT', { activeFiles: 18, newFiles: 5 })), 'O lote ativo tem 18 de 20 arquivos e estes são 5 · Nada foi acrescentado e o lote ativo não mudou · Acrescente no máximo 2 arquivo(s) ou importe um lote novo pelo campo de cima');
  const limit = failureText(coded('MANHEIM_BATCH_LIMIT', { uploadId: 'x' }));
  assert.match(limit, /^O lote ativo passaria do limite de 20 arquivos ou 250\.000 carros · Nada foi acrescentado/);
  assert.doesNotMatch(limit, /Erro inesperado|\.$|—/);
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
  // Integrity: additive too. It only replaces the two signatures never used outside the tests.
  const integrity = read('supabase/migrations/20261005020000_panel_manheim_lote_integridade.sql');
  assert.doesNotMatch(integrity, /\bdrop\s+(table|column|index)\b/i);
  assert.deepEqual([...integrity.matchAll(/drop function if exists (public\.[a-z_]+)\(/g)].map((match) => match[1]), ['public.panel_manheim_batch_start', 'public.panel_manheim_batch_chunk']);
  assert.doesNotMatch(integrity, /\bdelete\s+from\b|\btruncate\b|\bupdate\s+public\.manheim_(vehicles|matches)\b/i);
  const replaced = [...integrity.matchAll(/create or replace function (public\.panel_manheim_[a-z_]+)\(/g)].map((match) => match[1]);
  const regranted = [...integrity.matchAll(/'(public\.panel_manheim_[a-z_]+)\(/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(replaced)].sort(), [...new Set(regranted)].sort());
});

'use strict';

// Executa a função real da tela (sem copiar sua implementação), com o parser e os hashes reais.
// Só a tela e a rede são simuladas: a suíte padrão também cobre o caminho antes da API.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const manheim = require('../painel/manheim');
const upload = require('../painel/manheim-upload');
const csv = require('./fixtures/manheim-csv');

const source = fs.readFileSync(path.join(__dirname, '../painel/painel.js'), 'utf8');
const start = source.indexOf('  async function complementManheim(files) {');
const end = source.indexOf('\n  function showManheimFailure(', start);
assert.ok(start >= 0 && end > start, 'função real do complemento encontrada');
const functionSource = source.slice(start, end);
const FILES = [{ name: 'COMPLEMENTO.csv', text: [
  'Inventory,Vin,Year,Make,Model,Trim,Odometer Value,MMR,Condition Report Grade,Pickup Location,Starts At,Lane,Run,Buy Now Price,Event Sale Name,Status',
  'Simulcast,2HKRW2H59LH700001,2020,Honda,CR-V,EX,21000,25000,4.1,FL - Orlando,2026-10-01T15:00:00Z,3,41,26500,Orlando Tuesday,Active'
].join('\n') + '\n' }];

async function screen({ legacy = true, confirm = true, changed = 1 } = {}) {
  const read = await csv.readFiles(FILES);
  const manifest = legacy ? read.legacy : await upload.sealPlan(read.plan, csv.sha256);
  const latest = { id: 'lote-simulado', files: manifest.files.map(file => ({ name: file.name, hash: csv.sha256(upload.canonicalJson(file)) })) };
  const status = { textContent: '', classList: { remove() {} } };
  const calls = [];
  let confirmations = 0;
  const context = vm.createContext({
    window: { MCSManheim: manheim, MCSManheimUpload: upload }, MCSManheim: manheim, MCSManheimUpload: upload,
    MAX_FILES: 20, MAX_TEXT: 25 * 1024 * 1024, SALE_KEYS: csv.SALE_KEYS, sha256: csv.sha256,
    $: () => status, manheimError: (code, details) => Object.assign(new Error(code), { code }, details),
    requestPool: null, loadCurrent: async () => {},
    askInline: async () => { confirmations += 1; return confirm; },
    request: async (url, options = {}) => {
      assert.equal(url, '/api/panel/manheim-batch');
      if (!options.method) return { latest };
      assert.equal(options.method, 'POST');
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.action === 'complement-check' || body.action === 'complement-start' || body.action === 'complement-stage') {
        assert.equal(body.uploadId, latest.id);
        assert.equal(body.clientKey, read.clientKey, 'mesma chave dos arquivos da importação, sem prefixo de acréscimo');
        assert.equal(body.manifestHash, manifest.manifestHash);
      }
      if (body.action === 'complement-check') return { received: 1, found: 1, missing: 0, changed, lane: 1, offLane: 0, incomplete: 0 };
      assert.equal(confirmations, 1, 'gravação só depois da confirmação');
      assert.equal(confirm, true);
      if (body.action === 'complement-start') return { runId: 'execucao-simulada', received: [] };
      if (body.action === 'complement-stage') return {};
      if (body.action === 'complement-apply') return { applied: true, cars: 1 };
      if (body.action === 'complement-result') return { withSale: 1, lane: 1, offLane: 0, incomplete: 0, matches: 0 };
      throw new Error('Ação inesperada: ' + body.action);
    }
  });
  vm.runInContext("'use strict'; let manheimUploadRunning = false;\n" + functionSource + '\nglobalThis.run = complementManheim; globalThis.running = () => manheimUploadRunning;', context);
  const files = FILES.map(file => ({ name: file.name, size: Buffer.byteLength(file.text), text: async () => file.text }));
  return { run: () => context.run(files), running: () => context.running(), status, calls, confirmations: () => confirmations };
}

for (const legacy of [true, false]) {
  test(`tela: complemento ${legacy ? 'do lote antigo' : 'com dados de venda'} confere, confirma e grava sem variáveis da importação`, async () => {
    const ui = await screen({ legacy });
    await ui.run();
    assert.deepEqual(ui.calls.map(call => call.action), ['complement-check', 'complement-start', 'complement-stage', 'complement-apply', 'complement-result']);
    assert.equal(ui.confirmations(), 1);
    assert.equal(ui.running(), false);
    assert.match(ui.status.textContent, /^Complemento concluído/);
  });
}

test('tela: cancelar depois da prévia não grava e libera uma nova tentativa', async () => {
  const ui = await screen({ confirm: false });
  await ui.run();
  await ui.run();
  assert.deepEqual(ui.calls.map(call => call.action), ['complement-check', 'complement-check']);
  assert.equal(ui.confirmations(), 2);
  assert.equal(ui.running(), false);
  assert.equal(ui.status.textContent, 'Complemento cancelado · Nada foi gravado');
});

test('tela: lote já complementado termina só com a prévia, sem nova confirmação ou gravação', async () => {
  const ui = await screen({ changed: 0 });
  await ui.run();
  assert.deepEqual(ui.calls.map(call => call.action), ['complement-check']);
  assert.equal(ui.confirmations(), 0);
  assert.equal(ui.running(), false);
  assert.match(ui.status.textContent, /^Nada a complementar/);
});

for (const append of [false, true]) {
  test(`tela: ${append ? 'acrescentar preserva a chave própria do lote ativo' : 'importação normal preserva a chave dos arquivos'}`, async () => {
    const read = await csv.readFiles(FILES);
    const importStart = source.indexOf('  async function importManheim(files, options) {');
    const importEnd = source.indexOf('\n  // OpenAI for ambiguous rows only.', importStart);
    assert.ok(importStart >= 0 && importEnd > importStart);
    const sent = [];
    const helper = { ...upload, sendBatch: async (input) => {
      sent.push(input);
      return { appended: input.append, uploadId: 'lote-ativo', added: 1, vehicleCount: 4, matchedVehicleCount: 0 };
    } };
    const context = vm.createContext({
      window: { MCSManheim: manheim, MCSManheimUpload: helper }, MCSManheim: manheim, MCSManheimUpload: helper,
      MAX_FILES: 20, MAX_TEXT: 25 * 1024 * 1024, sha256: csv.sha256,
      $: () => ({ textContent: '', classList: { remove() {} } }),
      manheimError: (code, details) => Object.assign(new Error(code), { code }, details),
      newAiRun: () => ({ rowsTotal: 0, rowsDeterministic: 0, rowsSentToAi: 0, review: [] }),
      resolveAmbiguousRows: async (_ai, rows) => { assert.equal(rows.length, 0); return []; },
      request: async (url, options) => {
        assert.equal(url, '/api/panel/manheim-batch');
        assert.equal(options, undefined);
        return { latest: { id: 'lote-ativo', vehicleCount: 3 } };
      },
      renderUploadProgress() {}, renderImportSummary() {}, requestPool: null, manheimData: {},
      loadCurrent: async () => {}, refreshCounters: async () => {}
    });
    vm.runInContext("'use strict'; let manheimUploadRunning = false, manheimCancelRequested = false;\n" + source.slice(importStart, importEnd) + '\nglobalThis.run = importManheim; globalThis.running = () => manheimUploadRunning;', context);
    await context.run(FILES.map(file => ({ name: file.name, size: Buffer.byteLength(file.text), text: async () => file.text })), { append });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].append, append);
    const expected = csv.sha256((append ? 'append|lote-ativo|' : '') + upload.canonicalJson(read.fileMeta.map(file => [file.name, file.size, file.contentHash]))).slice(0, 32);
    assert.equal(sent[0].clientKey, expected);
    if (append) assert.notEqual(sent[0].clientKey, read.clientKey);
    else assert.equal(sent[0].clientKey, read.clientKey);
    assert.equal(context.running(), false);
  });
}

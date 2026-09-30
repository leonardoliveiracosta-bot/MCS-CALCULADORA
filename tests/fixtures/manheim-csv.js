'use strict';

// Lê CSVs do Manheim como o painel lê (mesmo parser, mesma deduplicação, mesmos blocos e manifesto),
// para os testes montarem um lote "antigo" (sem os dados de venda, como o lote real) e simularem o
// complemento. Só para testes.
const crypto = require('node:crypto');
const manheim = require('../../painel/manheim');
const upload = require('../../painel/manheim-upload');

const SALE_KEYS = ['lane', 'run', 'saleType', 'saleStatus', 'eventSaleName'];
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const strip = (entry) => { const vehicle = { ...entry.vehicle }; SALE_KEYS.forEach((key) => { delete vehicle[key]; }); return { ...entry, vehicle }; };

// files: [{ name, text }] in the batch order.
async function readFiles(files) {
  const vehicles = [];
  const fileMeta = [];
  files.forEach((file, fileIndex) => {
    const parsed = manheim.parseCsv(file.text);
    const mapping = manheim.mapHeaders(parsed.headers);
    upload.markSearchFiltered(manheim.chooseAuctionRows(manheim.classifyRows(parsed, mapping).vehicles))
      .forEach((vehicle) => vehicles.push({ ...upload.compactVehicle(vehicle), fileIndex, raw: { Inventory: vehicle.raw && vehicle.raw.Inventory || '' }, hasBuyNow: vehicle.hasBuyNow }));
    fileMeta.push({ name: file.name, size: Buffer.byteLength(file.text), rowCount: parsed.rows.length, contentHash: sha256(file.text), headers: parsed.headers });
  });
  const deduped = upload.dedupeAcrossFiles(vehicles, manheim);
  const plan = upload.planBatch(fileMeta, deduped.vehicles, manheim);
  const legacyPlan = plan.map((file) => ({ ...file, chunks: file.chunks.map((chunk) => chunk.map(strip)) }));
  const legacy = await upload.sealPlan(legacyPlan, async (text) => sha256(text));
  const clientKey = sha256(upload.canonicalJson(fileMeta.map((file) => [file.name, file.size, file.contentHash]))).slice(0, 32);
  return { plan, legacyPlan, legacy, clientKey, fileMeta, vehicleCount: deduped.vehicles.length };
}

// The batch as the real one was imported: no sale data in the blocks.
async function importLegacy(post, files) {
  const read = await readFiles(files);
  const started = await post({ action: 'start', clientKey: read.clientKey, vehicleCount: read.vehicleCount, files: read.legacy.files, manifestHash: read.legacy.manifestHash, headers: read.fileMeta.map((file) => file.headers), headerMap: {} });
  if (![200, 201].includes(started.statusCode)) throw new Error('start ' + JSON.stringify(started.payload));
  for (let fileIndex = 0; fileIndex < read.legacyPlan.length; fileIndex += 1) {
    for (let chunkIndex = 0; chunkIndex < read.legacyPlan[fileIndex].chunks.length; chunkIndex += 1) {
      await post({ action: 'chunk', uploadId: started.payload.uploadId, fileIndex, chunkIndex, vehicles: read.legacyPlan[fileIndex].chunks[chunkIndex] });
    }
  }
  const done = await post({ action: 'finalize', uploadId: started.payload.uploadId });
  if (done.statusCode !== 200) throw new Error('finalize ' + JSON.stringify(done.payload));
  return { uploadId: started.payload.uploadId, ...read };
}

// What the browser sends for the complement: the blocks read again, with the sale data.
function complementBlocks(read, uploadId) {
  const keys = { uploadId, clientKey: read.clientKey, manifestHash: read.legacy.manifestHash };
  const blocks = [];
  read.plan.forEach((file, fileIndex) => file.chunks.forEach((vehicles, chunkIndex) => blocks.push({ fileIndex, chunkIndex, vehicles })));
  return { keys, blocks };
}

module.exports = { SALE_KEYS, complementBlocks, importLegacy, readFiles, sha256 };

(function attachManheimUpload(root, factory) {
  'use strict';
  const api = factory();
  if (root) root.MCSManheimUpload = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
}(typeof globalThis === 'object' ? globalThis : self, () => {
  'use strict';

  // Each request stays well under the server's 2 MB body limit.
  const LIMITS = Object.freeze({ maxItems: 250, maxBytes: 1500000, maxMatches: 100000, attempts: 3, retryDelayMs: 2000 });
  // Errors the server returns for data that will not change on a retry.
  const FINAL_ERRORS = new Set([
    'MANHEIM_UPLOAD_INVALID', 'MANHEIM_MATCH_INVALID', 'MANHEIM_JOURNEY_ID_INVALID', 'MANHEIM_JOURNEY_DISABLED',
    'MANHEIM_UPLOAD_NOT_FOUND', 'MANHEIM_MIGRATION_PENDING', 'PAYLOAD_TOO_LARGE', 'AUTHENTICATION_REQUIRED',
    'PANEL_ACCESS_DENIED', 'PASSWORD_CHANGE_REQUIRED', 'PANEL_NOT_CONFIGURED'
  ]);

  const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;
  const byteLength = (text) => encoder ? encoder.encode(text).length : Buffer.byteLength(text, 'utf8');

  function codedError(code, details) {
    const failure = new Error(code);
    failure.code = code;
    return Object.assign(failure, details || {});
  }

  function parsedVehicle(vehicle) {
    return {
      vin: vehicle.vin, year: vehicle.year, make: vehicle.make, makeInferred: vehicle.makeInferred, makeNotice: vehicle.makeNotice,
      model: vehicle.model, trim: vehicle.trim, miles: vehicle.miles, location: vehicle.location, locationDisplay: vehicle.locationDisplay,
      saleDate: vehicle.saleDate, startsAt: vehicle.startsAt, endsAt: vehicle.endsAt, mmrCents: vehicle.mmrCents, exteriorColor: vehicle.exteriorColor, interiorColor: vehicle.interiorColor,
      drivetrain: vehicle.drivetrain, transmission: vehicle.transmission, engine: vehicle.engine, buyNowPrice: vehicle.buyNowPrice, conditionGrade: vehicle.conditionGrade,
      lane: vehicle.lane, run: vehicle.run, saleType: vehicle.saleType, saleStatus: vehicle.saleStatus, eventSaleName: vehicle.eventSaleName,
      titleStatus: vehicle.titleStatus, odometerStatus: vehicle.odometerStatus, cleanTitle: vehicle.cleanTitle, odometerOk: vehicle.odometerOk, ...(vehicle.ai ? { ai: vehicle.ai } : {})
    };
  }

  // The Manheim saved search already filters clean title and odometer.
  function markSearchFiltered(vehicles) {
    // The saved Manheim search only brings clean titles; the odometer is only "OK" when the export
    // actually has a mileage (an unknown odometer is never shown as verified).
    return vehicles.map((vehicle) => ({ ...vehicle, cleanTitle: true, odometerOk: Number.isFinite(Number(vehicle.miles)) && vehicle.miles !== null && vehicle.miles !== '' && Number(vehicle.miles) >= 0 }));
  }

  // Each car of the CSV is checked against each demand on its own (one person in one mode),
  // never against an aggregated range. The same car can match a person's CARRO and VALOR demands
  // separately, and several people only when it passes each one's own criteria.
  // `targets` come from the server (records?view=manheim): { key, mode, targetType, journeyId,
  // ref, wishes, bidCents, reactivation }.
  function buildMatches(vehicles, targets, manheim) {
    const matches = [];
    const payloads = new Map();
    const payload = (vehicle) => {
      if (!payloads.has(vehicle)) payloads.set(vehicle, { fingerprint: manheim.fingerprint(vehicle), vehicle: { headers: vehicle.headers, raw: vehicle.raw, parsed: parsedVehicle(vehicle) } });
      return payloads.get(vehicle);
    };
    for (const target of targets || []) {
      if (!target || !['CARRO', 'VALOR'].includes(target.mode)) continue;
      const demand = { mode: target.mode, wishes: target.wishes || [], bidCents: target.mode === 'VALOR' ? target.bidCents : null };
      for (const vehicle of vehicles) {
        const result = manheim.matchDemand(vehicle, demand);
        // A ficha switched off or paused only comes back with a BATE.
        if (!result || (target.reactivation && result.kind !== 'BATE')) continue;
        const common = { mode: target.mode, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus, dataGap: result.dataGap, ...payload(vehicle) };
        matches.push(target.targetType === 'ORDER' ? { targetType: 'ORDER', calcRef: target.ref, ...common } : { journeyId: target.journeyId, ...common });
      }
    }
    return matches;
  }

  function envelope(base, uploadId, partCount) {
    return { action: 'manheim_upload_part', uploadId: uploadId || null, partIndex: partCount, partCount, ...base, matches: [] };
  }

  // Greedy split: at most maxItems per part and the whole request body below maxBytes.
  function planParts(matches, base, limits) {
    const maxItems = (limits && limits.maxItems) || LIMITS.maxItems;
    const maxBytes = (limits && limits.maxBytes) || LIMITS.maxBytes;
    const overhead = byteLength(JSON.stringify(envelope(base, '00000000-0000-4000-8000-000000000000', 999))) + 16;
    const parts = [];
    let current = [];
    let bytes = overhead;
    for (const match of matches) {
      const size = byteLength(JSON.stringify(match)) + 1;
      if (overhead + size >= maxBytes) throw codedError('MANHEIM_MATCH_TOO_LARGE');
      if (current.length && (current.length >= maxItems || bytes + size >= maxBytes)) {
        parts.push(current);
        current = [];
        bytes = overhead;
      }
      current.push(match);
      bytes += size;
    }
    if (current.length || !parts.length) parts.push(current);
    return parts;
  }

  async function sendParts(options) {
    const { parts, base, request, onProgress } = options;
    const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const attempts = options.attempts || LIMITS.attempts;
    const delay = options.retryDelayMs === undefined ? LIMITS.retryDelayMs : options.retryDelayMs;
    let uploadId = null;
    let result = null;
    let discarded = 0;
    const reasons = {};
    for (let index = 0; index < parts.length; index += 1) {
      const partIndex = index + 1;
      if (onProgress) onProgress(partIndex, parts.length);
      const body = { action: 'manheim_upload_part', uploadId, partIndex, partCount: parts.length, ...base, matches: parts[index] };
      let lastFailure = null;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          result = await request('/api/panel/actions', { method: 'POST', body: JSON.stringify(body) });
          lastFailure = null;
          break;
        } catch (failure) {
          lastFailure = failure;
          if (failure && FINAL_ERRORS.has(failure.code)) break;
          if (attempt < attempts) await wait(delay);
        }
      }
      if (lastFailure) throw codedError('MANHEIM_UPLOAD_INCOMPLETE', { partIndex, partCount: parts.length, uploadId, cause: lastFailure });
      if (!result || !result.uploadId) throw codedError('MANHEIM_UPLOAD_INCOMPLETE', { partIndex, partCount: parts.length, uploadId, cause: codedError('MANHEIM_UPLOAD_ID_MISSING') });
      uploadId = result.uploadId;
      discarded += Number(result.discarded && result.discarded.total) || 0;
      Object.entries((result.discarded && result.discarded.reasons) || {}).forEach(([reason, count]) => { reasons[reason] = (reasons[reason] || 0) + (Number(count) || 0); });
    }
    if (!result || !result.complete) throw codedError('MANHEIM_UPLOAD_INCOMPLETE', { partIndex: parts.length, partCount: parts.length, uploadId, cause: codedError('MANHEIM_UPLOAD_NOT_COMPLETE') });
    return { ...result, discardedTotal: discarded, discardedReasons: reasons };
  }

  // BATE, then POR_VALOR, then QUASE; lowest mileage first inside each.
  function sortForDisplay(matches) {
    const miles = (match) => {
      const value = Number(match && match.vehicle_json && match.vehicle_json.parsed && match.vehicle_json.parsed.miles);
      return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
    };
    return (matches || []).slice().sort((left, right) => {
      const order = (kind) => kind === 'BATE' ? 0 : kind === 'POR_VALOR' ? 1 : 2;
      const kind = order(left.match_kind) - order(right.match_kind);
      return kind || miles(left) - miles(right);
    });
  }

  // ------------------------------------------------------------ lote único em blocos
  // Todos os CSVs escolhidos juntos são UM lote. O navegador só lê e deduplica; o servidor compara
  // cada bloco com as demandas e só ativa o lote quando todos os blocos chegaram.
  const BATCH = Object.freeze({ chunkVehicles: 500, attempts: 4, retryDelayMs: 2000 });
  const BATCH_FINAL_ERRORS = new Set(['MANHEIM_BATCH_CANCELED', 'MANHEIM_UPLOAD_NOT_FOUND', 'MANHEIM_UPLOAD_INVALID', 'MANHEIM_MATCH_INVALID',
    'MANHEIM_MIGRATION_PENDING', 'PAYLOAD_TOO_LARGE', 'AUTHENTICATION_REQUIRED', 'PANEL_ACCESS_DENIED', 'PASSWORD_CHANGE_REQUIRED', 'PANEL_NOT_CONFIGURED', 'MANHEIM_BATCH_ALREADY_ACTIVE', 'MANHEIM_BATCH_INCOMPLETE',
    'MANHEIM_CHUNK_CONFLICT', 'MANHEIM_CHUNK_HASH_MISMATCH', 'MANHEIM_BATCH_RESUME_MISMATCH', 'MANHEIM_BATCH_INTEGRITY_ERROR']);
  const LOT_HEADER = /^lot\b|lot ?#|lot number|n[uú]mero do lote/i;

  // The car as it travels (parsed fields plus the auction lot); the raw row stays in the browser.
  function compactVehicle(vehicle) {
    const raw = vehicle && vehicle.raw && typeof vehicle.raw === 'object' ? vehicle.raw : {};
    const lotHeader = Object.keys(raw).find((name) => LOT_HEADER.test(name));
    return { ...parsedVehicle(vehicle), lot: lotHeader ? String(raw[lotHeader] || '').slice(0, 40) : '' };
  }
  // The same car in two files (same VIN, or the same fingerprint without VIN) is one car. The
  // simulcast row wins, as inside one file; "buy now" is kept when any copy has it. O(n).
  function dedupeAcrossFiles(vehicles, manheim) {
    const byKey = new Map();
    let duplicates = 0;
    for (const vehicle of vehicles || []) {
      const key = manheim.fingerprint(vehicle);
      const prior = byKey.get(key);
      if (!prior) { byKey.set(key, vehicle); continue; }
      duplicates += 1;
      const simulcast = (row) => /simulcast/i.test(String(row && row.raw && row.raw.Inventory || ''));
      const keep = simulcast(vehicle) && !simulcast(prior) ? { ...vehicle, fileIndex: prior.fileIndex } : prior;
      byKey.set(key, { ...keep, buyNowPrice: keep.buyNowPrice || prior.buyNowPrice || vehicle.buyNowPrice || '', hasBuyNow: Boolean(prior.hasBuyNow || vehicle.hasBuyNow || prior.buyNowPrice || vehicle.buyNowPrice) });
    }
    return { vehicles: [...byKey.values()], duplicates };
  }
  // Blocks of at most 500 cars per file, in the file order.
  function planBatch(files, vehicles, manheim, size = BATCH.chunkVehicles) {
    return files.map((file, fileIndex) => {
      const own = vehicles.filter((vehicle) => vehicle.fileIndex === fileIndex).map((vehicle) => ({ fingerprint: manheim.fingerprint(vehicle), vehicle: compactVehicle(vehicle) }));
      const chunks = [];
      for (let index = 0; index < own.length; index += size) chunks.push(own.slice(index, index + size));
      return { name: String(file.name || 'arquivo.csv').slice(0, 200), size: Number(file.size) || 0, rowCount: Number(file.rowCount) || own.length, vehicleCount: own.length, chunkCount: chunks.length, chunks };
    });
  }

  // Canonical JSON of what travels (JSON semantics, object keys sorted): the browser and the
  // server hash the same bytes for the same block, whatever the key order.
  function canonicalJson(value) {
    const plain = JSON.parse(JSON.stringify(value === undefined ? null : value));
    const walk = (node) => Array.isArray(node) ? '[' + node.map(walk).join(',') + ']'
      : node && typeof node === 'object' ? '{' + Object.keys(node).sort().map((key) => JSON.stringify(key) + ':' + walk(node[key])).join(',') + '}'
      : JSON.stringify(node);
    return walk(plain);
  }
  // The batch manifest: per file, per block, how many cars and the hash of the block content.
  // hashText: async (text) => sha256 hex.
  async function sealPlan(plan, hashText) {
    for (const file of plan) {
      file.manifestChunks = [];
      for (const chunk of file.chunks) file.manifestChunks.push({ count: chunk.length, hash: await hashText(canonicalJson(chunk)) });
    }
    const files = plan.map((file) => ({ name: file.name, size: file.size, rowCount: file.rowCount, vehicleCount: file.vehicleCount, chunkCount: file.chunkCount, chunks: file.manifestChunks }));
    return { files, manifestHash: await hashText(canonicalJson(files)) };
  }

  // Reproduce the original bytes only when checking an existing manifest. New imports always
  // keep VIN + Lane/Run; older imports used VIN alone and did not carry title/odometer text.
  async function complementPlans(files, vehicles, manheim, hashText) {
    const legacy = { fingerprint: (vehicle) => manheim.fingerprint(vehicle).replace(/:lane:.*$/, '') };
    const variants = [];
    for (const identity of [manheim, legacy]) {
      const plan = planBatch(files, dedupeAcrossFiles(vehicles, identity).vehicles, identity);
      if (identity === legacy) for (const file of plan) for (const chunk of file.chunks) for (const entry of chunk) {
        delete entry.vehicle.titleStatus; delete entry.vehicle.odometerStatus;
      }
      for (const omitSale of [true, false]) {
        const sealed = plan.map((file) => ({ ...file, chunks: file.chunks.map((chunk) => chunk.map((entry) => {
          const vehicle = { ...entry.vehicle };
          if (omitSale) for (const key of ['lane', 'run', 'saleType', 'saleStatus', 'eventSaleName']) delete vehicle[key];
          return { ...entry, vehicle };
        })) }));
        variants.push({ plan, manifest: await sealPlan(sealed, hashText) });
      }
    }
    return variants;
  }

  async function withRetry(run, options) {
    const wait = options.wait || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const attempts = options.attempts || BATCH.attempts;
    const delay = options.retryDelayMs === undefined ? BATCH.retryDelayMs : options.retryDelayMs;
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (options.canceled && options.canceled()) throw codedError('MANHEIM_BATCH_CANCELED_BY_OPERATOR');
      try { return await run(); } catch (failure) {
        last = failure;
        if (failure && BATCH_FINAL_ERRORS.has(failure.code)) break;
        if (attempt < attempts) await wait(delay * Math.pow(2, attempt - 1));
      }
    }
    throw last;
  }

  // Sends the batch. A block confirmed before (same files chosen again after a failure or a page
  // reload) is not sent again; a block sent twice never duplicates anything on the server.
  async function sendBatch(options) {
    const { plan, request, onProgress } = options;
    const post = (body) => request('/api/panel/manheim-batch', { method: 'POST', body: JSON.stringify(body), timeoutMs: options.timeoutMs || 60000 });
    const totalChunks = plan.reduce((sum, file) => sum + file.chunkCount, 0);
    const { manifest } = options;
    if (!manifest || !Array.isArray(manifest.files) || !manifest.manifestHash) throw codedError('MANHEIM_UPLOAD_INVALID');
    const started = await withRetry(() => post({ action: 'start', clientKey: options.clientKey, vehicleCount: options.vehicleCount, headers: options.headers, headerMap: options.headerMap,
      files: manifest.files, manifestHash: manifest.manifestHash, ...(options.append ? { append: true } : {}) }), options);
    const uploadId = started.uploadId;
    const received = new Set((started.received || []).map(([file, chunk]) => file + ':' + chunk));
    const totals = { storedVehicles: 0, storedMatches: 0, discarded: 0, withoutMmr: 0, resumedChunks: received.size };
    const progress = (fileIndex, chunkIndex, extra) => { if (onProgress) onProgress({ uploadId, fileIndex, chunkIndex, done: received.size, total: totalChunks, file: plan[fileIndex], ...(extra || {}) }); };
    // Blocks already confirmed before (resumed batch), per file.
    progress(null, null, { resumed: [...received].map((key) => key.split(':').map(Number)) });
    const sendChunk = async (fileIndex, chunkIndex) => {
      const answer = await withRetry(() => post({ action: 'chunk', uploadId, fileIndex, chunkIndex, vehicles: plan[fileIndex].chunks[chunkIndex] }), options)
        .catch((cause) => { throw codedError('MANHEIM_UPLOAD_INCOMPLETE', { uploadId, fileIndex, chunkIndex, fileName: plan[fileIndex].name, cause }); });
      totals.storedVehicles += Number(answer.storedVehicles) || 0; totals.storedMatches += Number(answer.storedMatches) || 0;
      totals.discarded += Number(answer.discarded) || 0; totals.withoutMmr += Number(answer.withoutMmr) || 0;
      received.add(fileIndex + ':' + chunkIndex);
      progress(fileIndex, chunkIndex);
    };
    for (let fileIndex = 0; fileIndex < plan.length; fileIndex += 1) {
      for (let chunkIndex = 0; chunkIndex < plan[fileIndex].chunkCount; chunkIndex += 1) {
        if (received.has(fileIndex + ':' + chunkIndex)) continue;
        if (options.canceled && options.canceled()) throw codedError('MANHEIM_BATCH_CANCELED_BY_OPERATOR', { uploadId });
        await sendChunk(fileIndex, chunkIndex);
      }
    }
    let result;
    // A final refusal keeps the batch id, so the operator can discard it.
    const withBatch = (failure) => { if (failure && typeof failure === 'object' && !failure.uploadId) failure.uploadId = uploadId; return failure; };
    try {
      result = await withRetry(() => post({ action: 'finalize', uploadId }), options);
    } catch (failure) {
      if (!failure || failure.code !== 'MANHEIM_BATCH_INCOMPLETE') throw withBatch(failure);
      // The server is missing a block the browser thought was sent: ask which ones and send them.
      const status = await post({ action: 'status', uploadId });
      const have = new Set((status.received || []).map(([file, chunk]) => file + ':' + chunk));
      for (let fileIndex = 0; fileIndex < plan.length; fileIndex += 1) {
        for (let chunkIndex = 0; chunkIndex < plan[fileIndex].chunkCount; chunkIndex += 1) if (!have.has(fileIndex + ':' + chunkIndex)) await sendChunk(fileIndex, chunkIndex);
      }
      result = await withRetry(() => post({ action: 'finalize', uploadId }), options).catch((again) => { throw withBatch(again); });
    }
    return { ...result, uploadId, totals };
  }

  return { BATCH, BATCH_FINAL_ERRORS, FINAL_ERRORS, LIMITS, buildMatches, byteLength, canonicalJson, codedError, compactVehicle, complementPlans, sealPlan, dedupeAcrossFiles, markSearchFiltered, parsedVehicle, planBatch, planParts, sendBatch, sendParts, sortForDisplay };
}));

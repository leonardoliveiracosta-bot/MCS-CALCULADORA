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
      cleanTitle: vehicle.cleanTitle, odometerOk: vehicle.odometerOk
    };
  }

  // The Manheim saved search already filters clean title and odometer.
  function markSearchFiltered(vehicles) {
    return vehicles.map((vehicle) => ({ ...vehicle, cleanTitle: true, odometerOk: true }));
  }

  function buildMatches(vehicles, journeys, orders, manheim) {
    const matches = [];
    const payloads = new Map();
    const payload = (vehicle) => {
      if (!payloads.has(vehicle)) payloads.set(vehicle, { fingerprint: manheim.fingerprint(vehicle), vehicle: { headers: vehicle.headers, raw: vehicle.raw, parsed: parsedVehicle(vehicle) } });
      return payloads.get(vehicle);
    };
    for (const journey of journeys || []) {
      const enabled = journey.enabled !== false;
      const reactivation = journey.reactivationEligible || journey.status === 'PARADO';
      if (!enabled && !reactivation) continue;
      for (const vehicle of vehicles) {
        // matchWishes/matchBidCents are the ficha's effective criteria (R1) computed by the server.
        const result = manheim.matchVehicle(vehicle, journey.matchWishes || journey.wishlists || journey.wishlist, journey.matchBidCents !== undefined ? journey.matchBidCents : journey.budget_cents);
        if (!result || (reactivation && result.kind !== 'BATE')) continue;
        matches.push({ journeyId: journey.id, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus, dataGap: result.dataGap, ...payload(vehicle) });
      }
    }
    // A4: a Ref linked to a ficha is already matched through the ficha.
    for (const order of (orders || []).filter((item) => item.disposition !== 'DISCARDED' && item.matchTarget !== false && !item.journeyId)) {
      for (const vehicle of vehicles) {
        const result = manheim.matchOrder(vehicle, order);
        if (!result) continue;
        matches.push({ targetType: 'ORDER', calcRef: order.ref, kind: result.kind, reason: result.reason, mmrStatus: result.mmrStatus, dataGap: result.dataGap, ...payload(vehicle) });
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
    }
    if (!result || !result.complete) throw codedError('MANHEIM_UPLOAD_INCOMPLETE', { partIndex: parts.length, partCount: parts.length, uploadId, cause: codedError('MANHEIM_UPLOAD_NOT_COMPLETE') });
    return { ...result, discardedTotal: discarded };
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

  return { FINAL_ERRORS, LIMITS, buildMatches, byteLength, codedError, markSearchFiltered, parsedVehicle, planParts, sendParts, sortForDisplay };
}));

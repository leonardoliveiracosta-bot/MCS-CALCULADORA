'use strict';

// Manheim import batches that were undone (undone_at) leave every operational read. The
// columns come with migration 20261001010000; until it is applied the reads keep working
// exactly as before (there is nothing undone yet), so the code can ship before the migration.
// A batch that is still being assembled (activated_at null, migration 20261005010000) is never
// read either: only a batch activated after its last block counts.
const { rows } = require('./panel-server');

const cache = new Map();
const batchCache = new Map();
const RETRY_MS = 60 * 1000;

// The caller passes its own reader ({ rows } or { allRows } of its panel-server module), so this
// module never reaches the database behind the caller's back (unit tests mock that module).
function readerFor(services) {
  if (services && typeof services.rows === 'function') return services.rows;
  if (services && typeof services.allRows === 'function') return (ctx, table, params) => services.allRows(ctx, table, params);
  return rows;
}

async function columnSupported(store, ctx, services, select) {
  const key = String(ctx && ctx.config && ctx.config.url || '');
  const known = store.get(key);
  if (known && (known.value || Date.now() - known.at < RETRY_MS)) return known.value;
  try {
    await readerFor(services)(ctx, 'manheim_uploads', { select, limit: '1' });
  } catch (failure) {
    // 400/42703 = column missing (migration not applied): remembered for a minute.
    if (failure && (failure.status === 400 || failure.status === 404)) { store.set(key, { value: false, at: Date.now() }); return false; }
    // Any other HTTP answer is not a verdict: fail closed instead of reading undone batches.
    if (failure && failure.status) throw failure;
    // No answer at all (network): every read that follows fails the same way.
    return false;
  }
  store.set(key, { value: true, at: Date.now() });
  return true;
}

const undoSupported = (ctx, services) => columnSupported(cache, ctx, services, 'id,undone_at');
// Single batch in blocks (migration 20261005010000).
const batchSupported = (ctx, services) => columnSupported(batchCache, ctx, services, 'id,activated_at');

// Filter for manheim_matches and manheim_vehicles (their own undo mark).
async function activeFilter(ctx, services) {
  return (await undoSupported(ctx, services)) ? { undone_at: 'is.null' } : {};
}

// Filter for manheim_uploads: not undone and already activated.
async function liveUploadFilter(ctx, services) {
  const [undo, batch] = await Promise.all([undoSupported(ctx, services), batchSupported(ctx, services).catch(() => false)]);
  return { ...(undo ? { undone_at: 'is.null' } : {}), ...(batch ? { activated_at: 'not.is.null' } : {}) };
}

// "O último upload" is the most recent batch that was not undone. Null when none is active.
async function latestActiveUpload(ctx, select = 'id', services) {
  const found = await readerFor(services)(ctx, 'manheim_uploads', { select, environment: 'eq.' + ctx.environment, ...(await liveUploadFilter(ctx, services)), order: 'uploaded_at.desc', limit: '1' });
  return found[0] || null;
}

// Every live batch inside the window (score, offers): ids only, never their cars.
async function liveUploadIds(ctx, options = {}, services) {
  const since = options.since || null;
  const found = await readerFor(services)(ctx, 'manheim_uploads', { select: 'id,uploaded_at', environment: 'eq.' + ctx.environment, ...(await liveUploadFilter(ctx, services)), ...(since ? { uploaded_at: 'gte.' + since } : {}), order: 'uploaded_at.desc', limit: '200' });
  return found.map((row) => row.id);
}

// A stored match is usable only while its batch is live (activated and not undone) and the match
// itself was not withdrawn.
async function matchIsLive(ctx, match, services) {
  if (!match || !match.upload_id || match.undone_at) return false;
  const found = await readerFor(services)(ctx, 'manheim_uploads', { select: 'id', environment: 'eq.' + ctx.environment, id: 'eq.' + match.upload_id, ...(await liveUploadFilter(ctx, services)), limit: '1' });
  return Boolean(found[0]);
}

function resetUndoSupport() { cache.clear(); batchCache.clear(); }

module.exports = { activeFilter, batchSupported, latestActiveUpload, liveUploadFilter, liveUploadIds, matchIsLive, resetUndoSupport, undoSupported };

'use strict';

// Manheim import batches that were undone (undone_at) leave every operational read. The
// columns come with migration 20261001010000; until it is applied the reads keep working
// exactly as before (there is nothing undone yet), so the code can ship before the migration.
const { rows } = require('./panel-server');

const cache = new Map();
const RETRY_MS = 60 * 1000;

async function undoSupported(ctx) {
  const key = String(ctx && ctx.config && ctx.config.url || '');
  const known = cache.get(key);
  if (known && (known.value || Date.now() - known.at < RETRY_MS)) return known.value;
  try {
    await rows(ctx, 'manheim_uploads', { select: 'id,undone_at', limit: '1' });
  } catch (failure) {
    // 400/42703 = column missing (migration not applied): remembered for a minute.
    if (failure && (failure.status === 400 || failure.status === 404)) { cache.set(key, { value: false, at: Date.now() }); return false; }
    // Any other HTTP answer is not a verdict: fail closed instead of reading undone batches.
    if (failure && failure.status) throw failure;
    // No answer at all (network): every read that follows fails the same way.
    return false;
  }
  cache.set(key, { value: true, at: Date.now() });
  return true;
}

// Filter for manheim_uploads, manheim_matches and manheim_vehicles.
async function activeFilter(ctx) {
  return (await undoSupported(ctx)) ? { undone_at: 'is.null' } : {};
}

// "O último upload" is the most recent batch that was not undone. Null when none is active.
async function latestActiveUpload(ctx, select = 'id') {
  const found = await rows(ctx, 'manheim_uploads', { select, environment: 'eq.' + ctx.environment, ...(await activeFilter(ctx)), order: 'uploaded_at.desc', limit: '1' });
  return found[0] || null;
}

function resetUndoSupport() { cache.clear(); }

module.exports = { activeFilter, latestActiveUpload, resetUndoSupport, undoSupported };

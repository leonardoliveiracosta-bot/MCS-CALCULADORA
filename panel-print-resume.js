'use strict';

// Resume SMS prints that were kept but never saved, without anyone opening a tab: a read that failed for a
// passing reason is read again, and a print that was read but not saved is saved by the same automatic
// rules the upload screen uses (Ref of a known ficha, phone of one contact). What cannot be proved stays
// where it is, with the reason, for the operator. Safe to repeat: confirm never saves the same print twice.
const { patchRows, rows } = require('./panel-server');
const smsPrint = require('./api/panel/sms-print');

const RETRY_CODES = new Set(['AI_DAILY_LIMIT', 'AI_UNAVAILABLE', 'SMS_PRINT_DAILY_LIMIT', 'SMS_PRINT_UPLOAD_NOT_FOUND']);
// A passing failure (no balance, the API down, the daily quota) never uses up the attempts: the print is read again as soon as
// the cause is gone, even days later. Only a failure that repeats for the file itself (missing upload, invalid image) counts.
const TRANSIENT_CODES = new Set(['AI_DAILY_LIMIT', 'AI_UNAVAILABLE', 'SMS_PRINT_DAILY_LIMIT']);
const MAX_ATTEMPTS = 6;
const SETTLE_MS = 2 * 60 * 1000;      // the upload screen saves a print within seconds; leave it alone until then
const BACKOFF_MS = 10 * 60 * 1000;    // between two cron tries of the same print
const STUCK_MS = 15 * 60 * 1000;      // UPLOADING/READING that never finished

function stamp(value) { const time = Date.parse(value || ''); return Number.isFinite(time) ? time : 0; }
function hasReading(read) { const values = read && read.extracted_json; return Boolean(values && typeof values === 'object' && (String(values.message || '').trim() || String(values.ref || '').trim() || String(values.phone || '').trim())); }

// Which kept prints are worth another try right now, oldest first.
function resumable(reads, now = Date.now()) {
  return (reads || []).filter((read) => {
    if (!read.created_by) return false;
    if (stamp(read.last_resume_at) && now - stamp(read.last_resume_at) < BACKOFF_MS) return false;
    const idle = now - stamp(read.updated_at || read.created_at);
    // Reading again costs a paid call, so it is capped; saving a print already read costs nothing and is
    // retried every cycle (a print confirmed later can prove the Ref of an older pending one).
    const mayRead = Number(read.resume_attempts || 0) < MAX_ATTEMPTS;
    if (read.status === 'UPLOADING' || read.status === 'READING') return mayRead && idle > STUCK_MS;
    if (read.status !== 'READY' || idle < SETTLE_MS) return false;
    if (read.error_code === 'NAME_MATCH_REVIEW') return false;
    if (read.error_code) return mayRead && RETRY_CODES.has(read.error_code);
    return hasReading(read);
  }).sort((left, right) => stamp(left.last_resume_at) - stamp(right.last_resume_at) || stamp(left.created_at) - stamp(right.created_at));
}

async function resumeOne(ctx, read, deps = smsPrint) {
  const actor = { ...ctx, panel: { id: read.created_by } };
  let record = await deps.printRecord(ctx, read.id);
  if (!record) return { id: read.id, outcome: 'GONE' };
  const needsRead = !hasReading(record) || Boolean(record.error_code);
  const touch = (extra = {}) => (deps.patchRows || patchRows)(ctx, 'sms_print_reads', { environment: 'eq.' + ctx.environment, id: 'eq.' + read.id }, { last_resume_at: new Date().toISOString(), ...extra });
  await touch();
  if (needsRead) {
    const result = await deps.readPrintRecord(actor, record);
    record = result.read;
    if (!record || record.error_code || !hasReading(record)) {
      const code = record && record.error_code || null;
      if (!code || !TRANSIENT_CODES.has(code)) await touch({ resume_attempts: Number(read.resume_attempts || 0) + 1 });
      return { id: read.id, outcome: 'UNREAD', errorCode: code };
    }
  }
  const values = record.extracted_json || {};
  let outcome = null;
  const reply = (code, payload) => { outcome = { code, payload }; return outcome; };
  await deps.confirmPrint(actor, record, { auto: true, phone: values.phone || '', name: values.name || '', ref: values.ref || '', message: values.message || '', translation: values.translation || '' }, reply);
  const saved = Boolean(outcome && outcome.code >= 200 && outcome.code < 300 && !outcome.payload.review);
  const reason = saved ? null : outcome && outcome.payload && (outcome.payload.error || (outcome.payload.review ? 'NAME_MATCH_REVIEW' : null)) || 'NOT_SAVED';
  await (deps.patchRows || patchRows)(ctx, 'sms_print_reads', { environment: 'eq.' + ctx.environment, id: 'eq.' + read.id }, { pending_reason: saved ? null : reason }).catch(() => {});
  return { id: read.id, outcome: saved ? 'SAVED' : 'PENDING', reason };
}

async function resumePrints(ctx, { max = 4, deadlineAt = Date.now() + 25000, deps } = {}) {
  const found = await rows(ctx, 'sms_print_reads', { select: 'id,status,error_code,created_by,created_at,updated_at,resume_attempts,last_resume_at,extracted_json', environment: 'eq.' + ctx.environment, status: 'in.(READY,UPLOADING,READING)', order: 'created_at.asc', limit: '200' });
  const summary = { examined: found.length, read: 0, saved: 0, pending: 0, unread: 0, failed: 0 };
  for (const read of resumable(found).slice(0, max)) {
    if (Date.now() > deadlineAt) break;
    try {
      const result = await resumeOne(ctx, read, deps);
      if (result.outcome === 'SAVED') summary.saved += 1;
      else if (result.outcome === 'PENDING') summary.pending += 1;
      else if (result.outcome === 'UNREAD') summary.unread += 1;
      summary.read += 1;
    } catch (error) { summary.failed += 1; console.error('[print-resume]', { id: read.id, message: String(error && error.message || 'UNKNOWN') }); }
  }
  return summary;
}

module.exports = { resumable, resumeOne, resumePrints, hasReading, RETRY_CODES, TRANSIENT_CODES, MAX_ATTEMPTS };

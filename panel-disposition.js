'use strict';

// A8: "Tratado" and "Descartado" belong to the person, not to the card type. A ficha and the
// calculator Refs linked to it are one person: the most recent active disposition among them wins.
const { time } = require('./panel-domain');

function refKey(value) { return String(value || '').trim().toUpperCase(); }

function dispositionIndex(dispositions) {
  const byRef = new Map(), byJourney = new Map();
  for (const row of Array.isArray(dispositions) ? dispositions : []) {
    if (!row || row.cleared_at) continue;
    if (row.item_kind === 'REF') byRef.set(refKey(row.item_key), row);
    else if (row.item_kind === 'JOURNEY') byJourney.set(String(row.item_key), row);
  }
  return function personDisposition(journeyId, refs = []) {
    const candidates = [journeyId ? byJourney.get(String(journeyId)) : null, ...(refs || []).map((ref) => byRef.get(refKey(ref)))].filter(Boolean);
    return candidates.sort((left, right) => (time(right.updated_at) || 0) - (time(left.updated_at) || 0))[0] || null;
  };
}

module.exports = { dispositionIndex, refKey };

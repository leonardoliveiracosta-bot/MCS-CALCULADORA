'use strict';

// "Veio pela vitrine": a new number that wrote through someone's V1/V2 link (a referred vitrine
// request). Read only; tolerant when the vitrine tables are absent (then nobody came by vitrine).
const { allRows } = require('./panel-server');

async function loadVitrineOrigins(ctx, read = allRows) {
  const env = 'eq.' + ctx.environment;
  const [requests, vitrines] = await Promise.all([
    read(ctx, 'vitrine_requests', { select: 'contact_id,journey_id,vitrine_id,created_at', environment: env, referred: 'eq.true', order: 'created_at.asc' }).catch(() => []),
    read(ctx, 'vitrines', { select: 'id,version', environment: env }).catch(() => [])
  ]);
  return vitrineIndex(requests || [], vitrines || []);
}

// The first referred request of a person decides V1 or V2.
function vitrineIndex(requests, vitrines) {
  const versionOf = new Map(vitrines.map((row) => [row.id, row.version === 'V2' ? 'V2' : 'V1']));
  const byContact = new Map(), byJourney = new Map();
  requests.slice().sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0)).forEach((row) => {
    const entry = { version: versionOf.get(row.vitrine_id) || 'V1', at: row.created_at || null };
    if (row.contact_id && !byContact.has(row.contact_id)) byContact.set(row.contact_id, entry);
    if (row.journey_id && !byJourney.has(row.journey_id)) byJourney.set(row.journey_id, entry);
  });
  return { forPerson: ({ journeyId = null, contactId = null } = {}) => (journeyId && byJourney.get(journeyId)) || (contactId && byContact.get(contactId)) || null };
}

module.exports = { loadVitrineOrigins, vitrineIndex };

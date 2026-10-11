'use strict';

// Local publication only: no API, subscription, web search or database call.
const fs = require('node:fs');
const path = require('node:path');
const { identity, trimLabel, mergeRows } = require('./build-vehicle-trims');
function reviewedRows(evidence) {
  if (evidence?.market !== 'US' || !Array.isArray(evidence.entries) || !evidence.entries.length) throw new Error('US reviewed evidence is required');
  const rows = [];
  for (const entry of evidence.entries) {
    let url;
    try { url = new URL(entry.url); } catch (_) { throw new Error('Source URL is required'); }
    if (entry.market !== 'US' || !identity(entry) || !Number.isInteger(entry.year) || entry.year < 1995 || entry.year > new Date().getFullYear()+1 || !/^\d{4}-\d{2}-\d{2}$/.test(entry.checked || '') || url.protocol !== 'https:' || url.username || url.password || !Array.isArray(entry.trims) || !entry.trims.length || entry.trims.some(label => trimLabel(label) !== label)) throw new Error('Invalid reviewed model-year evidence');
    for (const trim of entry.trims) rows.push({make:entry.make, model:entry.model, year:entry.year, trim});
  }
  return rows;
}
if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const evidence = JSON.parse(fs.readFileSync(path.join(root, 'docs/vehicle-trims-evidence.json'), 'utf8'));
  const catalogPath = path.join(root, 'vehicle-trims.json');
  const old = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const result = mergeRows(reviewedRows(evidence), old, 'public-manufacturer-reviewed', evidence.checked);
  fs.writeFileSync(catalogPath, JSON.stringify(result.catalog)+'\n');
  fs.writeFileSync(path.join(root, 'docs/vehicle-trims-coverage.json'), JSON.stringify(result.report,null,2)+'\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result.report).filter(([key]) => !['coverage','skipped'].includes(key)))));
}
module.exports = { reviewedRows };

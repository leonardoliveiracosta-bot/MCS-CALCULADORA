'use strict';

// Offline catalog maintenance. Input contains labels only, never whole vehicles.
const fs = require('node:fs');
const path = require('node:path');
const { MODELS_BY_MAKE } = require('../vehicle-catalog');
const fold = value => String(value || '').normalize('NFC').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
const MODEL_ALIASES = Object.freeze({
  'Mercedes-Benz': {'cclass':'C-Class','eclass':'E-Class','sclass':'S-Class','glaclass':'GLA','glbclass':'GLB','glcclass':'GLC','gleclass':'GLE','glsclass':'GLS','glclass':'GL-Class','mlclass':'ML-Class','mclass':'ML-Class','slclass':'SL','slkclass':'SLK','claclass':'CLA','clsclass':'CLS','mercedesamggt':'AMG GT','mercedesmaybachsclass':'Maybach S-Class'},
  MINI: {'hardtop':'Cooper Hardtop'},
  BMW: {'2series':'2 Series','3series':'3 Series','4series':'4 Series','5series':'5 Series','6series':'6 Series','7series':'7 Series','8series':'8 Series'}
});
function identity(row) {
  const make = Object.keys(MODELS_BY_MAKE).find(m => fold(m) === fold(row.make));
  if (!make) return null;
  const models = MODELS_BY_MAKE[make];
  let model = models.find(m => fold(m) === fold(row.model)) || MODEL_ALIASES[make]?.[fold(row.model)];
  // F-250/F-350 predate Super Duty: never apply the modern name before MY1999.
  if (!model && make === 'Ford' && Number(row.year) >= 1999) model = {'f250':'F-250 Super Duty','f350':'F-350 Super Duty','superdutyf250srw':'F-250 Super Duty'}[fold(row.model)];
  return models.includes(model) ? { make, model } : null;
}
function trimLabel(value) {
  if (typeof value !== 'string') return null;
  const label = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!label || label.length > 90 || /[<>\u0000-\u001f]|https?:|www\.|[A-HJ-NPR-Z0-9]{17}|\d{8}/i.test(label) || /^(n\/?a|none|null|undefined|unknown|not specified|other|suv|sedan|coupe|truck|wagon|van|hatchback|convertible|[24]d(?:\s+\w+)?)$/i.test(label)) return null;
  return label;
}
function mergeRows(rows, previous = null, source = 'mcs-import-labels', updated = new Date().toISOString().slice(0, 10)) {
  if (!Array.isArray(rows)) throw new Error('Input must be an array of year/make/model/trim labels');
  const buckets = new Map();
  const skipped = new Map();
  function add(row) {
    const id = identity(row), year = Number(row.year), label = trimLabel(row.trim);
    if (!id || !Number.isInteger(year) || year < 1995 || year > new Date().getFullYear() + 1 || !label) {
      const key = [String(row.make || ''), String(row.model || '')].join(' / ');
      skipped.set(key, (skipped.get(key) || 0) + 1); return;
    }
    const key = JSON.stringify([id.make, id.model, year]);
    if (!buckets.has(key)) buckets.set(key, new Map());
    const trims = buckets.get(key), normalized = label.toLowerCase(), found = trims.get(normalized);
    // Keep actual spelling; prefer mixed case over an uppercase duplicate only.
    if (!found || (found.label === found.label.toUpperCase() && label !== label.toUpperCase() && label !== label.toLowerCase())) trims.set(normalized, {label, sources: new Set([source])});
    else found.sources.add(source);
  }
  if (previous) {
    if (previous.schema !== 1 || previous.market !== 'US' || !previous.vehicles) throw new Error('Previous catalog is invalid');
    for (const [make, models] of Object.entries(previous.vehicles)) for (const [model, years] of Object.entries(models)) for (const [year, labels] of Object.entries(years)) for (const trim of labels) add({make, model, year, trim});
  }
  rows.forEach(add);
  const vehicles = {};
  for (const [key, trims] of [...buckets].sort(([a],[b]) => a.localeCompare(b, 'en'))) {
    const [make, model, year] = JSON.parse(key);
    vehicles[make] ||= {}; vehicles[make][model] ||= {};
    vehicles[make][model][year] = [...trims.values()].map(x => x.label).sort((a,b) => a.localeCompare(b,'en',{numeric:true}));
  }
  const coverage = Object.entries(MODELS_BY_MAKE).map(([make, models]) => ({make, models: models.length, withVersions: models.filter(m => vehicles[make]?.[m]).length, withoutVersions: models.filter(m => !vehicles[make]?.[m])}));
  return {catalog:{schema:1, market:'US', updated, sources:[...new Set([...(previous?.sources || []), source])].sort(), vehicles}, report:{supportedMakes:coverage.length, supportedModels:coverage.reduce((n,m)=>n+m.models,0), coveredMakes:coverage.filter(m=>m.withVersions).length, coveredModels:coverage.reduce((n,m)=>n+m.withVersions,0), modelYears:buckets.size, trimLabels:[...buckets.values()].reduce((n,m)=>n+m.size,0), coverage, skipped:[...skipped].map(([name,rows])=>({name,rows})).sort((a,b)=>a.name.localeCompare(b.name))}};
}
if (require.main === module) {
  const [input, output, source = 'mcs-import-labels'] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node scripts/build-vehicle-trims.js LABELS.json OUTPUT.json [SOURCE]');
  const rows = JSON.parse(fs.readFileSync(input, 'utf8'));
  const old = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : null;
  const result = mergeRows(rows, old, source);
  fs.writeFileSync(output, JSON.stringify(result.catalog) + '\n');
  fs.writeFileSync(path.join(path.dirname(output),'docs','vehicle-trims-coverage.json'), JSON.stringify(result.report,null,2) + '\n');
  console.log(JSON.stringify(Object.fromEntries(Object.entries(result.report).filter(([k]) => !['coverage','skipped'].includes(k)))));
}
module.exports = { identity, trimLabel, mergeRows };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('painel/index.html');
const sources = ['painel/painel.js', 'painel/lead.js'].map(read);
const htmlIds = new Set([...index.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
const dynamicIds = new Set(sources.flatMap((source) => [
  ...[...source.matchAll(/\.id\s*=\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
  ...[...source.matchAll(/\bid\s*:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]),
  ...[...source.matchAll(/setAttribute\(\s*['"]id['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
]));
const lookedUp = new Set(sources.flatMap((source) => [...source.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])));

test('DOM ids looked up by painel and lead exist in the document or are explicitly created', (t) => {
  t.diagnostic('ids criados dinamicamente: ' + ([...dynamicIds].sort().join(', ') || '(nenhum)'));
  const missing = [...lookedUp].filter((id) => !htmlIds.has(id) && !dynamicIds.has(id)).sort();
  assert.deepEqual(missing, []);
});

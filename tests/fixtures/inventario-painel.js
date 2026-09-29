'use strict';

// Protected panel inventory: the IDs, classes and data-* attributes that the tests and the panel
// scripts (painel.js, lead.js, action.js, manheim-upload.js, notifications.js) reference, kept only
// when the panel really defines them (index.html or markup written by those scripts).
// Run `node tests/fixtures/inventario-painel.js --write` to regenerate the frozen JSON.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const SCRIPTS = ['painel/painel.js', 'painel/lead.js', 'painel/action.js', 'painel/manheim-upload.js', 'painel/notifications.js'];
const OUTPUT = path.join(__dirname, 'inventario-painel.json');

function testFiles() {
  return fs.readdirSync(path.join(root, 'tests')).filter((name) => /\.(test|spec)\.js$/.test(name)).map((name) => 'tests/' + name);
}

const add = (set, value) => { if (value && /^[a-zA-Z][\w-]*$/.test(value)) set.add(value); };

// What a file asks for: selectors, getElementById, classList, dataset.
function referenced(source) {
  const ids = new Set(), classes = new Set(), data = new Set();
  for (const [, id] of source.matchAll(/getElementById\(\s*['"`]([\w-]+)['"`]/g)) add(ids, id);
  for (const [, id] of source.matchAll(/(?:^|[^\w$.])\$\(\s*['"`]([\w-]+)['"`]\s*\)/g)) add(ids, id);
  for (const [, , literal] of source.matchAll(/(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    if (!/[#.[]/.test(literal)) continue;
    for (const [, id] of literal.matchAll(/(?:^|[\s>+~,(:])#([a-zA-Z][\w-]*)/g)) add(ids, id);
    for (const [, cls] of literal.matchAll(/(?:^|[\s>+~,(:\w\]])\.([a-zA-Z][\w-]*)/g)) add(classes, cls);
    for (const [, attr] of literal.matchAll(/\[data-([a-z][\w-]*)/g)) add(data, attr);
  }
  for (const [, list] of source.matchAll(/classList\.(?:add|remove|toggle|contains|replace)\(([^)]*)\)/g)) {
    for (const [, cls] of list.matchAll(/['"`]([\w-]+)['"`]/g)) add(classes, cls);
  }
  for (const [, key] of source.matchAll(/\.dataset\.([a-zA-Z]\w*)/g)) add(data, key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
  return { ids, classes, data };
}

// What the panel defines: attributes in index.html and in the markup the scripts write.
function defined() {
  const sources = ['painel/index.html', ...SCRIPTS].map(read).join('\n');
  const ids = new Set(), classes = new Set(), data = new Set();
  for (const [, id] of sources.matchAll(/\bid\s*=\s*\\?["'`]([\w-]+)/g)) add(ids, id);
  for (const [, id] of sources.matchAll(/\.id\s*=\s*['"`]([\w-]+)['"`]/g)) add(ids, id);
  for (const [, id] of sources.matchAll(/\bid:\s*['"`]([\w-]+)['"`]/g)) add(ids, id);
  for (const [, value] of sources.matchAll(/\bclass(?:Name)?\s*[=:]\s*\\?["'`]([^"'`]*)/g)) {
    for (const cls of value.split(/\s+/)) add(classes, cls.replace(/\$\{.*$/, ''));
  }
  // element('div', 'a b'), e('span', 'a'), append(parent, 'div', 'a'): the class string after the tag.
  for (const [, value] of sources.matchAll(/\(\s*(?:[\w.]+\s*,\s*)?['"`][a-z][a-z0-9]*['"`]\s*,\s*['"`]([^'"`]*)['"`]/g)) {
    for (const cls of value.split(/\s+/)) add(classes, cls.replace(/\$\{.*$/, ''));
  }
  for (const [, list] of sources.matchAll(/classList\.(?:add|toggle|replace)\(([^)]*)\)/g)) {
    for (const [, cls] of list.matchAll(/['"`]([\w-]+)['"`]/g)) add(classes, cls);
  }
  for (const [, attr] of sources.matchAll(/\bdata-([a-z][\w-]*)\s*=/g)) add(data, attr);
  for (const [, key] of sources.matchAll(/\.dataset\.([a-zA-Z]\w*)\s*=/g)) add(data, key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()));
  for (const [, attr] of sources.matchAll(/setAttribute\(\s*['"`]data-([a-z][\w-]*)/g)) add(data, attr);
  return { ids, classes, data, sources };
}

function build() {
  const want = { ids: new Set(), classes: new Set(), data: new Set() };
  const users = {};
  for (const file of [...testFiles(), ...SCRIPTS]) {
    const found = referenced(read(file));
    for (const kind of Object.keys(want)) for (const value of found[kind]) {
      want[kind].add(value);
      (users[kind + ':' + value] ||= new Set()).add(file);
    }
  }
  const have = defined();
  const inventory = {};
  for (const kind of Object.keys(want)) {
    inventory[kind] = [...want[kind]].filter((value) => have[kind].has(value)).sort()
      .map((value) => ({ name: value, usedBy: [...users[kind + ':' + value]].sort() }));
  }
  // Everything the panel defines today also stays: nothing is renamed or removed.
  inventory.definedAtBase = Object.fromEntries(['ids', 'classes', 'data'].map((kind) => [kind, [...have[kind]].sort()]));
  return inventory;
}

module.exports = { build, defined, OUTPUT };

if (require.main === module) {
  const inventory = build();
  const summary = Object.fromEntries(['ids', 'classes', 'data'].map((kind) => [kind, inventory[kind].length + ' protegidos, ' + inventory.definedAtBase[kind].length + ' definidos']));
  if (process.argv.includes('--write')) fs.writeFileSync(OUTPUT, JSON.stringify(inventory, null, 1) + '\n');
  console.log(JSON.stringify(summary));
}

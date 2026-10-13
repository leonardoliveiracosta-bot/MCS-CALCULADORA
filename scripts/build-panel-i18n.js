'use strict';
// Gera painel/i18n-en.js e painel/i18n-es.js a partir de scripts/panel-i18n.json ({ lit: {pt: [en, es]}, tpl: [[pt, en, es]] }).
// Uso: node scripts/build-panel-i18n.js
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const source = JSON.parse(fs.readFileSync(path.join(__dirname, 'panel-i18n.json'), 'utf8'));
const holes = (text) => (String(text).match(/\{\d+\}/g) || []).sort().join(',');

function build(index, code) {
  const lit = {};
  for (const [pt, row] of Object.entries(source.lit)) {
    const value = row[index];
    if (value && value !== pt) lit[pt] = index === 0 ? [value] : [null, value];
  }
  const tpl = [];
  for (const row of source.tpl) {
    const value = row[1 + index];
    if (!value || value === row[0] || holes(value) !== holes(row[0])) continue;
    tpl.push(index === 0 ? [row[0], value] : [row[0], null, value]);
  }
  const body = `// Gerado por scripts/build-panel-i18n.js · não editar à mão\nwindow.MCSI18N && window.MCSI18N.start && window.MCSI18N.start(${JSON.stringify({ lit, tpl })});\n`;
  fs.writeFileSync(path.join(ROOT, 'painel', `i18n-${code}.js`), body);
  return { literals: Object.keys(lit).length, templates: tpl.length };
}

if (require.main === module) {
  console.log('en', build(0, 'en'));
  console.log('es', build(1, 'es'));
}
module.exports = { build, holes };

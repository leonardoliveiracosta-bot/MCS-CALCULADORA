'use strict';
// ATENDER AGORA: a carga inicial devolve 6 posições [today, (vitrine), null, entry, triage, whatsapp].
// O #218 tirou a vitrine e passou a ler uma posição a menos: entry se perdia, a triagem recebia
// as conversas e o WhatsApp recebia a triagem ("Fora do assunto" 0, recusas e fora da MCS sumindo).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const js = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');

test('carga de ATENDER AGORA: cada lista é lida na posição em que chega', () => {
  const shape = js.match(/return \[parts\.today,([^\]]*)\];\}\);/);
  assert.ok(shape, 'a carga pelo boot devolve a lista de partes');
  const slots = ('parts.today,' + shape[1]).split(',').map((item) => item.trim());
  const read = js.match(/const \[data,([^\]]*)\]=await pending;/);
  assert.ok(read, 'a leitura da carga existe');
  const names = ('data,' + read[1]).split(',').map((item) => item.trim());
  for (const [name, part] of [['entryData', 'entryData'], ['triageData', 'parts.triage||null'], ['whatsappData', 'parts.whatsapp||null']]) {
    assert.equal(names.indexOf(name), slots.indexOf(part), `${name} é lido na posição de ${part}`);
  }
});

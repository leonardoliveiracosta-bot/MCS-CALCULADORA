'use strict';

// AUD-001 #81/#82/#83: no computador os botões abrem o WhatsApp Web; os textos de interface não podem
// dizer "WhatsApp do celular", "no aplicativo" nem usar o jargão "API".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const strings = (file) => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'painel', file), 'utf8')
    .split('\n').filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line)).join('\n');
  return [...source.matchAll(/(['`])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2]);
};

test('textos de envio pelo WhatsApp valem no celular e no computador', () => {
  for (const file of ['painel.js', 'sugestoes.js']) {
    const wrong = strings(file).filter((text) => /WhatsApp do celular|feito por você no aplicativo|WhatsApp no celular|API bloqueada/.test(text));
    assert.deepEqual(wrong, [], file);
  }
});

test('AUD-001 #84: horário do envio da V1 no fuso da Flórida, como o resto do painel', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  const line = source.split('\n').find((text) => text.includes('const clock = (iso) =>'));
  assert.ok(line && line.includes("timeZone: 'America/New_York'"), line);
  const day = source.split('\n').find((text) => text.includes('const sameDay = (iso) =>'));
  const florida = source.split('\n').find((text) => text.includes('const floridaDay = '));
  assert.ok(day && day.includes('floridaDay(') && florida && florida.includes('America/New_York'), day);
});

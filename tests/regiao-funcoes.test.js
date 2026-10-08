'use strict';

// Abertura do painel: as funções rodam ao lado do banco. O banco (Supabase) fica em us-east-2 (Ohio); a Vercel
// rodava as funções em sfo1 (São Francisco), e cada uma das ~100 leituras da abertura cruzava o país.
// cle1 (Cleveland) é a região da Vercel em us-east-2. Caminho comum: nenhuma rota, prazo ou agenda muda.
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../vercel.json');

test('funções na mesma região do banco (cle1 = us-east-2)', () => {
  assert.deepEqual(config.regions, ['cle1']);
});

test('caminho comum: rotas, prazos e agendas continuam os mesmos', () => {
  assert.equal(config.functions['api/panel/triage.js'].maxDuration, 60);
  assert.equal(config.crons.length, 4);
  assert.ok(config.rewrites.some((rule) => rule.source === '/api/panel/(.*)'));
  assert.equal(config.rewrites.at(-1).destination, '/msc-calculadora.html');
});

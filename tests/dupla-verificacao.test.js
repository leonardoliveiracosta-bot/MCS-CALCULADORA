'use strict';

// Dupla verificação (auditoria + revisão independente): cada achado corrigido tem a sua prova aqui.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const context = require('../panel-client-context');
const { consolidateCalcRuns } = require('../panel-domain');
const { undash } = require('../text-dash');
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('próxima ação: tipo indefinido não vira pergunta ao cliente; dois tipos dizem o que falta por tipo', () => {
  const owner = { who: 'CLIENTE', label: 'Cliente' };
  const none = context.nextStep({ owner, fields: context.buildFields([]), modes: [] });
  assert.match(none.action.text, /^Descobrir pela conversa se a busca é por valor \(lance máximo\) ou por carro \(ano e milhagem\) e qual é o carro$/);
  const fields = context.buildFields([{ carro: [{ kind: 'CALCULADORA', value: 'Civic' }] }]);
  const both = context.nextStep({ owner, fields, modes: ['CARRO', 'VALOR'] });
  assert.equal(both.action.text, 'Perguntar ao cliente: por carro: Anos, Milhagem · por valor: Lance máximo');
});

test('fontes divergentes em campo que o tipo não usa não travam o caso', () => {
  const owner = { who: 'CLIENTE', label: 'Cliente' };
  const fields = context.buildFields([
    { carro: [{ kind: 'CALCULADORA', value: 'Civic' }], valor: [{ kind: 'CALCULADORA', value: 'US$ 15,000' }] },
    { anos: [{ kind: 'CONVERSA_IA', value: '2018 a 2020' }, { kind: 'CALCULADORA', value: '2019 a 2021' }] }
  ]);
  const step = context.nextStep({ owner, fields, modes: ['VALOR'] });
  assert.deepEqual(step.ambiguous, [], 'anos divergentes não importam numa busca por valor');
});

test('calculadora com um só limite de ano ou milhagem mantém o lado (não vira número solto)', () => {
  const run = (dados) => ({ id: 1, created_at: '2026-10-01T00:00:00Z', dados: { sid: 's', ref: 'K7QPD', evento: 'busca', logical_mode: 'CARRO', marca: 'Audi', modelo: 'A5', ...dados } });
  const [order] = consolidateCalcRuns([run({ ano_ate: 2020, milhas_de: 20000 })]);
  assert.equal(order.yearsText, 'até 2020');
  assert.equal(order.mileageText, 'a partir de 20000');
  const [both] = consolidateCalcRuns([run({ ano_de: 2018, ano_ate: 2020, milhas_de: 20000, milhas_ate: 80000 })]);
  assert.equal(both.yearsText, '2018–2020');
});

test('travessão: uma regra só em todos os textos de IA (faixas continuam faixas)', () => {
  assert.equal(undash('Pede Camry 2018–2020, até 20,000–80,000 mi — confirmar'), 'Pede Camry 2018-2020, até 20,000-80,000 mi, confirmar');
  for (const file of ['panel-reply-suggest.js', 'panel-triage.js', 'panel-manheim-audit.js', 'api/panel/reply.js']) {
    const source = read(file);
    assert.match(source, /undash\(/, file);
    assert.doesNotMatch(source, /replace\(\/\\s\*\[(—–|\\u2014\\u2013|\\u2014)\]?\\s\*\/g, ', '\)/, file + ' ainda troca travessão por vírgula por conta própria');
  }
});

test('regra da mesa também nas leituras da IA e na Opinião da IA', () => {
  for (const file of ['panel-ai.js', 'panel-pendencias.js', 'api/panel/lead-help.js']) assert.match(read(file), /Regra da mesa: quem busca POR CARRO/, file);
  assert.match(read('panel-ai.js'), /summary, nextStep e translation sempre em português/);
  assert.match(read('panel-ai.js'), /busca:search/);
  assert.match(read('api/panel/lead-help.js'), /tipoBusca:/);
  assert.match(read('api/panel/lead-help.js'), /US\$ 7\.000 só à vista/);
  assert.match(read('painel/lead.js'), /'Falta saber: '/);
  assert.doesNotMatch(read('api/panel/reply.js'), /revendedor de carros/);
});

test('valor na conversa: milhagem não vira dinheiro e "20k" vale 20 mil', () => {
  const { deterministicCandidates } = require('../panel-ai');
  const group = (text) => ({ contact: { display_name: 'Zé' }, customerMessages: [{ body_text: text }], firstCustomer: { occurred_at_utc: '2026-10-01T00:00:00Z' } });
  const order = (dollars) => ({ ref: 'ABCDE', occurredAt: '2026-01-01T00:00:00Z', contactName: 'Outro Nome', vehicleText: 'Kia Soul', budgetCents: dollars * 100 });
  assert.deepEqual(deterministicCandidates(group('looking under 80,000 miles'), [order(80000)]), [], '80,000 miles não é US$ 80 mil');
  assert.deepEqual(deterministicCandidates(group('my budget is 20k'), [order(20000)]).map((item) => item.reasons), [['mesmo valor']]);
});

test('página do cliente: milhagem sempre no formato americano', () => {
  assert.doesNotMatch(read('v/vitrine.js'), /toLocaleString\(\)/);
});

test('estado morto "pediu contato pela calculadora" removido do contexto', () => {
  assert.equal(context.UNLINKED.CONTACTED, undefined);
  assert.doesNotMatch(read('panel-client-context.js'), /O cliente pediu contato pela calculadora/);
});

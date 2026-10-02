'use strict';

// Organização do painel: uma função por área, um caso por pessoa, pedidos sem duplicidade e
// contagens do mesmo conjunto da lista. Só dados simulados; nada é gravado nem enviado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const merge = require('../panel-request-merge');
const attend = require('../painel/atendimento');
const groups = require('../panel-groups');
const requests = require('../vehicle-requests');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const J1 = '11111111-1111-4111-8111-111111111111';
const J2 = '22222222-2222-4222-8222-222222222222';

// A ficha request from the calculator (Find One For Me) and the same request read by the AI.
const fichaG63 = { key: 'ficha:journey:' + J1 + ':CARRO', source: 'FICHA', official: true, mode: 'CARRO', searchMode: 'CARRO', state: 'COM_OPCOES', optionCount: 3, criteriaHash: 'h-ficha',
  person: { journeyId: J1, name: 'Ammy Singh Grover' }, targets: [{ mode: 'CARRO', wishes: [{ make: 'Mercedes-Benz', model: 'G63', yearMin: 2020, yearMax: 2026, minMiles: 10000, maxMiles: 60000 }], bidCents: null }] };
const readG63 = { key: 'conversa:r1', source: 'CONVERSA', searchMode: 'CARRO', state: 'FALTA_BUSCAR', criteriaHash: 'h-conversa', versions: 2, chatId: 'c1',
  person: { journeyId: J1, contactId: 'k1', name: 'Ammy Singh Grover' }, criteriaText: 'Mercedes-Benz G63 · 2020 a 2026',
  criteria: { make: 'Mercedes-Benz', model: 'G63', yearMin: 2020, yearMax: 2026, minMiles: 10000, maxMiles: 60000, location: '77386 · Spring, Texas' }, evidence: [{ at: '2026-09-30T10:00:00Z', text: 'G63 2020-2026' }] };

test('pedido da ficha e a mesma leitura da IA viram um pedido, com a leitura como evidência não confirmada', () => {
  const out = merge.present([fichaG63, readG63]);
  assert.equal(out.items.length, 1);
  assert.equal(out.merged, 1);
  const [item] = out.items;
  assert.equal(item.key, fichaG63.key, 'o identificador do pedido não muda');
  assert.equal(item.criteriaHash, 'h-ficha', 'o hash usado nas comparações não muda');
  assert.equal(item.state, 'COM_OPCOES', 'sem "falta buscar" da cópia lida da conversa');
  assert.deepEqual(item.aiEvidence.map((reading) => [reading.key, reading.confirmed, reading.versions]), [['conversa:r1', false, 2]]);
  // The input objects are never changed (the full list still feeds the comparison).
  assert.equal(fichaG63.aiEvidence, undefined);
});

test('não une casos ambíguos, critérios diferentes, outra ficha nem tipo divergente', () => {
  const other = { ...readG63, key: 'conversa:r2', criteria: { ...readG63.criteria, maxMiles: 80000 } };
  assert.equal(merge.present([fichaG63, other]).items.length, 2, 'milhagem diferente');
  const otherJourney = { ...readG63, key: 'conversa:r3', person: { ...readG63.person, journeyId: J2 } };
  assert.equal(merge.present([fichaG63, otherJourney]).items.length, 2, 'outra ficha');
  const noJourney = { ...readG63, key: 'conversa:r4', person: { contactId: 'k1', name: 'x' } };
  assert.equal(merge.present([fichaG63, noJourney]).items.length, 2, 'ficha incerta');
  const twin = { ...fichaG63, key: 'ficha:journey:' + J1 + ':CARRO#1' };
  assert.equal(merge.present([fichaG63, twin, readG63]).items.length, 3, 'dois pedidos iguais na ficha: ambíguo');
  const valor = { ...readG63, key: 'conversa:r5', searchMode: 'VALOR' };
  assert.equal(merge.present([fichaG63, valor]).items.length, 2, 'tipo divergente');
});

test('uma pessoa com pedido por valor e por carro: uma pessoa, dois pedidos, um em cada coluna', () => {
  const valor = { ...fichaG63, key: 'ficha:journey:' + J1 + ':VALOR', mode: 'VALOR', searchMode: 'VALOR', targets: [{ mode: 'VALOR', wishes: [{ make: 'BMW', model: 'X5' }], bidCents: 3000000 }] };
  const counted = merge.counts([fichaG63, valor], ['COM_OPCOES']);
  assert.equal(counted.requests, 2);
  assert.equal(counted.people, 1);
  assert.deepEqual(counted.byMode, { VALOR: 1, CARRO: 1, SEM_TIPO: 0 });
  // The client column split (same function feeds the badge and the columns).
  const client = read('painel/painel.js');
  assert.match(client, /function requestColumnsOf\(data\)/);
  assert.match(client, /count\('requests', pesquisas, \(data\) => requestColumnsOf\(data\)\.total\)/);
  assert.match(client, /setCount\('requests', split\.total\)/);
});

test('tipo desconhecido vai para revisão, nunca para "por valor" automaticamente', () => {
  // Calculator area: an unknown type is its own area, never CALC_VALOR.
  assert.equal(groups.areaOf({ group: { hasCalculator: true, calcMode: null } }), 'CALC_SEM_TIPO');
  assert.equal(groups.areaOf({ group: { hasCalculator: true, calcMode: 'VALOR' } }), 'CALC_VALOR');
  assert.equal(groups.areaOf({ group: { hasCalculator: true, calcMode: 'CARRO' } }), 'CALC_CARRO');
  assert.ok(groups.AREA_ORDER.includes('CALC_SEM_TIPO'));
  // Ficha/calculator request without a type: PRECISA_REVISAO, same key and hash.
  const api = read('api/panel/pesquisas.js');
  assert.match(api, /if \(!knownMode && described\.completeness === 'PRONTO'\) Object\.assign\(item, \{ completeness: 'PRECISA_REVISAO', searchMode: null, comparable: false/);
  assert.doesNotMatch(api, /Object\.assign\(item, \{[^}]*criteriaHash/);
  // The order icon of an unknown type is a question, not the "por valor" money icon.
  assert.match(read('painel/painel.js'), /return !modes\.length \? '❓'/);
});

test('resultado no lote separado do andamento: nada diz "Falta buscar" ao lado de opções válidas', () => {
  assert.equal(requests.RESULT_LABELS.FALTA_BUSCAR, 'AINDA NÃO COMPARADO COM O LOTE');
  assert.equal(require('../panel-search-stage').stageLabel('MISSING'), '🔍 Busca não salva no Manheim');
  for (const file of ['painel/painel.js', 'painel/lead.js', 'panel-search-stage.js', 'panel-client-context.js', 'api/panel/lead-help.js']) assert.doesNotMatch(read(file), /Falta buscar/, file);
  const client = read('painel/painel.js');
  assert.match(client, /Resultado no lote: /);
  assert.match(client, /`Andamento: \$\{item\.stageLabel\}/);
  // Candidates are never shown as valid options.
  assert.match(client, /O valor do cliente ainda não foi conferido pelo cálculo oficial: não é opção confirmada/);
});

test('ATENDIMENTO: um caso por ficha, motivos reunidos, filtros e contagem do mesmo cálculo', () => {
  const now = Date.parse('2026-10-02T15:00:00Z');
  const todayItems = [
    { kind: 'JOURNEY', id: J1, awaitingReply: true, group: { key: 'NAO_ATENDIDO', unattended: { reasonText: 'Mensagem do cliente sem resposta' } } },
    { kind: 'CALCULATOR_ORDER', id: 'ref:ABCDE', journeyId: J1, group: { key: 'ATENDIDO' } },
    { kind: 'JOURNEY', id: J2, group: { key: 'ATENDIDO' }, next_action_at: '2026-10-05T12:00:00Z' },
    { kind: 'JOURNEY', id: '33333333-3333-4333-8333-333333333333', group: { key: 'ATENDIDO' } },
    { kind: 'JOURNEY', id: '44444444-4444-4444-8444-444444444444', group: { key: 'FORA_DO_ASSUNTO' } }
  ];
  const decisions = [
    { key: 'suggestion:1', kind: 'VINCULO', journeyId: J1, label: 'Confirmar vínculo' },
    { key: 'chat:9', kind: 'REVISAR_CONVERSA', journeyId: null, label: 'Revisar conversa importada' }
  ];
  const incomplete = [{ key: 'conversa:x', journeyId: J2, lacksText: 'Falta milhagem' }, { key: 'conversa:y', journeyId: null, contactId: 'k9', lacksText: 'Falta ano' }];
  const out = attend.model({ todayItems, decisions, incomplete, now });
  const caseOf = (key) => out.cases.find((entry) => entry.key === key);
  // The order and the ficha of the same person are one case; its reasons are gathered.
  assert.equal(out.cases.filter((entry) => entry.journeyId === J1).length, 1);
  assert.equal(caseOf('ficha:' + J1).item.kind, 'JOURNEY');
  assert.deepEqual(caseOf('ficha:' + J1).reasons.map((reason) => reason.kind), ['NAO_ATENDIDO', 'VINCULO']);
  assert.equal(caseOf('ficha:' + J1).bucket, 'depende');
  // Scheduled for later, waiting for the client, off topic, a decision without a ficha, an incomplete request alone.
  assert.equal(caseOf('ficha:' + J2).bucket, 'agendado');
  assert.equal(caseOf('ficha:' + J2).requests[0].lacksText, 'Falta milhagem');
  assert.equal(caseOf('ficha:33333333-3333-4333-8333-333333333333').bucket, 'aguardando');
  assert.equal(caseOf('ficha:44444444-4444-4444-8444-444444444444').bucket, 'fora');
  assert.equal(caseOf('decisao:chat:9').bucket, 'depende');
  assert.equal(caseOf('pedido:conversa:y').bucket, 'completar');
  assert.deepEqual(out.counts, { depende: 2, completar: 1, aguardando: 1, agendado: 1, fora: 1, todos: 5 });
  // Every filter lists exactly what its number says.
  for (const bucket of ['depende', 'completar', 'aguardando', 'agendado', 'todos']) assert.equal(out.cases.filter((entry) => attend.inBucket(entry, bucket)).length, out.counts[bucket], bucket);
  // The client wrote, then the operator scheduled the next action for later: it is "agendado"
  // until the date (a message after the scheduling makes it unattended, decided by the server).
  const scheduled = attend.model({ todayItems: [{ kind: 'JOURNEY', id: J2, awaitingReply: true, group: { key: 'ATENDIDO' }, next_action_at: '2026-10-09T12:00:00Z' }], now });
  assert.equal(scheduled.cases[0].bucket, 'agendado');
  assert.equal(scheduled.counts.depende, 0);
  // A resolved conversation is not a pending case just because it stays in the history.
  const resolved = attend.model({ todayItems: [], decisions: [], incomplete: [], now });
  assert.equal(resolved.counts.depende, 0);
});

test('ATENDIMENTO: o badge e a lista usam o mesmo modelo; conversas lidas não voltam como pendência', () => {
  const client = read('painel/painel.js');
  assert.match(client, /setCount\('today', model\.counts\.depende\)/);
  assert.match(client, /const model = MCSAttend\.model\(\{ todayItems: today\.items \|\| \[\], decisions: attendDecisions\(\{ entry, triage: triageData, whatsapp: whatsappData, vitrine: vitrineData \}\), incomplete: \[\] \}\);\n      setCount\('today', model\.counts\.depende\);/);
  assert.match(client, /chat\.resolution_status !== 'RESOLVED' \|\| chat\.hasTimeUncertain/);
  const html = read('painel/index.html');
  assert.match(html, /<script src="\/painel\/atendimento\.js\?v=1" defer><\/script>/);
  assert.ok(html.indexOf('atendimento.js') < html.indexOf('/painel/painel.js'));
});

test('cada número diz o que conta; filtros e posição voltam ao fechar a ficha', () => {
  const html = read('painel/index.html'), client = read('painel/painel.js');
  for (const [view, unit] of [['today', 'casos que dependem de você'], ['requests', 'pedidos de carro'], ['searches', 'pessoas com carros no lote'], ['clients', 'pessoas no período'], ['imports', 'arquivos e prints para revisar']]) assert.match(html, new RegExp(`data-count="${view}" data-unit="${unit}"`));
  assert.match(client, /attendBucket, todayStatFilter, todayRefFilter, requestsFilter,/);
  assert.match(client, /await switchPanel\(target\.view \|\| 'today', \{ scrollY: Number\(target\.scrollY \|\| 0\) \}\);/);
  assert.match(client, /viewScroll\.set\(currentView, window\.scrollY\)/);
  assert.match(client, /button\.setAttribute\('aria-current', 'page'\)/);
  // No provisional labels left on screen.
  assert.doesNotMatch(html, /data-draft|provisório|aguardam aprovação/);
});

test('BUSCAR CARROS reúne pedidos e "Quais buscas salvar"; ENVIAR OPÇÕES fica com os carros e o envio', () => {
  const html = read('painel/index.html');
  const search = html.slice(html.indexOf('<section id="requests-panel"'), html.indexOf('<section id="imports-panel"'));
  const options = html.slice(html.indexOf('<section id="searches-panel"'), html.indexOf('<section id="manheim-panel"'));
  assert.match(search, /Por valor · Calculate My Cost[\s\S]*Por carro · Find One For Me/);
  assert.match(search, /id="buscas-valor-saved"[\s\S]*id="buscas-carro-saved"/);
  assert.doesNotMatch(options, /buscas-(valor|carro)-saved|buscas-review/);
  assert.match(options, /individual e confirmado/);
  // Equal columns on the computer; separate blocks on the phone, no horizontal scroll.
  const css = read('painel/painel.css');
  assert.match(css, /\.search-columns\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)\}/);
  assert.match(css, /@media \(max-width:820px\)\{\.buscas-columns,\.search-columns\{grid-template-columns:minmax\(0,1fr\)\}/);
  // The result button opens the options of that request directly.
  assert.match(read('painel/painel.js'), /if \(toggle && !toggle\.disabled && toggle\.textContent\.startsWith\('Ver opções'\)\) toggle\.click\(\);/);
});

test('saldo do Claude: separado da OpenAI, uso anterior desconhecido nunca aparece como zero', () => {
  const migration = read('supabase/migrations/20261015010000_claude_pre_pago_50.sql');
  assert.match(migration, /c_claude_prepaid constant numeric := 50/);
  assert.match(migration, /'priorUnknown', v_prior_calls > 0/);
  assert.doesNotMatch(migration, /\b(delete|truncate|drop)\b/i);
  const client = read('painel/painel.js');
  assert.match(client, /registrados \+ uso anterior sem custo registrado · restam no máximo/);
  assert.match(client, /com custo desconhecido \(não registrado\)/);
  const api = read('api/panel/ai-budget.js');
  assert.match(api, /priorUnknown: Boolean\(state\.priorUnknown\)/);
});

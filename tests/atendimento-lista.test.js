'use strict';

// ATENDIMENTO em tabela (aba TODOS): só visual. Uma linha por caso com Espera · Canal · Ref · Telefone · Carro ·
// Valor · Ano · Milha · Origem · Estado, a lista sempre com todos os casos e nenhuma cor nem etiqueta na linha.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MCSAttend = require('../painel/atendimento');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const html = read('painel/index.html');
const js = read('painel/painel.js');
const css = read('painel/atendimento-lista.css');

test('caminho comum: abrir a aba mostra todos os casos da fila, sem passo novo', () => {
  const now = Date.parse('2026-10-06T15:00:00Z');
  const uuid = (n) => `7e000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const items = [
    { kind: 'JOURNEY', id: uuid(1), awaitingReply: true },
    { kind: 'JOURNEY', id: uuid(2), next_action_at: new Date(now + 86400000).toISOString() },
    { kind: 'JOURNEY', id: uuid(3) },
    { kind: 'JOURNEY', id: uuid(4), group: { key: 'FORA_DO_ASSUNTO' } }
  ];
  const model = MCSAttend.model({ todayItems: items, incomplete: [{ key: 'p1', lacksText: 'falta o ano' }], now });
  const shown = model.cases.filter((entry) => MCSAttend.inBucket(entry, 'todos'));
  // depende + agendado + aguardando + completar: todos na lista; só o fora do assunto fica à parte.
  assert.equal(shown.length, 4);
  assert.equal(model.counts.todos, 4);
  // The list is fixed on "todos": a bucket saved by the old pills is never read again.
  assert.match(js, /let attendBucket = 'todos';/);
  assert.doesNotMatch(js, /localStorage\.getItem\('mcs_attend_bucket'\)/);
  assert.match(js, /\n    attendBucket = 'todos';\n/);
});

test('pílulas, Origem, Assunto e Período saíram; busca, Ordenar e Ref ficam numa linha só', () => {
  assert.doesNotMatch(html, /data-attend-bucket|id="attend-filters"|id="today-origin"|id="today-subject"|id="today-period"/);
  assert.match(html, /<div class="attend-bar"[\s\S]*id="attend-search"[\s\S]*id="today-sort"[\s\S]*id="today-ref-filters"/);
  // Ordenar: the same values as before, in the same order.
  const sort = /<select id="today-sort"[^>]*>([\s\S]*?)<\/select>/.exec(html)[1];
  assert.deepEqual([...sort.matchAll(/value="([^"]+)"/g)].map((m) => m[1]), ['ready', 'recent', 'oldest', 'ref_recent', 'value_desc', 'value_asc', 'location', 'vehicle']);
  assert.match(html, /data-today-ref="recover">Ref a recuperar/);
  // Origem/Assunto/Período are fixed on "all": a value saved before never hides anyone.
  assert.match(js, /const origin='all',period='all',subject='all';/);
  // The search only filters the loaded list (nothing goes to the server).
  assert.match(js, /const visible=query\?byStat\.filter\(\(entry\)=>attendMatches\(entry,query\)\):byStat;/);
});

test('números numa faixa fina, mesmo cálculo; "prontos para comprar" em dourado', () => {
  assert.match(js, /stat\('late24', 'sem resposta há \+24 h'/);
  assert.match(js, /stat\('hot', 'prontos para comprar'/);
  assert.match(js, /stat\('sent', 'opções enviadas'/);
  assert.match(js, /hot:\(item\)=>item\.purchaseWindow==='NOW'/);
  assert.match(css, /\.attend-num\.attend-num-hot strong \{ color: var\(--al-gold\); \}/);
  // Saldo da IA moved to Configurações e conexão (same id, same filling).
  const settings = html.slice(html.indexOf('id="settings-panel"'));
  assert.match(settings, /<details id="ai-budget"/);
  assert.doesNotMatch(html.slice(0, html.indexOf('id="settings-panel"')), /id="ai-budget"/);
  // The badge counts the list, in both places that set it.
  assert.equal((js.match(/setCount\('today', model\.counts\.todos\)/g) || []).length, 2);
});

test('linha: as 10 colunas na ordem pedida e abre o que o botão abria', () => {
  const row = js.slice(js.indexOf('function attendRow'), js.indexOf('function renderToday'));
  const order = ['attend-wait', 'attend-channel', 'attend-ref', 'attend-tel', 'attend-car', 'attend-value', 'attend-year', 'attend-miles', 'attend-origin', 'attend-state'];
  const at = order.map((cls) => cls === 'attend-wait' ? row.indexOf('attendWaitCell(') : row.search(new RegExp(`[' ]${cls}'`)));
  assert.ok(at.every((index) => index > 0), 'todas as colunas existem');
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'na ordem pedida');
  assert.match(html, /<div class="attend-head"[^>]*><span><\/span><span>Espera<\/span><span>Canal<\/span><span>Ref<\/span><span>Telefone<\/span><span>Carro<\/span><span>Valor<\/span><span>Ano<\/span><span>Milha<\/span><span>Origem<\/span><span>Estado<\/span><span><\/span><\/div>/);
  assert.match(row, /smsPrintMissing\(item\)/);
  assert.match(row, /decisionRow\(decision\.key\)/);
  // Responder opened the ficha on the conversation: the row does the same.
  assert.match(row, /replying \? \{ anchor: 'lead-conversation' \} : \{\}/);
  // Phone: WhatsApp of that number, without opening the row.
  assert.match(js, /link\.addEventListener\('click', \(event\) => \{ event\.stopPropagation\(\); if \(window\.MCSWaLink\)/);
  // No gold button on the row; "⋯" only when there is a pending decision (no arrow otherwise).
  assert.doesNotMatch(row, /today-primary|attend-chev/);
  assert.match(row, /if \(body\.childElementCount\) end\.append\(more\);/);
});

test('Origem: calculadora conhecida, Financiamento, Site ou em branco', () => {
  const origin = new Function(js.slice(js.indexOf('const attendOriginGroup'), js.indexOf('// Estado: the state')) + 'return attendOrigin;')();
  assert.equal(origin({ cardFacts: { modes: ['VALOR'] } }, { group: 'CALCULADORA' }), 'Calculate My Cost');
  assert.equal(origin({ cardFacts: { modes: ['CARRO'] } }, { group: 'CALCULADORA' }), 'Find One For Me');
  assert.equal(origin({ cardFacts: { modes: ['VALOR', 'CARRO'] } }, { group: 'CALCULADORA' }), 'Calculate My Cost · Find One For Me');
  assert.equal(origin({}, { group: 'MENSAGEM', financing: true }), 'Financiamento');
  assert.equal(origin({}, { group: 'CALCULADORA' }), 'Site');
  assert.equal(origin({}, { group: 'MENSAGEM' }), '');
  assert.equal(origin({}, { group: 'VITRINE' }), '');
  assert.equal(origin(null, null), '');
  // Older answers carry only the key ("CALCULADORA:WHATSAPP") and the calculator type in group.calcMode or logicalModes.
  assert.equal(origin({}, { key: 'CALCULADORA:WHATSAPP' }), 'Site');
  assert.equal(origin({ group: { calcMode: 'VALOR' } }, { key: 'CALCULADORA:WHATSAPP' }), 'Calculate My Cost');
  assert.equal(origin({ logicalModes: ['CARRO'] }, { key: 'CALCULADORA:SMS' }), 'Find One For Me');
  assert.equal(origin({}, { key: 'MENSAGEM:WHATSAPP' }), '');
});

test('Espera: tempo, depois o que foi marcado à mão na ficha (negrito) ou "sem resposta"; mensagens não mudam isso', () => {
  const cell = js.slice(js.indexOf('function attendWaitCell'), js.indexOf('// Origem: the calculator'));
  assert.match(cell, /element\('strong', 'attend-mark', segment\.text\)/);
  assert.match(cell, /'sem resposta' : 'Sem resposta'/);
  // Without the marks loaded (an old answer or a failed read), Espera stays as it was.
  assert.match(cell, /const marks = attendData\.contactResults;/);
  assert.match(js, /attendData\.contactResults=data\.contactResults&&typeof data\.contactResults==='object'\?data\.contactResults:null;/);
  const server = read('api/panel/today.js');
  assert.match(server, /event_type: 'like\.QUICK_\*', undone_at: 'is\.null'/);
  assert.match(server, /\n      contactResults,\n/);
});

test('visual da foto: títulos em negrito com linha embaixo, linhas cinza e branco, sem cor na linha', () => {
  assert.match(css, /\.attend-head \{[^}]*border-bottom: 2px solid[^}]*font-weight: 700; color: #171A20; \}/);
  assert.match(css, /\.attend-row:nth-of-type\(even\) \{ background: #F2F3F5; \}/);
  assert.match(css, /\.attend-row > \.attend-cell \{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.doesNotMatch(css, /attend-dot|attend-chip|decision-red|heat-/);
  assert.doesNotMatch(js.slice(js.indexOf('function attendRow'), js.indexOf('function renderToday')), /attend-dot|attend-chip|makeBadge/);
  // At most 8 rows a screen on the computer; a card per row on the phone, by width (not by a button).
  assert.match(css, /min-height: max\(52px, calc\(\(100vh - 320px\) \/ 8\)\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /content: attr\(data-label\) ": "/);
});

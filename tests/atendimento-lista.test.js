'use strict';

// ATENDIMENTO em lista (aba TODOS): só visual. Uma linha por caso, as mesmas informações do cartão,
// a lista sempre com todos os casos (as pílulas de classificação saíram) e a cor só na bolinha da espera.
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

test('linha: as mesmas informações do cartão e abre o que o botão abria', () => {
  const row = js.slice(js.indexOf('function attendRow'), js.indexOf('function renderToday'));
  for (const cls of ['attend-pick', 'attend-wait', 'attend-client', 'attend-car', 'attend-order', 'attend-place', 'attend-lacks', 'attend-end']) assert.match(row, new RegExp(cls));
  assert.match(row, /value\('Lance máximo'\), years = value\('Anos'\), miles = value\('Milhas'\)/);
  assert.match(row, /nameConflictRows\(entry\.journeyId\)/);
  assert.match(row, /item\.internalCode/);
  assert.match(row, /smsPrintMissing\(item\)/);
  assert.match(row, /decisionRow\(decision\.key\)/);
  // Responder opened the ficha on the conversation: the row does the same.
  assert.match(row, /replying \? \{ anchor: 'lead-conversation' \} : \{\}/);
  // Phone: WhatsApp of that number, without opening the row.
  assert.match(js, /link\.addEventListener\('click', \(event\) => \{ event\.stopPropagation\(\); if \(window\.MCSWaLink\)/);
  // No gold button on the row.
  assert.doesNotMatch(row, /today-primary/);
});

test('cor só na bolinha: dourada < 24 h, laranja até 7 dias, vermelha acima; sem tempo, sem bolinha', () => {
  assert.match(js, /const tone = ms < ATTEND_DAY_MS \? 'new' : ms <= 7 \* ATTEND_DAY_MS \? 'mid' : 'old';/);
  assert.match(js, /if \(wait\.tone\) \{ const dot = element\('span', 'attend-dot attend-dot-' \+ wait\.tone\)/);
  assert.match(css, /\.attend-dot-new \{ background: var\(--al-gold\); \}/);
  assert.match(css, /\.attend-dot-mid \{ background: var\(--al-orange\); \}/);
  assert.match(css, /\.attend-dot-old \{ background: var\(--al-red\); \}/);
  assert.doesNotMatch(css, /decision-red|heat-/);
  // Celular: a card per row, by width (not by a button).
  assert.match(css, /@media \(max-width: 760px\)/);
});

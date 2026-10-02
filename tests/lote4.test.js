'use strict';

// Lote 4: PEDIDOS fundido em ENTRADA e CLIENTES; código morto removido com prova.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = require('../panel-origin');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function loadWith(relative, mocks) {
  const file = path.join(root, relative); const mod = { exports: {} };
  const localRequire = (name) => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(localRequire, mod, mod.exports);
  return mod.exports;
}
const output = () => ({ code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.payload = payload; return payload; } });

test('Lote 4 · Origem, Tipo e Última atividade da ficha', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const direct = origin.clientOrigin({ source: 'WHATSAPP_DIRECT' }, [], '2026-09-28T12:00:00Z');
  assert.deepEqual(direct, { origins: ['WHATSAPP'], calculatorTypes: ['SEM_CALCULADORA'], lastActivityAt: '2026-09-28T12:00:00.000Z' });
  const both = origin.clientOrigin({ source: 'WHATSAPP_DIRECT' }, [{ logicalModes: ['CARRO', 'VALOR'], occurredAt: '2026-09-29T10:00:00Z' }], '2026-09-20T00:00:00Z');
  assert.deepEqual(both.origins, ['CALCULADORA', 'WHATSAPP']);
  assert.deepEqual(both.calculatorTypes, ['BUSCA', 'SIMULACAO']);
  // R1: a calculator simulation is not activity; only the latest real message counts.
  assert.equal(both.lastActivityAt, '2026-09-20T00:00:00.000Z');
  assert.deepEqual(origin.clientOrigin({ source: 'SMS_DIRECT' }, [], null), { origins: ['SMS'], calculatorTypes: ['SEM_CALCULADORA'], lastActivityAt: null });
  const filters = (values) => origin.matchesClientFilters(both, values, now);
  assert.equal(filters({}), true);
  assert.equal(filters({ origin: 'CALCULADORA', type: 'BUSCA', days: '30' }), true);
  assert.equal(filters({ origin: 'CALCULADORA', type: 'BUSCA', days: '7' }), false, 'a recent simulation does not bring the client into the period');
  assert.equal(filters({ origin: 'SMS' }), false);
  assert.equal(filters({ type: 'SEM_CALCULADORA' }), false);
  assert.equal(origin.matchesClientFilters(direct, { days: '7' }, now), true);
  assert.equal(origin.matchesClientFilters({ ...direct, lastActivityAt: '2026-09-01T00:00:00Z' }, { days: '7' }, now), false);
  assert.equal(origin.matchesClientFilters({ ...direct, lastActivityAt: null }, { days: '30' }, now), false);
});

test('Lote 4 · pedido da calculadora sem mensagem não é listado: nem na lista de pedidos', async () => {
  const real = require('../panel-server');
  const now = Date.now(), iso = (hours) => new Date(now - hours * 3600000).toISOString();
  const run = (id, ref, evento, hours, extra = {}) => ({ id, created_at: iso(hours), dados: { sid: 's-' + ref, ref, evento, quando: iso(hours), marca: 'BMW', modelo: 'X5', ...extra } });
  const calcRuns = [
    run('1', 'AAA22', 'simulacao', 5), run('2', 'AAA22', 'whatsapp', 4),
    run('3', 'BBB33', 'simulacao', 3),
    run('4', 'CCC44', 'simulacao', 2), run('5', 'CCC44', 'sms', 1),
    run('6', 'DDD55', 'whatsapp', 24 * 40),
    run('7', 'EEE66', 'simulacao', 6), run('8', 'EEE66', 'whatsapp', 6)
  ];
  const journeys = [{ id: uuid(1), contact_id: uuid(2), reference_code: 'CCC44', source: 'WHATSAPP_DIRECT', status: 'ATIVO', contact: { display_name: 'Com ficha' } }];
  const dispositions = [{ item_kind: 'REF', item_key: 'EEE66', status: 'TREATED', updated_at: iso(1) }];
  const server = { ...real,
    requirePanel: async () => ({ environment: 'production', panel: { id: uuid(9) }, config: { url: 'https://example.invalid', secretKey: 'x' } }),
    panelMeta: async () => ({}),
    allRows: async (_ctx, table) => table === 'calc_runs' ? calcRuns : table === 'panel_item_dispositions' ? dispositions : []
  };
  let messages = [];
  const handler = loadWith('api/panel/orders.js', {
    '../../panel-server': server,
    '../../panel-read-model': { operational: async () => ({ journeys, messages, refs: [], checklist: [], promises: [], excludedRefs: [] }) },
    '../../panel-ready': { score: () => ({ score: 0, goodHour: true }), loadScoreVehicles: async () => [] },
    '../../panel-search-stage': { decorateWithSearchStage: (item) => item, loadSearchStageIndex: async () => new Map() }
  });
  const ask = async (query) => { const res = output(); await handler({ method: 'GET', query }, res); return res; };
  // A calculator click is not contact (panel-contact.js) and the calculator never asks for a phone:
  // an order with no real message (simulated or only clicked WhatsApp/SMS) is never listed.
  const plain = await ask({ filter: 'Todos', period: 'all' });
  assert.equal(plain.code, 200);
  assert.deepEqual(plain.payload.items.filter((item) => item.kind === 'CALCULATOR').map((item) => item.ref), []);
  // A real message on the ficha that owns CCC44 makes that order (and only it) a contact.
  messages = [{ id: 'm1', journey_id: uuid(1), direction: 'CUSTOMER', source_kind: 'WHATSAPP_WEBHOOK', occurred_at_utc: iso(30) }];
  const listed = await ask({ filter: 'Todos', period: 'all' });
  assert.deepEqual(listed.payload.items.filter((item) => item.kind === 'CALCULATOR').map((item) => item.ref), ['CCC44']);
  // The old PEDIDOS list still answers (the report and #pedido/REF use the same endpoint), for an
  // order whose client really wrote and, by exact Ref, even for one that never wrote.
  const legacy = await ask({ filter: 'Todos', period: 'all', ref: 'CCC44' });
  assert.equal(legacy.code, 200);
  assert.equal(legacy.payload.items[0].ref, 'CCC44');
  const exact = await ask({ filter: 'Todos', period: 'all', ref: 'AAA22' });
  assert.equal(exact.code, 200);
  assert.equal(exact.payload.items[0]?.ref, 'AAA22');
  messages = [];
});

test('Lote 4 · ações sem consumidor respondem inválido sem ler o banco; as vivas continuam', async () => {
  const real = require('../panel-server');
  let reads = 0;
  const server = { ...real,
    requirePanel: async () => ({ environment: 'production', panel: { id: uuid(9) }, config: { url: 'https://example.invalid', secretKey: 'x' } }),
    jsonBody: async (req) => req.body,
    rows: async () => { reads += 1; return []; }, allRows: async () => { reads += 1; return []; }
  };
  const handler = loadWith('api/panel/actions.js', { '../../panel-server': server, '../../panel-read-model': { journeyExists: async () => { reads += 1; return null; }, messageForJourney: async () => null } });
  for (const action of ['suppress', 'start_search', 'checklist_evidence', 'declaration', 'fulfill_promise', 'set_status', 'close_journey', 'manheim_upload']) {
    const res = output();
    await handler({ method: 'POST', body: { action, journeyId: uuid(1) } }, res);
    assert.deepEqual([res.code, res.payload.error], [400, 'PANEL_ACTION_INVALID'], action);
  }
  assert.equal(reads, 0);
  const source = read('api/panel/actions.js');
  for (const live of ['set_disposition', 'resolve_divergence', 'link_request', 'next_action', 'toggle_journey']) assert.match(source, new RegExp(`'${live}'`));
  // The old upload in parts and the separate archive were replaced by the single batch in blocks.
  assert.match(source, /const RETIRED_MANHEIM_ACTIONS = new Set\(\['manheim_upload_part', 'manheim_archive'\]\)/);
  assert.match(read('api/panel/manheim-batch.js'), /panel_manheim_batch_chunk/);
  assert.match(read('painel/manheim-upload.js'), /action: 'chunk'/);
  assert.doesNotMatch(read('painel/manheim-upload.js') + read('painel/painel.js'), /action: ?'manheim_upload'/);
  // "declaration" (removed) is not the divergence action, which stays wired to the ficha.
  assert.match(read('api/panel/lead.js'), /'resolve_divergence'/);
  assert.match(read('painel/painel.js'), /action:'resolve_divergence'/);
});

test('Lote 4 · aba PEDIDOS saiu; CLIENTES assume as funções, a seção de pedidos sem conversa da ENTRADA saiu, links antigos preservados', () => {
  const html = read('painel/index.html'), js = read('painel/painel.js');
  assert.doesNotMatch(html, /data-view="orders"|id="orders-panel"|data-count="orders"/);
  // Orders with no message are never listed, so the ENTRADA section that showed them is gone.
  assert.doesNotMatch(html, /id="entry-orders|id="entry-simulated|data-entry-orders-period|Pediram contato, sem conversa|Só simularam|class="[^"]*entry-(orders|simulated)/);
  assert.doesNotMatch(js, /loadEntryOrders|renderEntryOrders|refreshEntryOrders|entryOrders|function orderCard\(|entry-orders|entry-simulated/);
  // Origin options come from MCSGroups.ORIGIN_OPTIONS (calculadora / mensagem / vitrine × canal).
  assert.match(html, /id="clients-origin"/);
  assert.match(js, /\['today-origin','clients-origin'\]\.forEach\(\(id\)=>MCSContactGroups\.fillOriginSelect/);
  // SIMULACAO is the calculator's mode VALOR (panel-origin.js): the label says so.
  assert.match(html, /id="clients-type"[\s\S]*value="SIMULACAO">Por valor \(calculadora\)[\s\S]*Busca[\s\S]*Sem calculadora/);
  assert.match(html, /id="clients-activity"[\s\S]*30 dias[\s\S]*90 dias[\s\S]*6 meses[\s\S]*1 ano[\s\S]*Tudo/);
  assert.match(html, /panel-origin\.js/);
  // Old links: #pedido/REF still opens the order and #pedidos still lands in ENTRADA.
  assert.match(js, /detailHash[\s\S]*#pedido\//);
  assert.match(js, /pedidos:'entry'/);
});

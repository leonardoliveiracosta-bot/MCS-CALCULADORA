'use strict';
// Ligações entre abas: o que é produzido num lugar chega aonde é usado.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { journeyBlock } = require('../panel-opt-out');
const toFicha = require('../panel-search-to-ficha');

const J = '11111111-1111-4111-8111-111111111111';
function reader(data) {
  return async (_ctx, table, query) => {
    if (table === 'journeys') return [{ id: J, contact_id: 'c1', status: data.status || 'ATIVO' }];
    if (table === 'contacts') return [{ id: 'c1', is_lead: data.isLead !== false }];
    if (table === 'journey_toggle_states') return data.off ? [{ journey_id: J, enabled: false }] : [];
    if (table === 'panel_item_dispositions') return data.discarded ? [{ status: 'DISCARDED' }] : [];
    if (table === 'message_journeys') return (data.messages || []).map((message) => ({ message_id: message.id }));
    if (table === 'messages') return (data.messages || []).filter((message) => String(query.id || '').includes(message.id));
    return [];
  };
}
const ctx = { environment: 'production' };
const at = (minutes) => new Date(Date.UTC(2026, 9, 1, 12, minutes)).toISOString();

test('V1: bloqueada para quem pediu para parar, caso encerrado/desligado, descartado ou "não é lead"', async () => {
  assert.equal(await journeyBlock(ctx, J, reader({ messages: [{ id: 'm1', direction: 'CUSTOMER', body_text: 'I want a Camry', occurred_at_utc: at(1) }] })), null);
  assert.equal((await journeyBlock(ctx, J, reader({ messages: [{ id: 'm1', direction: 'CUSTOMER', body_text: 'I want a Camry', occurred_at_utc: at(1) }, { id: 'm2', direction: 'CUSTOMER', body_text: 'STOP', occurred_at_utc: at(2) }] }))).code, 'OPT_OUT');
  // A later message from the client brings the case back (same rule as HOJE).
  assert.equal(await journeyBlock(ctx, J, reader({ messages: [{ id: 'm2', direction: 'CUSTOMER', body_text: 'STOP', occurred_at_utc: at(2) }, { id: 'm3', direction: 'CUSTOMER', body_text: 'Actually, send me options', occurred_at_utc: at(3) }] })), null);
  assert.equal((await journeyBlock(ctx, J, reader({ status: 'ENCERRADO' }))).code, 'CLOSED');
  assert.equal((await journeyBlock(ctx, J, reader({ off: true }))).code, 'OFF');
  assert.equal((await journeyBlock(ctx, J, reader({ discarded: true }))).code, 'DISCARDED');
  assert.equal((await journeyBlock(ctx, J, reader({ isLead: false }))).code, 'NOT_LEAD');
});

test('V1: o envio e a criação passam pela trava; falha na conferência não envia', () => {
  const send = fs.readFileSync(path.join(__dirname, '..', 'api', 'panel', 'v1-send.js'), 'utf8');
  assert.match(send, /journeyBlock\(ctx, vitrine\.journey_id[\s\S]*CONTACT_CHECK_UNAVAILABLE[\s\S]*V1_CONTACT_BLOCKED[\s\S]*resolveTarget/);
  const create = fs.readFileSync(path.join(__dirname, '..', 'api', 'panel', 'vitrines.js'), 'utf8');
  assert.match(create, /journeyBlock\(ctx,journey\.id[\s\S]*VITRINE_CONTACT_BLOCKED/);
});

test('PESQUISAS → ficha: só pedido completo, de uma ficha só, sem carro definido; faixa aberta no sentido literal', () => {
  const base = {
    messageLinks: [{ message_id: 'e1', journey_id: 'j1' }, { message_id: 'e2', journey_id: 'j2' }, { message_id: 'e3', journey_id: 'j3' }, { message_id: 'e4', journey_id: 'j3' }, { message_id: 'e4', journey_id: 'j4' }],
    messages: ['e1', 'e2', 'e3', 'e4'].map((id) => ({ id, direction: 'CUSTOMER' })),
    journeyById: new Map(['j1', 'j2', 'j3', 'j4'].map((id) => [id, { id, status: 'ATIVO' }])),
    demands: { byJourney: new Map([['j2', [{ key: 'journey:j2:CARRO' }]]]) }
  };
  const item = (key, evidence, extra = {}) => ({ key, source: 'CONVERSA', completeness: 'PRONTO', searchMode: 'CARRO', criteria: { make: 'Toyota', model: 'Camry', yearMin: 2019, maxMiles: 50000 }, evidence: evidence.map((id) => ({ id, at: '2026-10-01' })), ...extra });
  const { plan, skipped } = toFicha.carryPlan([
    item('a', ['e1']), item('b', ['e2']), item('c', ['e4']), item('d', ['e1'], { completeness: 'PRECISA_DETALHE' }), item('e', ['e1'], { source: 'FICHA' })
  ], base);
  assert.deepEqual(plan.map((entry) => [entry.key, entry.journeyId, entry.mode, entry.messageId]), [['a', 'j1', 'CARRO', 'e1']]);
  assert.deepEqual(skipped.map((entry) => [entry.key, entry.reason]), [['b', 'FICHA_JA_TEM_CARRO'], ['c', 'SEM_FICHA_UNICA']]);
  const wish = plan[0].wish;
  assert.deepEqual([wish.yearMin, wish.yearMax, wish.minMiles, wish.maxMiles], [2019, new Date().getUTCFullYear() + 1, 1, 50000]);
  // POR VALOR: só o carro (regra da mesa); a marca vem do modelo quando o cliente não disse.
  const valor = toFicha.wishFor({ model: 'Civic', yearMin: 2018, budgetUsd: 18000 }, 'VALOR');
  assert.deepEqual([valor.make, valor.model, valor.yearMin, valor.maxMiles], ['Honda', 'Civic', null, null]);
});

test('painel: mudança na ficha e abrir OPÇÕES atualizam OPÇÕES sem esperar o próximo CSV', () => {
  const panel = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.match(panel, /CRITERIA_WRITES = \/\^\\\/api\\\/panel\\\/\(actions\|ai-conversations\|lead\|whatsapp\|entry\|pesquisas\)/);
  assert.match(panel, /CRITERIA_WRITES\.test\(path\)\) scheduleOptionsSync\(\)/);
  assert.match(panel, /action: 'sync'/);
  assert.match(panel, /if \(view === 'searches'\)[\s\S]{0,400}scheduleOptionsSync\(500\)/);
  const options = fs.readFileSync(path.join(__dirname, '..', 'api', 'panel', 'manheim-options.js'), 'utf8');
  assert.match(options, /body\.action === 'sync'\) return send\(res, 200, await syncStaleDemands/);
});

test('PESQUISAS → ficha: dois carros do mesmo cliente vão juntos; outro tipo de busca espera', () => {
  const base = {
    messageLinks: [{ message_id: 'e1', journey_id: 'j1' }, { message_id: 'e2', journey_id: 'j1' }, { message_id: 'e3', journey_id: 'j1' }],
    messages: ['e1', 'e2', 'e3'].map((id) => ({ id, direction: 'CUSTOMER' })),
    journeyById: new Map([['j1', { id: 'j1', status: 'ATIVO' }]]),
    demands: { byJourney: new Map() }
  };
  const item = (key, evidence, criteria, mode = 'CARRO') => ({ key, source: 'CONVERSA', completeness: 'PRONTO', searchMode: mode, criteria, evidence: [{ id: evidence, at: '2026-10-0' + evidence.slice(1) }] });
  const { plan, skipped } = toFicha.carryPlan([
    item('a', 'e1', { make: 'Toyota', model: 'Camry', yearMin: 2019, yearMax: 2022, minMiles: 1, maxMiles: 50000 }),
    item('b', 'e2', { make: 'Honda', model: 'Accord', yearMin: 2018, yearMax: 2021, minMiles: 1, maxMiles: 60000 }),
    item('c', 'e3', { model: 'Civic', budgetUsd: 15000 }, 'VALOR')
  ], base);
  assert.equal(plan.length, 1);
  assert.deepEqual([plan[0].mode, plan[0].messageId, plan[0].wishes.map((wish) => wish.model)], ['CARRO', 'e2', ['Camry', 'Accord']]);
  assert.deepEqual(skipped.map((entry) => [entry.key, entry.reason]), [['c', 'OUTRO_TIPO_DE_BUSCA']]);
});

test('A4: lance máximo da busca POR VALOR em ficha sem Ref ativa a busca (nunca vira teto total)', async () => {
  const realServer = require('../panel-server');
  const root = path.join(__dirname, '..');
  const file = path.join(root, 'api/panel/actions.js'), mod = { exports: {} };
  const JID = '64000000-0000-4000-8000-000000000001';
  const journeys = new Map([[JID, { id: JID, contact_id: 'c', status: 'ATIVO', criteria_json: { mode_overrides: { VALOR: { wishlists: [{ make: 'Honda', model: 'Civic' }], wishlistOverride: true } } } }]]);
  const audits = [];
  const mocks = {
    '../../panel-server': { ...realServer, requirePanel: async () => ({ config: { url: 'x', secretKey: 'k' }, panel: { id: '64000000-0000-4000-8000-000000000009' }, environment: 'preview' }), jsonBody: async (req) => req.body,
      rows: async (_ctx, table, params) => table === 'journeys' ? [journeys.get(String(params.id).replace('eq.', ''))].filter(Boolean) : [],
      patchRows: async (_ctx, _table, filters, payload) => { const id = String(filters.id).replace('eq.', ''); journeys.set(id, { ...journeys.get(id), ...payload }); return []; },
      recordMutation: async (_ctx, input) => { audits.push(input); } },
    '../../panel-read-model': { ...require('../panel-read-model'), journeyExists: async (_ctx, id) => journeys.get(id) || null }
  };
  const req = (name) => Object.hasOwn(mocks, name) ? mocks[name] : require(name.startsWith('.') ? path.resolve(path.dirname(file), name) : name);
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  const call = async (value) => { const res = { code: 0, payload: null, setHeader() {}, status(code) { this.code = code; return this; }, json(v) { this.payload = v; return v; } }; await mod.exports({ method: 'POST', headers: {}, body: { action: 'set_mode_bid', journeyId: JID, value } }, res); return res; };
  const domain = require('../panel-domain');
  assert.deepEqual(domain.journeyDemands(journeys.get(JID), []).map((demand) => [demand.mode, demand.active]), [['VALOR', false]]);
  assert.equal((await call('US$ 500')).payload.error, 'BID_VALUE_INVALID');
  assert.equal((await call('15,000')).payload.bidCents, 1500000);
  const demand = domain.journeyDemands(journeys.get(JID), [])[0];
  assert.deepEqual([demand.mode, demand.active, demand.bidCents], ['VALOR', true, 1500000], 'a busca por valor ficou ativa');
  assert.deepEqual(journeys.get(JID).criteria_json.mode_overrides.VALOR.wishlists, [{ make: 'Honda', model: 'Civic' }], 'os carros da busca continuam');
  assert.equal(journeys.get(JID).confirmed_total_ceiling_cents, undefined, 'R2: nunca o teto total');
  assert.equal((await call('15000')).payload.unchanged, true);
  assert.deepEqual(audits.map((entry) => [entry.action, entry.before.bidCents, entry.after.bidCents]), [['SET_MODE_BID', null, 1500000]]);
});

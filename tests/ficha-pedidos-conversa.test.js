'use strict';
// A ficha mostra os mesmos pedidos de ENVIAR OPÇÕES: um pedido lido da conversa (ligado à ficha pelas
// mensagens) entra nos pedidos da ficha mesmo quando os carros da própria ficha estão vazios
// (wishlists: [], wishlistOverride: true). Mensagem de duas fichas não liga a nenhuma.
const test = require('node:test');
const assert = require('node:assert/strict');
const { forJourney } = require('../panel-request-demands');
const { journeyDemands, finalizeDemand } = require('../panel-domain');

const J = '6d200000-0000-4000-8000-000000000001', OTHER = '6d200000-0000-4000-8000-000000000002';
const M1 = '6d200000-0000-4000-8000-0000000000a1', M2 = '6d200000-0000-4000-8000-0000000000a2';
function reader(tables) {
  return async (_ctx, table, query) => {
    let list = tables[table] || [];
    if (query.journey_id) list = list.filter((row) => row.journey_id === query.journey_id.slice(3));
    if (query.request_id) { const ids = query.request_id.slice(4, -1).split(','); list = list.filter((row) => ids.includes(row.request_id)); }
    if (query.message_id) { const ids = query.message_id.slice(4, -1).split(','); list = list.filter((row) => ids.includes(row.message_id)); }
    return list;
  };
}
const journey = { id: J, reference_code: '2STJQ', criteria_json: { wishlists: [], wishlistOverride: true }, source: 'CALCULADORA' };
const criteria = { make: 'Jeep', model: 'Grand Cherokee', trim: 'Summit Reserve', yearMin: 2023, yearMax: 2027, minMiles: 1, maxMiles: 30000 };

test('pedido da conversa ligado pelas mensagens entra na ficha vazia', async () => {
  const read = reader({
    vehicle_requests: [{ id: 'r1', journey_id: null }, { id: 'r2', journey_id: null }],
    vehicle_request_versions: [
      { id: 'v1', request_id: 'r1', criteria_json: criteria, evidence_json: { model: [M1] }, needs_review: false, created_at: '2026-10-04' },
      { id: 'v2', request_id: 'r2', criteria_json: { ...criteria, model: 'Wrangler' }, evidence_json: { model: [M2] }, needs_review: false, created_at: '2026-10-04' }
    ],
    message_journeys: [{ journey_id: J, message_id: M1 }, { journey_id: J, message_id: M2 }, { journey_id: OTHER, message_id: M2 }],
    journey_declarations: []
  });
  const own = journeyDemands(journey, []);
  assert.equal(own.filter((demand) => demand.active).length, 0, 'sem os pedidos da conversa a ficha fica vazia');
  const demands = (await forJourney({ environment: 'production' }, journey, own, read)).filter((demand) => demand.active);
  assert.equal(demands.length, 1);
  assert.equal(demands[0].key, `journey:${J}:CARRO`);
  assert.deepEqual(demands[0].activeWishes.map((wish) => wish.model), ['Grand Cherokee'], 'a mensagem de duas fichas (Wrangler) não liga a nenhuma');
});

test('sem pedidos da conversa nada muda', async () => {
  const own = [finalizeDemand({ key: `journey:${J}:VALOR`, targetType: 'JOURNEY', journeyId: J, mode: 'VALOR', wishes: [{ make: 'Honda', model: 'CR-V' }], bidCents: 2000000 })];
  const read = reader({ vehicle_requests: [], vehicle_request_versions: [], message_journeys: [] });
  assert.equal(await forJourney({ environment: 'production' }, journey, own, read), own);
});

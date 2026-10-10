'use strict';
process.env.VERCEL_ENV = 'preview';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { trackingPrices, reference } = require('../tracking-prices');
const { publicResponse } = require('../vitrine-domain');
const { create } = require('../api/panel/vitrines');
const id = (n) => '51000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ctx = { environment: 'preview', panel: { id: id(1) } };
const unit = (n, details) => ({ id: id(n), details_json: details });

test('tracking uses the existing MCS markup and $10 rounding in every MMR band', async () => {
  const cases = [[500000,5630],[1000000,11000],[1500000,16200],[2000000,21200],
    [3000000,31500],[4000000,41400],[6000000,61500],[10000000,102000],[10000100,101500],
    [5550000,56890],[5510000,56480],[5020000,51460],[3590000,37160]];
  const units = cases.map(([mmr], n) => unit(n + 10, n % 2 ? { mmr_cents: mmr } : { mmrCents: mmr }));
  const prices = await trackingPrices(ctx, id(2), units, async () => { throw Error('No source lookup needed'); });
  cases.forEach(([, expected], n) => assert.equal(prices.get(id(n + 10)), expected));
  for (const cents of [null, undefined, 0, -1, NaN, Infinity]) assert.equal(reference(cents), null);
});

test('tracking uses the saved manual amount exactly once, never another customer or another car', async () => {
  const units = [unit(10, { manheim_match_id: id(20), mmrCents: 2500000 }),
    unit(11, { vin: '5YJSA1E65MF438500', logical_mode: 'CARRO', mmrCents: 5550000 }),
    unit(12, { mmrCents: null })];
  const calls = [];
  const prices = await trackingPrices(ctx, id(2), units, async (_ctx, table, query) => {
    calls.push({ table, query });
    assert.equal(query.environment, 'eq.preview');
    if (table === 'manheim_matches') {
      assert.equal(query.journey_id, 'eq.' + id(2));
      assert.ok(query.or.includes(id(20)) && query.or.includes('5YJSA1E65MF438500'));
      return [{ id: id(20), vin: '5YJSA1E65MF999999', logical_mode: 'CARRO' },
        { id: id(21), vin: '5YJSA1E65MF438500', logical_mode: 'CARRO' },
        { id: id(22), vin: '5YJSA1E65MF438500', logical_mode: 'VALOR' }];
    }
    if (table === 'manheim_option_selections') return [{ match_id: id(20), final_cents: 2677100 },
      { match_id: id(21), final_cents: 5900000 }, { match_id: id(22), final_cents: 9999900 }];
    throw Error(table);
  });
  assert.equal(prices.get(id(10)), 26770, 'same $10 customer rounding used by V1');
  assert.equal(prices.get(id(11)), 59000);
  assert.equal(prices.get(id(12)), null);
  assert.equal(calls.length, 2, 'one bounded match read and one selection read for the entire page');
});

test('tracking reuses the actual V1 snapshot, preserving its price even after a later manual edit', async () => {
  const data = {
    journeys: [{ id: id(2), contact_id: id(3), reference_code: 'AB234', budget_cents: 5000000 }],
    contacts: [{ display_name: 'Fictitious' }],
    manheim_matches: [{ id: id(20), upload_id: id(4), vehicle_json: { parsed: { year: 2021, make: 'Tesla', model: 'Model S',
      vin: '5YJSA1E65MF438500', mmrCents: 5550000, startsAt: '2099-10-14T14:00:00Z', lane: '1', run: '2' } } }],
    manheim_option_selections: [{ match_id: id(20), status: 'SELECTED', final_cents: 5900000 }]
  };
  const written = [];
  const services = { activeFilter: async () => ({}), liveUploadFilter: async () => ({}), auditGate: async () => null,
    rows: async (_ctx, table) => data[table] || [],
    insert: async (_ctx, table, payload) => { written.push({ table, payload }); return [{ id: id(30), ...payload }]; }
  };
  const created = await create(ctx, { journeyId: id(2), matchIds: [id(20)] }, services);
  assert.ok(created.token);
  const car = written.find((w) => w.table === 'vitrine_cars').payload;
  const v1 = publicResponse({ token: created.token, version: 'V1', expires_at: '2099-01-01T00:00:00Z' }, [car]);
  const prices = await trackingPrices(ctx, id(2), [unit(10, { v1_vitrine_id: id(30), manheim_match_id: id(20), mmr_cents: 5550000 })],
    async (_ctx, table) => { assert.equal(table, 'vitrine_cars', 'no recalculation after V1 presentation'); return [car]; });
  assert.equal(prices.get(id(10)), v1.cars[0].estimatedMarketReference);
  assert.equal(prices.get(id(10)), 59000);
});

test('ambiguous manual prices and failed price reads never become a guessed value or $0', async () => {
  const units = [unit(10, { vin: '5YJSA1E65MF438500', mmrCents: 5550000 })];
  const prices = await trackingPrices(ctx, id(2), units, async (_ctx, table) => table === 'manheim_matches'
    ? [{ id: id(20), vin: '5YJSA1E65MF438500' }, { id: id(21), vin: '5YJSA1E65MF438500' }]
    : [{ match_id: id(20), final_cents: 5900000 }, { match_id: id(21), final_cents: 6000000 }]);
  assert.equal(prices.get(id(10)), null);
  const missing = await trackingPrices(ctx, id(2), [unit(11, { manheim_match_id: id(99), mmrCents: 5550000 })], async () => []);
  assert.equal(missing.get(id(11)), null, 'a missing original match cannot become a guessed default price');
  await assert.rejects(trackingPrices(ctx, id(2), units, async () => { throw Error('Read failed'); }), /Read failed/);
});

test('public tracking API keeps cars, order and responses, adds only the adjusted reference, and writes nothing', async () => {
  const calls = [], data = {
    lead_tracking: [{ ref_code: 'AB234', journey_id: id(2), step: 2, updated_at: '2026-10-10T00:00:00Z' }],
    journeys: [{ id: id(2), contact_id: id(3), status: 'ATIVO' }], contacts: [{ display_name: 'Fictitious' }],
    units: [ { ...unit(10, { year: 2021, make: 'Tesla', model: 'Model S', mmrCents: 5550000 }), status: 'ACCEPTED' },
      { ...unit(11, { year: 2022, make: 'Tesla', model: 'Model S', mmrCents: 5020000 }), status: 'PRESENTED' },
      { ...unit(12, { mmrCents: 1000000 }), status: 'WITHDRAWN' } ]
  };
  let priceReadFailure = false;
  const server = { SERVER_ENVIRONMENT: 'preview', configuration: () => ({ url: 'https://example.invalid' }),
    rows: async (_ctx, table) => { calls.push(table); if (priceReadFailure && table === 'vitrine_cars') throw Error('Price read failed'); return data[table] || []; },
    send: (res, status, payload) => { res.status = status; res.payload = payload; } };
  const file = path.join(__dirname, '..', 'api/tracking.js'), mod = { exports: {} };
  const req = (name) => name === '../panel-server' ? server : name === '../panel-lead' ? { orders: async () => [] }
    : require(path.resolve(path.dirname(file), name));
  new Function('require', 'module', 'exports', fs.readFileSync(file, 'utf8'))(req, mod, mod.exports);
  const res = {};
  await mod.exports({ method: 'GET', query: { code: 'x'.repeat(32) } }, res);
  assert.equal(res.status, 200);
  assert.deepEqual(res.payload.cars.map((c) => [c.id, c.response, c.vehicle.estimatedMarketReference]), [[id(10), 'WANT', 56890], [id(11), null, 51460]]);
  assert.ok(res.payload.cars.every((c) => c.vehicle.averageAuctionValue === null));
  assert.doesNotMatch(JSON.stringify(res.payload), /mmrCents|mmr_cents|final_cents|manual_pct/);
  assert.equal(calls.includes('manheim_matches'), false);
  data.units[0].details_json.v1_vitrine_id = id(30);
  data.units[0].details_json.manheim_match_id = id(20);
  priceReadFailure = true;
  const failed = {};
  await mod.exports({ method: 'GET', query: { code: 'x'.repeat(32) } }, failed);
  assert.equal(failed.status, 500);
  assert.equal(failed.payload.error, 'TRACKING_UNAVAILABLE');
});

'use strict';

// Link de opções para o cliente (/o/<código>): todos os carros do pedido no lote ativo, sem valor, sem nome do leilão,
// VIN sem os 6 últimos, só o estado. O link é sempre o mesmo para o mesmo pedido.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const links = require('../panel-option-links');

const ctx = { environment: 'production', config: {} };
const KEY = 'journey:10fe0700-0000-4000-8000-000000000001:CARRO';
const row = (n, group, extra = {}) => ({ id: 'm' + n, offer_group: group, mmr_cents: 9800000, final_cents: 10500000, vehicle_json: { parsed: {
  year: 2024, make: 'Porsche', model: 'Taycan', trim: 'GTS', miles: 11625, vin: 'WP0AD2Y13RSA4714' + (n % 10), location: 'CA - Manheim Riverside', locationDisplay: 'Manheim Riverside, CA',
  startsAt: '2026-10-08T16:30:00Z', endsAt: '2026-10-09T06:59:59Z', mmrCents: 9800000, buyNowPrice: '$95,000', lane: '3', run: '120', ...extra } } });

test('carro para o cliente: VIN sem os 6 últimos, só o estado, nenhum valor e nenhum nome de leilão', () => {
  const car = links.publicCar(row(2, 'LANE'));
  assert.deepEqual(car, { year: 2024, make: 'Porsche', model: 'Taycan', trim: 'GTS', miles: 11625, vin: 'WP0AD2Y13RS••••••', state: 'California', sale: { kind: 'AUCTION', at: '2026-10-08T16:30:00Z' } });
  const text = JSON.stringify(car);
  for (const forbidden of ['Manheim', 'Riverside', 'SA47142', '9800000', '98000', '95,000', 'mmr', 'buyNow', 'final', 'lane', 'run']) assert.ok(!text.includes(forbidden), forbidden);
  // Buy Now / Make Offer: "available until", never the price.
  assert.deepEqual(links.publicCar(row(3, 'OFFLANE')).sale, { kind: 'AVAILABLE_UNTIL', at: '2026-10-09T06:59:59Z' });
  // A VIN that is not a real VIN is not shown at all.
  assert.equal(links.maskVin('ABC123'), null);
});

test('lista: todos os carros dos três grupos, página por página, o leilão mais próximo primeiro', async () => {
  const calls = [];
  const lane = Array.from({ length: 63 }, (_, i) => row(i, 'LANE', { startsAt: `2026-10-${String(10 + (i % 5)).padStart(2, '0')}T16:30:00Z` }));
  const fake = async (_ctx, name, args) => {
    calls.push([args.p_group, args.p_offset]);
    assert.equal(name, 'panel_manheim_offer_page');
    const source = args.p_group === 'LANE' ? lane : args.p_group === 'OFFLANE' ? [row(100, 'OFFLANE', { endsAt: '2026-10-07T20:00:00Z' })] : [];
    return source.slice(args.p_offset, args.p_offset + args.p_limit);
  };
  const cars = await links.listCars(ctx, 'u1', KEY, fake);
  assert.equal(cars.length, 64);
  assert.deepEqual(calls, [['LANE', 0], ['LANE', 50], ['OFFLANE', 0], ['INCOMPLETE', 0]]);
  assert.equal(cars[0].sale.kind, 'AVAILABLE_UNTIL');
  assert.ok(cars.every((car, i) => i === 0 || Date.parse(cars[i - 1].sale.at) <= Date.parse(car.sale.at)));
});

test('link: o mesmo pedido sempre gera o mesmo link; pedido inválido é recusado', async () => {
  const stored = [];
  const services = {
    rows: async (_ctx, table, query) => stored.filter((item) => item.demand_key === query.demand_key.slice(3)),
    insert: async (_ctx, table, payload) => { stored.push(payload); return null; }
  };
  const first = await links.linkFor(ctx, KEY, 'actor', services);
  const second = await links.linkFor(ctx, KEY, 'actor', services);
  assert.equal(first, second);
  assert.match(first, links.CODE);
  assert.equal(stored.length, 1);
  await assert.rejects(() => links.linkFor(ctx, 'journey:x:CARRO', 'actor', services), /OPTION_LINK_KEY_INVALID/);
});

test('página pública: busca encerrada ou desligada mostra "encerrada"; código desconhecido não existe', async () => {
  const services = (journey, toggle) => ({
    rows: async (_ctx, table) => table === 'panel_option_links' ? [{ demand_key: KEY }] : table === 'journeys' ? (journey ? [journey] : []) : toggle ? [toggle] : [],
    rpc: async () => [row(1, 'LANE')],
    latestActiveUpload: async () => ({ id: 'u1' })
  });
  const code = 'a'.repeat(43);
  assert.deepEqual(await links.publicView(ctx, code, services({ id: 'j', status: 'ENCERRADO' })), { closed: true, cars: [] });
  assert.deepEqual(await links.publicView(ctx, code, services({ id: 'j', status: 'ATIVO' }, { enabled: false })), { closed: true, cars: [] });
  const open = await links.publicView(ctx, code, services({ id: 'j', status: 'ATIVO' }, { enabled: true }));
  assert.equal(open.closed, false);
  // The same car in every group is listed once (one car per id).
  assert.equal(open.cars.length, 1);
  assert.equal(await links.publicView(ctx, 'curto', services({ id: 'j', status: 'ATIVO' })), null);
});

test('painel: botão "Copiar link de todas as opções" na tela Opções do cliente e no cabeçalho da ficha; a página pública não mostra preço', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'painel', 'painel.js'), 'utf8');
  assert.match(js, /const OPTIONS_LINK_TEXT = 'Copiar link de todas as opções'/);
  assert.match(js, /request\('\/api\/panel\/option-link', \{ method: 'POST', body: JSON\.stringify\(\{ key \}\) \}\)/);
  assert.match(js, /copyOptionsLink\(share, demand\.key\)/);
  assert.match(js, /optionLinkButtons: fichaOptionLinkButtons/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'o', 'options.js'), 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(page, /money|price|mmr|Manheim/i);
  const vercel = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
  assert.ok(vercel.rewrites.some((rule) => rule.source.startsWith('/o/:code') && rule.destination === '/o/index.html'));
  assert.ok(vercel.headers.some((rule) => rule.source === '/o/(.*)' && rule.headers.some((h) => h.key === 'X-Robots-Tag')));
});
